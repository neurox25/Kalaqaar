// functions/src/admin/auth.js
'use strict';

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Some unit tests load this module before the default app is initialized.
// In production, index.js typically initializes the app; this is a safe fallback.
try { admin.app(); } catch (_) { admin.initializeApp(); }

const db = admin.firestore();

// Owner-godmode is UID-based only (never email/phone-based).
// You can override/add UIDs via ADMIN_OWNER_UIDS="uid1,uid2".
const OWNER_UIDS = (
  process.env.ADMIN_OWNER_UIDS ||
  ''
)
  .split(',')
  .map((v) => String(v || '').trim())
  .filter(Boolean);

/**
 * Checks if the calling user has admin privileges
 * @param {object} context - Firebase functions context
 * @param {string} requiredRole - Minimum required role ('admin', 'auditor', etc.)
 * @returns {object} User data with role information
 */
async function checkUserRole(context, requiredRole = 'admin') {
  if (!context || !context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = context.auth.uid;
  const email = context.auth.token?.email || context.auth.token?.email_verified || null;
  const phone = context.auth.token?.phone_number || null;

  // Owner-godmode: explicit UID allowlist only.
  if (OWNER_UIDS.includes(uid)) {
    return { uid, email, phone, role: 'admin', permissions: ['*'] };
  }

  // Backward-compatible admin gate: allow if uid is in /admins (server-managed).
  // This matches older operational flows and keeps unit tests stable.
  if (requiredRole === 'admin') {
    const adminDoc = await db.collection('admins').doc(uid).get();
    if (adminDoc.exists && (adminDoc.data()?.active ?? true)) {
      return { uid, email, phone, role: 'admin', permissions: ['*'] };
    }
  }

  // Check user document
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'User profile not found.');
  }

  const userData = userDoc.data();
  const roles = userData.roles || [];
  const role = userData.role || null;

  // Check if user has required role
  const hasRequiredRole = roles.includes(requiredRole) || role === requiredRole || roles.includes('admin') || role === 'admin';

  if (!hasRequiredRole) {
    throw new functions.https.HttpsError('permission-denied', `Insufficient privileges. Required role: ${requiredRole}`);
  }

  return {
    uid,
    email,
    phone,
    role: role || 'user',
    roles,
    permissions: userData.permissions || [],
    userData
  };
}

/**
 * Adds a user to the admins collection (requires existing admin)
 * Expects data: { uid: string, email: string, displayName?: string }
 */
exports.addAdminUser = functions.region('asia-south1').https.onCall(async (data = {}, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { uid, email, displayName } = data;
  if (!uid || !email) {
    throw new functions.https.HttpsError('invalid-argument', 'UID and email are required.');
  }

  try {
    // Add to admins collection
    await db.collection('admins').doc(uid).set({
      uid,
      email,
      displayName: displayName || email,
      addedBy: context.auth.uid,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
      active: true
    });

    // Update user roles
    await db.collection('users').doc(uid).update({
      roles: admin.firestore.FieldValue.arrayUnion('admin'),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: 'Admin user added successfully.' };
  } catch (error) {
    console.error('Error adding admin user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to add admin user.');
  }
});

/**
 * Removes a user from the admins collection (admin only)
 * Expects data: { uid: string }
 */
exports.removeAdminUser = functions.region('asia-south1').https.onCall(async (data = {}, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required.');
  }

  try {
    // Remove from admins collection
    await db.collection('admins').doc(uid).delete();

    // Update user roles
    await db.collection('users').doc(uid).update({
      roles: admin.firestore.FieldValue.arrayRemove('admin'),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: 'Admin user removed successfully.' };
  } catch (error) {
    console.error('Error removing admin user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to remove admin user.');
  }
});

/**
 * Returns the role and permissions of the calling user
 * Expects no data
 */
exports.getUserRole = functions.region('asia-south1').https.onCall(async (data, context) => {
  try {
    const userInfo = await checkUserRole(context, 'user');
    return {
      uid: userInfo.uid,
      email: userInfo.email,
      phone: userInfo.phone,
      role: userInfo.role,
      roles: userInfo.roles,
      permissions: userInfo.permissions
    };
  } catch (error) {
    // For getUserRole, we return minimal info instead of throwing
    if (error?.code === 'unauthenticated') {
      throw error;
    }
    return {
      uid: context.auth?.uid,
      role: 'user',
      roles: [],
      permissions: []
    };
  }
});

/**
 * Adds a user to the auditors collection (requires existing admin)
 * Expects data: { uid: string, email: string, displayName?: string }
 */
exports.addAuditorUser = functions.region('asia-south1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { uid, email, displayName } = data;
  if (!uid || !email) {
    throw new functions.https.HttpsError('invalid-argument', 'UID and email are required.');
  }

  try {
    // Add to auditors collection
    await db.collection('auditors').doc(uid).set({
      uid,
      email,
      displayName: displayName || email,
      addedBy: context.auth.uid,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
      active: true
    });

    // Update user roles
    await db.collection('users').doc(uid).update({
      roles: admin.firestore.FieldValue.arrayUnion('auditor'),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: 'Auditor user added successfully.' };
  } catch (error) {
    console.error('Error adding auditor user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to add auditor user.');
  }
});

/**
 * Approves an auditor (admin only)
 * Expects data: { uid: string }
 */
exports.approveAuditor = functions.region('asia-south1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required.');
  }

  try {
    await db.collection('auditors').doc(uid).update({
      approved: true,
      approvedBy: context.auth.uid,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: 'Auditor approved successfully.' };
  } catch (error) {
    console.error('Error approving auditor:', error);
    throw new functions.https.HttpsError('internal', 'Failed to approve auditor');
  }
});

/**
 * Normalizes user roles across the system (admin only)
 * Expects optional data: { dryRun?: boolean }
 */
exports.normalizeUserRoles = functions.region('asia-south1').https.onCall(async (data = {}, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  // Verify caller is admin
  await checkUserRole(context, 'admin');

  const { dryRun = false } = data;
  const results = {
    processed: 0,
    updated: 0,
    errors: []
  };

  try {
    const usersSnapshot = await db.collection('users').get();
    
    for (const userDoc of usersSnapshot.docs) {
      results.processed++;
      const userData = userDoc.data();
      const updates = {};

      // Normalize role field to roles array
      if (userData.role && !userData.roles) {
        updates.roles = [userData.role];
      } else if (!userData.role && userData.roles && userData.roles.length > 0) {
        updates.role = userData.roles[0];
      }

      if (Object.keys(updates).length > 0) {
        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        
        if (!dryRun) {
          await db.collection('users').doc(userDoc.id).update(updates);
        }
        
        results.updated++;
      }
    }

    return {
      success: true,
      results,
      dryRun
    };
  } catch (error) {
    console.error('Error normalizing user roles:', error);
    throw new functions.https.HttpsError('internal', 'Failed to normalize user roles');
  }
});

// Export the checkUserRole function for use in other modules
exports.checkUserRole = checkUserRole;
