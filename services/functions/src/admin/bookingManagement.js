// functions/src/admin/bookingManagement.js
'use strict';

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const { checkUserRole } = require('./auth');

const db = admin.firestore();

/**
 * Admin-only. Marks a booking as completed to trigger payout flow.
 * Expects data: { bookingId: string, note?: string }
 */
exports.adminMarkBookingCompleted = functions.region('asia-south1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { bookingId, note } = data;
  
  if (!bookingId) {
    throw new functions.https.HttpsError('invalid-argument', 'bookingId is required.');
  }

  try {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found.');
    }

    const bookingData = bookingDoc.data();

    // Check if booking is in a completable state
    if (bookingData.status === 'completed') {
      throw new functions.https.HttpsError('already-exists', 'Booking is already marked as completed.');
    }

    if (bookingData.status !== 'confirmed') {
      throw new functions.https.HttpsError('failed-precondition', 'Only confirmed bookings can be marked as completed.');
    }

    // Phase-1 hard gate: booking cannot be completed unless 100% payment is received
    if (bookingData.paidFull !== true) {
      throw new functions.https.HttpsError('failed-precondition', 'Booking cannot be completed until full payment is received (advance + balance).');
    }

    // Update booking status
    await bookingRef.update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedBy: context.auth.uid,
      completionNote: note || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create audit log
    await db.collection('auditLogs').add({
      action: 'complete_booking',
      entityType: 'booking',
      entityId: bookingId,
      note: note || null,
      performedBy: context.auth.uid,
      performedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Trigger payout process (this would typically be handled by a separate service)
    // For now, we'll just create a payout task
    await db.collection('payoutTasks').add({
      bookingId,
      artistId: bookingData.artistId,
      clientId: bookingData.clientId,
      amount: bookingData.artistAmount || bookingData.amount,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: context.auth.uid
    });

    return { 
      success: true, 
      message: 'Booking marked as completed successfully. Payout process initiated.',
      bookingId 
    };
  } catch (error) {
    console.error('Error marking booking completed:', error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError('internal', 'Failed to mark booking completed');
  }
});

/**
 * Admin-only. Resolves disputes for bookings.
 * Expects data: { bookingId: string, resolution: 'refund_client'|'pay_artist'|'split', reason?: string }
 */
exports.adminResolveDispute = functions.region('asia-south1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { bookingId, resolution, reason } = data;
  
  if (!bookingId || !resolution) {
    throw new functions.https.HttpsError('invalid-argument', 'bookingId and resolution are required.');
  }

  if (!['refund_client', 'pay_artist', 'split'].includes(resolution)) {
    throw new functions.https.HttpsError('invalid-argument', 'resolution must be refund_client, pay_artist, or split.');
  }

  try {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found.');
    }

    const bookingData = bookingDoc.data();

    // Check if booking is in dispute
    if (bookingData.status !== 'disputed') {
      throw new functions.https.HttpsError('failed-precondition', 'Only disputed bookings can be resolved.');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const unblockPayout = resolution === 'pay_artist' || resolution === 'split';

    // Keep booking lifecycle stable: return to completed, and drive payout behavior via payoutHold.
    await bookingRef.update({
      status: 'completed',
      payoutHold: !unblockPayout,
      disputeResolution: resolution,
      disputeReason: reason || null,
      resolvedBy: context.auth.uid,
      resolvedAt: now,
      dispute: {
        status: 'resolved',
        resolution,
        note: reason || null,
        resolvedBy: context.auth.uid,
        resolvedAt: now,
      },
      updatedAt: now
    });

    // Create audit log
    await db.collection('auditLogs').add({
      action: 'resolve_dispute',
      entityType: 'booking',
      entityId: bookingId,
      resolution,
      reason: reason || null,
      performedBy: context.auth.uid,
      performedAt: now
    });

    // Handle financial resolution based on the decision
    let payoutAction = null;
    if (resolution === 'pay_artist') {
      payoutAction = 'full_payout';
    } else if (resolution === 'refund_client') {
      payoutAction = 'full_refund';
    } else if (resolution === 'split') {
      payoutAction = 'split_payment';
    }

    // Create payout task if needed
    if (payoutAction && payoutAction !== 'full_refund') {
      await db.collection('payoutTasks').add({
        bookingId,
        artistId: bookingData.artistId,
        clientId: bookingData.clientId,
        amount: bookingData.artistAmount || bookingData.amount,
        action: payoutAction,
        status: 'pending',
        createdAt: now,
        createdBy: context.auth.uid
      });
    }

    // If payout should continue, unblock staged payout plan.
    if (unblockPayout) {
      const paymentsSnap = await db.collection('payments').where('bookingId', '==', bookingId).limit(1).get();
      if (!paymentsSnap.empty) {
        await paymentsSnap.docs[0].ref.set({
          'releasePlan.stage2.status': 'scheduled',
          'releasePlan.stage2.error': admin.firestore.FieldValue.delete(),
          'releasePlan.stage2.updatedAt': now,
          updatedAt: now,
        }, { merge: true });
      }
    }

    return { 
      success: true, 
      message: `Dispute resolved with action: ${resolution}.`,
      bookingId,
      resolution,
      payoutAction 
    };
  } catch (error) {
    console.error('Error resolving dispute:', error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError('internal', 'Failed to resolve dispute');
  }
});
