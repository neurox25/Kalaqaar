// services/functions/src/bookingPolicy.js
'use strict';

const admin = require('firebase-admin');
const { regional } = require('./region');
const { hasPermission } = require('./permissions/permissionMaps');
const communicationService = require('./communicationService');
const { DISPUTE_WINDOW_HOURS } = require('./config/settlementPolicy');

try { admin.app(); } catch (_) { admin.initializeApp(); }
const db = admin.firestore();

const BOOKINGS_COLLECTION = 'bookings';
const PAYMENTS_COLLECTION = 'payments';
const CALENDAR_BLOCKS = 'calendar_blocks';
const DISPUTES_COLLECTION = 'disputes';
const CASHFREE_REFUNDS_PATH = '/api/v2/payments';

const nodeFetch = (() => {
  try { return require('node-fetch'); } catch (_) { return null; }
})();

function getFetch() {
  // eslint-disable-next-line no-undef
  if (typeof fetch === 'function') return fetch;
  return (nodeFetch && (nodeFetch.default || nodeFetch)) || null;
}

function assertAuthed(context) {
  if (!context?.auth?.uid) {
    const functions = require('firebase-functions/v1');
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
}

async function assertAdmin(context) {
  assertAuthed(context);
  const ok = await hasPermission(context.auth.uid, 'canAccessAdminPanel');
  if (!ok) {
    const functions = require('firebase-functions/v1');
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }
}

async function deleteCalendarBlocksForBooking(booking) {
  const explicitIds = Array.isArray(booking?.calendarBlockIds) ? booking.calendarBlockIds : null;
  if (explicitIds && explicitIds.length) {
    const ids = explicitIds.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 500);
    if (!ids.length) return;
    const batch = db.batch();
    for (const id of ids) batch.delete(db.collection(CALENDAR_BLOCKS).doc(id));
    await batch.commit();
    return;
  }

  // Fallback (legacy): single-day blocks computed from eventDate + assigned artists/vendors.
  const eventDate = String(booking?.eventDate || '').trim();
  if (!eventDate) return;
  const assignedArtists = Array.isArray(booking?.assignedArtistIds) ? booking.assignedArtistIds : (booking?.artistId ? [booking.artistId] : []);
  const assignedVendors = Array.isArray(booking?.assignedVendorIds) ? booking.assignedVendorIds : (booking?.vendorId ? [booking.vendorId] : []);
  const uids = [...assignedArtists, ...assignedVendors].map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
  if (!uids.length) return;

  const batch = db.batch();
  for (const uid of uids) {
    const blockId = `${uid}_${eventDate}`;
    batch.delete(db.collection(CALENDAR_BLOCKS).doc(blockId));
  }
  await batch.commit();
}

function cashfreePgBaseUrl() {
  const envRaw = process.env.CASHFREE_ENVIRONMENT || process.env.CASHFREE_ENV || '';
  const sandboxFlag = String(process.env.CASHFREE_SANDBOX || '').toLowerCase();
  const isSandbox = sandboxFlag ? (sandboxFlag === 'true' || sandboxFlag === '1') : (!envRaw || envRaw.toUpperCase() === 'SANDBOX');
  const env = envRaw ? envRaw.toUpperCase() : (isSandbox ? 'SANDBOX' : 'PRODUCTION');
  return (env === 'PRODUCTION' || env === 'LIVE' || env === 'PROD') ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
}

async function cashfreeRefundByGatewayPaymentId({ gatewayPaymentId, refundAmount, refundId, refundNote }) {
  const clientId = process.env.CASHFREE_CLIENT_ID || '';
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    const functions = require('firebase-functions/v1');
    throw new functions.https.HttpsError('failed-precondition', 'Cashfree client credentials are not configured');
  }
  const base = cashfreePgBaseUrl();
  const url = `${base}${CASHFREE_REFUNDS_PATH}/${encodeURIComponent(gatewayPaymentId)}/refunds`;
  const f = getFetch();
  if (!f) {
    const functions = require('firebase-functions/v1');
    throw new functions.https.HttpsError('failed-precondition', 'Fetch is not available in this runtime');
  }
  const res = await f(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-client-secret': clientSecret,
    },
    body: JSON.stringify({
      refund_amount: String(refundAmount),
      refund_id: refundId,
      refund_note: refundNote || 'Refund initiated by Kalaqaar',
    }),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const functions = require('firebase-functions/v1');
    throw new functions.https.HttpsError('internal', `Cashfree refund failed (${res.status})`);
  }
  return data;
}

/**
 * Client/admin cancellation policy:
 * - If advance NOT paid: cancel allowed, ₹0 charged.
 * - If advance paid: only admin can cancel (refund/hold policy handled by admin flow).
 */
exports.cancelBookingV1 = regional()
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onCall(async (data, context) => {
    assertAuthed(context);
    const uid = context.auth.uid;

    const bookingId = String(data?.bookingId || '').trim();
    const reason = (data?.reason ? String(data.reason).trim() : '') || null;
    if (!bookingId) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('invalid-argument', 'bookingId is required');
    }

    const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }
    const b = snap.data() || {};

    const isAdmin = await hasPermission(uid, 'canAccessAdminPanel');
    const isClient = b.clientId === uid;
    if (!isAdmin && !isClient) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('permission-denied', 'Not allowed');
    }

    if (String(b.status || '').toLowerCase() === 'completed') {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Cannot cancel a completed booking');
    }

    if (b.advancePaid === true) {
      // Advance-paid cancellation has refund rules; enforce admin-only so ops can confirm policy.
      if (!isAdmin) {
        const functions = require('firebase-functions/v1');
        throw new functions.https.HttpsError('failed-precondition', 'Contact Kalaqaar support to cancel after advance payment');
      }
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    await bookingRef.set({
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: uid,
      cancelReason: reason,
      updatedAt: now,
    }, { merge: true });

    // Release any calendar blocks
    try { await deleteCalendarBlocksForBooking(b); } catch (_) {}

    return { ok: true, bookingId, status: 'cancelled' };
  });

/**
 * V1 admin cancellation after advance paid (before T-2):
 * - Hold 25% of advance (includes GST proportionally).
 * - Refund remaining advance amount via Cashfree.
 * - Mark booking cancelled and release calendar blocks.
 */
exports.adminCancelAfterAdvanceV1 = regional()
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onCall(async (data, context) => {
    await assertAdmin(context);

    const bookingId = String(data?.bookingId || '').trim();
    const reason = (data?.reason ? String(data.reason).trim() : '') || null;
    if (!bookingId) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('invalid-argument', 'bookingId is required');
    }

    const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }
    const b = bookingSnap.data() || {};
    if (b.advancePaid !== true) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Advance is not paid for this booking');
    }
    if (b.paidFull === true) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Use a separate policy for paid-full cancellations');
    }
    if (String(b.status || '').toLowerCase() !== 'paid') {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Booking must be in paid status (advance paid)');
    }

    const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('bookingId', '==', bookingId).limit(1).get();
    if (paymentsSnap.empty) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('not-found', 'Payment not found');
    }
    const paymentRef = paymentsSnap.docs[0].ref;
    const payment = paymentsSnap.docs[0].data() || {};
    const amountPaid = Number(payment.amountPaid || 0);
    const gatewayPaymentId = payment.gatewayPaymentId || null;
    if (!gatewayPaymentId) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Payment missing gatewayPaymentId');
    }
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Payment missing amountPaid');
    }

    const holdAmount = Math.max(0, Math.round(amountPaid * 0.25));
    const refundAmount = Math.max(0, amountPaid - holdAmount);
    if (refundAmount <= 0) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Refund amount is zero; cannot proceed');
    }

    const refundId = `refund_${bookingId}_${Date.now()}`;
    const refundNote = reason || 'Cancellation after advance (V1 policy)';
    const refundResult = await cashfreeRefundByGatewayPaymentId({
      gatewayPaymentId,
      refundAmount,
      refundId,
      refundNote,
    });

    const now = admin.firestore.FieldValue.serverTimestamp();
    await paymentRef.set({
      refundStatus: 'initiated_partial',
      refundId,
      refundAmount,
      refundHoldAmount: holdAmount,
      refundInitiatedAt: now,
      refundReason: refundNote,
      refundProcessedBy: context.auth.uid,
      refundGatewayResponse: refundResult,
      updatedAt: now,
    }, { merge: true });

    await bookingRef.set({
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: context.auth.uid,
      cancelReason: refundNote,
      cancellation: {
        policy: 'hold_25pct_of_advance',
        advancePaidAmount: amountPaid,
        holdAmount,
        refundAmount,
      },
      updatedAt: now,
    }, { merge: true });

    try { await deleteCalendarBlocksForBooking(b); } catch (_) {}

    return { ok: true, bookingId, refundId, refundAmount, holdAmount };
  });

/**
 * Dispute creation (client-only) within 12h after End OTP (completedAt).
 * Effect: sets booking.status='disputed', payoutHold=true, and creates disputes doc.
 */
exports.raiseDisputeV1 = regional()
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onCall(async (data, context) => {
    assertAuthed(context);
    const uid = context.auth.uid;

    const bookingId = String(data?.bookingId || '').trim();
    const message = (data?.message ? String(data.message).trim() : '') || null;
    if (!bookingId) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('invalid-argument', 'bookingId is required');
    }

    const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }
    const b = snap.data() || {};
    if (b.clientId !== uid) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('permission-denied', 'Only the client can raise a dispute');
    }
    if (String(b.status || '').toLowerCase() !== 'completed') {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Disputes can only be raised after event completion');
    }
    const completedAt = b.completedAt?.toDate ? b.completedAt.toDate() : (b.completedAt ? new Date(b.completedAt) : null);
    if (!completedAt || Number.isNaN(completedAt.getTime())) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Missing completion timestamp');
    }
    const windowMs = DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
    if (Date.now() - completedAt.getTime() > windowMs) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('failed-precondition', 'Dispute window has expired');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    await bookingRef.set({
      status: 'disputed',
      payoutHold: true,
      dispute: {
        status: 'open',
        openedAt: now,
        openedBy: uid,
        message,
      },
      updatedAt: now,
    }, { merge: true });

    await db.collection(DISPUTES_COLLECTION).add({
      schemaVersion: 1,
      bookingId,
      clientId: uid,
      artistId: b.artistId || null,
      status: 'open',
      message,
      createdAt: now,
      updatedAt: now,
    });

    return { ok: true, bookingId };
  });

/**
 * Admin dispute resolution: removes payoutHold and marks dispute resolved.
 * Note: refund/split payouts are handled by ops/manual in V1.
 */
exports.resolveDisputeV1 = regional()
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onCall(async (data, context) => {
    await assertAdmin(context);

    const bookingId = String(data?.bookingId || '').trim();
    const resolution = String(data?.resolution || '').trim().toLowerCase(); // 'pay_provider' | 'pay_artist' | 'refund_client' | 'split' | 'no_action'
    const note = (data?.note ? String(data.note).trim() : '') || null;
    if (!bookingId) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('invalid-argument', 'bookingId is required');
    }

    const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      const functions = require('firebase-functions/v1');
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }

    const unblockPayout = resolution === 'pay_provider' || resolution === 'pay_artist' || resolution === 'split';
    const now = admin.firestore.FieldValue.serverTimestamp();
    await bookingRef.set({
      status: 'completed',
      payoutHold: !unblockPayout,
      dispute: {
        status: 'resolved',
        resolvedAt: now,
        resolvedBy: context.auth.uid,
        resolution: resolution || 'no_action',
        note,
      },
      updatedAt: now,
    }, { merge: true });

    // Unblock staged payouts (Stage 2) only when resolution allows payout continuation.
    if (unblockPayout) {
      try {
        const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('bookingId', '==', bookingId).limit(1).get();
        if (!paymentsSnap.empty) {
          // IMPORTANT: do not overwrite `releasePlan.stage2` map, because it contains
          // `eligibleAt` and (optionally) allocation data used by the scheduler.
          await paymentsSnap.docs[0].ref.set({
            'releasePlan.stage2.status': 'scheduled',
            'releasePlan.stage2.error': admin.firestore.FieldValue.delete(),
            'releasePlan.stage2.updatedAt': now,
            updatedAt: now,
          }, { merge: true });
        }
      } catch (_) {}
    }

    return { ok: true, bookingId };
  });

/**
 * Scheduled enforcement:
 * - Send up to 3 reminders starting 3 days before `balanceDueAt` (i.e., T-5, T-4, T-3 if due is T-2)
 * - If balanceCancelAt passed and still not paidFull: auto-cancel and release calendar blocks
 *
 * Requires bookings to carry:
 * - balanceDueAt (Timestamp)
 * - balanceCancelAt (Timestamp)
 */
exports.balanceEnforcementSchedulerV1 = regional()
  .pubsub.schedule('every 60 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    // Candidate bookings:
    // - status 'paid' before due date (for reminders + auto-trigger to balance stage at due time)
    // - status 'pending_payment' after due date (for overdue auto-cancel checks)
    const snap = await db.collection(BOOKINGS_COLLECTION)
      .where('status', 'in', ['paid', 'pending_payment'])
      .where('paidFull', '==', false)
      .limit(200)
      .get();

    if (snap.empty) return null;

    for (const doc of snap.docs) {
      const bookingId = doc.id;
      const b = doc.data() || {};
      const dueAt = b.balanceDueAt;
      const cancelAt = b.balanceCancelAt;
      const dueMillis = dueAt?.toMillis ? dueAt.toMillis() : null;
      const cancelMillis = cancelAt?.toMillis ? cancelAt.toMillis() : null;
      if (!dueMillis || !cancelMillis) continue;

      const nowMillis = Date.now();

      // Auto-trigger balance stage at due time (T-2): move from paid -> pending_payment.
      if (String(b.status || '').toLowerCase() === 'paid' && nowMillis >= dueMillis) {
        const dueLater = Number(b.amountDueLater || 0);
        if (dueLater > 0) {
          const now = admin.firestore.FieldValue.serverTimestamp();
          await db.collection(BOOKINGS_COLLECTION).doc(bookingId).set({
            status: 'pending_payment',
            paymentStage: 'balance',
            amount: dueLater,
            amountDueNow: dueLater,
            amountDueLater: 0,
            balanceRequestedAt: now,
            balanceRequestedBy: 'system_due_scheduler',
            updatedAt: now,
          }, { merge: true });
          try {
            if (b.clientId) {
              await communicationService.sendNotification(b.clientId, 'balance_due_reminder', { bookingId });
            }
          } catch (_) {}
        }
      }

      // Auto-cancel if overdue beyond window
      if (cancelMillis <= nowMillis && b.paidFull !== true) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        await db.collection(BOOKINGS_COLLECTION).doc(bookingId).set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: 'system_balance_overdue',
          cancelReason: 'Balance not paid within grace window',
          advanceForfeited: true,
          updatedAt: now,
        }, { merge: true });
        try { await deleteCalendarBlocksForBooking(b); } catch (_) {}
        continue;
      }

      // Reminder logic (Phase-1 lock): max 3 reminders, once per day,
      // starting 3 days before the balance due time (dueAt - 3 days).
      // If balance is already due (now >= dueAt), we do not send "pre-due" reminders anymore.
      const DAY_MS = 24 * 60 * 60 * 1000;
      const reminderStartMillis = dueMillis - 3 * DAY_MS;
      if (nowMillis < reminderStartMillis) continue;
      if (nowMillis >= dueMillis) continue;

      const reminders = Array.isArray(b.balanceReminders) ? b.balanceReminders : [];
      const reminderFailures = Array.isArray(b.balanceReminderFailures) ? b.balanceReminderFailures : [];
      const todayKey = new Date().toISOString().slice(0, 10);
      const alreadyToday = reminders.some((r) => String(r?.day || '') === todayKey)
        || reminderFailures.some((r) => String(r?.day || '') === todayKey);
      if (alreadyToday) continue;
      if (reminders.length >= 3) continue;

      const now = admin.firestore.FieldValue.serverTimestamp();
      let reminderSent = true;
      let reminderError = null;

      // Best-effort notification record for client
      try {
        if (b.clientId) {
          await communicationService.sendNotification(b.clientId, 'balance_due_reminder', { bookingId });
        }
        if (b.artistId) {
          await communicationService.sendNotification(b.artistId, 'balance_due_reminder', { bookingId });
        }
        if (b.vendorId) {
          await communicationService.sendNotification(b.vendorId, 'balance_due_reminder', { bookingId });
        }
      } catch (err) {
        reminderSent = false;
        reminderError = String(err?.message || err || 'notification_failed');
      }

      const sentCount = reminders.length + (reminderSent ? 1 : 0);
      const failedCount = reminderFailures.length + (reminderSent ? 0 : 1);
      const pendingCount = Math.max(0, 3 - sentCount);
      const update = {
        updatedAt: now,
        balanceReminderStats: {
          sent: sentCount,
          failed: failedCount,
          pending: pendingCount,
          total: 3,
          lastAttemptDay: todayKey,
          lastAttemptAt: now,
          lastAttemptStatus: reminderSent ? 'sent' : 'failed',
          dueAt: b.balanceDueAt || null,
        },
      };

      if (reminderSent) {
        update.balanceReminders = admin.firestore.FieldValue.arrayUnion({ day: todayKey, at: now });
      } else {
        update.balanceReminderFailures = admin.firestore.FieldValue.arrayUnion({ day: todayKey, at: now, error: reminderError });
      }

      await db.collection(BOOKINGS_COLLECTION).doc(bookingId).set(update, { merge: true });
    }

    return null;
  });
