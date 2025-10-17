/* functions/index.js
   - Region forced to asia-south1
    - Exports: createOrder (httpsCallable), cashfreeWebhook (https.onRequest), releasePayout (firestore onUpdate)
*/

// Load .env if present (local/dev). In production, use real env vars or legacy functions.config() fallback.
try { require('dotenv').config(); } catch (_) { }
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
let FieldValueCompat;
try {
    // firebase-admin v11+ exports FieldValue from firestore module
    FieldValueCompat = require('firebase-admin/firestore').FieldValue;
} catch (_e) {
    FieldValueCompat = null;
}
// Use Node 20 global fetch if available; fallback to dynamic import of node-fetch for compatibility
const fetch = (globalThis && globalThis.fetch)
    ? globalThis.fetch
    : ((...args) => import('node-fetch').then(m => m.default(...args)));
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const { PubSub } = require('@google-cloud/pubsub');
// const EscrowService = require('./src/escrowService'); // currently unused

// Initialize Firebase Admin BEFORE requiring any local modules that use it
if (!admin.apps.length) {
    admin.initializeApp();
} else {
    admin.app();
}
const db = admin.firestore();

// Local modules (safe to require after admin is initialized)
const ArtistVerificationService = require('./src/artistVerification');
// Import admin API functions
const adminApi = require('./src/adminApi');
const { applyAutoPromoSpend } = require('./src/lib/autoPromoSpend');
// Ensure new admin ops callable is exported from root
exports.adminMarkBookingCompleted = adminApi.adminMarkBookingCompleted;
exports.adminApproveWalletWithdrawal = adminApi.adminApproveWalletWithdrawal;
exports.adminCompleteWalletWithdrawal = adminApi.adminCompleteWalletWithdrawal;
// Wallet functions module
const wallet = require('./src/wallet');
// KPIs helper
const KPIS = require('./src/kpis');
// Media processing
const mediaWatermark = require('./src/mediaWatermark');
const chatModeration = require('./src/chatModeration');

// Initialize Pub/Sub client
const pubsub = new PubSub();
const PAYOUT_TOPIC = 'kalaqaar-payouts';

// use a regional wrapper to ensure a single default region (asia-south1)
const { regional } = require('./src/region');
const regionalFunctions = regional();

// Configuration keys (priority: Firebase Secrets -> process.env -> legacy functions.config())
// Notes:
// - For production, prefer Firebase Functions Secrets (firebase functions:secrets:set ...)
// - In local dev/emulators, .env can be used; ensure you don't commit real secrets.
// - This file falls back to functions.config() to support legacy deployments.
const CF_CLIENT_ID = process.env.CASHFREE_CLIENT_ID || functions.config().cashfree?.client_id || '<CASHFREE_CLIENT_ID>';
const CF_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || functions.config().cashfree?.client_secret || '<CASHFREE_CLIENT_SECRET>';
// const CF_SECRET = process.env.CASHFREE_SECRET || functions.config().cashfree?.secret || '<CASHFREE_SECRET>'; // unused
const CF_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET || functions.config().cashfree?.webhook_secret || '<CASHFREE_WEBHOOK_SECRET>';
const CF_SANDBOX = (process.env.CASHFREE_SANDBOX || functions.config().cashfree?.sandbox || 'false').toString() === 'true';
const CF_MOCK = (process.env.CASHFREE_MOCK || functions.config().cashfree?.mock || 'false').toString() === 'true';
const CF_BASE_URL = CF_SANDBOX ? 'https://sandbox.cashfree.com' : 'https://api.cashfree.com';

// OpenAI API ( Phase 1: AI Bio Builder )
// Use environment secret OPENAI_API_KEY; no SDK dependency needed (use fetch)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Notification configs
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || functions.config().sendgrid?.api_key || '<SENDGRID_API_KEY>';
const SENDGRID_FROM = process.env.SENDGRID_FROM || functions.config().sendgrid?.from || 'hello@kalaqaar.com';
// Twilio/SMS disabled: we no longer send general SMS. Keep config disabled.

// Helper: compute fees & distribution
const GST = 0.18;
const PLATFORM_FEE_P = 0.05; // 5% charged to client
const COMMISSION_P = 0.15; // 15% charged to artist
// Admin/retained split removed: platform revenue = platformFee + commission; GST applies only on commission

function computeDistribution(A) {
    const platformFee = Math.round(A * PLATFORM_FEE_P);
    const commission = Math.round(A * COMMISSION_P);
    // Per policy: collect GST only on commission at 18%
    const gstCommission = Math.round(commission * GST);
    // Client pays base amount + platform fee only (GST on commission is collected from the artist side)
    const clientTotal = A + platformFee;
    // Artist receives booking amount minus commission and GST on commission
    const artistNet = A - commission - gstCommission;
    // Keep legacy fields for compatibility with downstream writes
    const adminAmount = 0;
    const platformRetained = 0;
    const gstCollectedTotal = gstCommission;

    return {
        A,
        platformFee,
        commission,
        gstCommission,
        clientTotal,
        artistNet,
        adminAmount,
        platformRetained,
        gstCollectedTotal
    };
}

function rolesArrayFromData(userData) {
    if (!userData) return [];
    const rawRoles = userData.roles;
    if (Array.isArray(rawRoles)) {
        const arr = rawRoles.filter((role) => typeof role === 'string' && role.trim().length).map((role) => role.trim());
        const legacy = typeof userData.role === 'string' ? userData.role.trim() : null;
        if (legacy && !arr.includes(legacy)) arr.push(legacy);
        return arr;
    }
    if (rawRoles && typeof rawRoles === 'object') {
        const arr = Object.entries(rawRoles)
            .filter(([_, meta]) => meta !== false && meta !== null)
            .map(([key]) => key);
        const legacy = typeof userData.role === 'string' ? userData.role.trim() : null;
        if (legacy && !arr.includes(legacy)) arr.push(legacy);
        return arr;
    }
    const legacy = typeof userData.role === 'string' ? userData.role.trim() : null;
    return legacy ? [legacy] : [];
}

function rolesMetadataFromData(userData) {
    if (!userData) return {};
    if (userData.rolesMetadata && typeof userData.rolesMetadata === 'object') {
        return { ...userData.rolesMetadata };
    }
    if (userData.roles && typeof userData.roles === 'object' && !Array.isArray(userData.roles)) {
        return { ...userData.roles };
    }
    return {};
}

// ------------------------------
// Public API endpoints (Website)
// Region: asia-south1 (India)
// ------------------------------
// Storage triggers (global region binding is fine for storage; using default)
exports.onMediaUploaded = mediaWatermark.onMediaUploaded;
exports.onChatMessageCreated = chatModeration.onChatMessageCreated;
exports.onBookingMessageCreated = chatModeration.onBookingMessageCreated;

// Share link resolver: /a/{artistId}
exports.resolveArtistShareLink = regionalFunctions.https.onRequest(async (req, res) => {
    try {
        // Extract artistId from path after '/a/'
        const originalPath = req.path || req.url || '';
        // originalPath is like '/a/KA1234' when invoked via Hosting rewrite
        const id = (originalPath.split('/').pop() || '').trim();
        if (!id) {
            res.set('X-Robots-Tag', 'noindex, nofollow');
            return res.status(400).send('Missing artist id');
        }
        const idLower = id.toLowerCase();
        const idxSnap = await db.collection('artistIdIndex').doc(idLower).get();
        if (!idxSnap.exists) {
            res.set('X-Robots-Tag', 'noindex, nofollow');
            return res.status(404).send('Artist not found');
        }
        const base = process.env.APP_DEEP_LINK_BASE || process.env.WEBSITE_BASE_URL || 'https://kalaqaar.com';
        // Keep the path predictable for app handling; allow app to parse last segment
        const redirectUrl = `${base}/a/${encodeURIComponent(id)}`;
        res.set('X-Robots-Tag', 'noindex, nofollow');
        return res.redirect(302, redirectUrl);
    } catch (e) {
        console.error('resolveArtistShareLink error', e?.message || e);
        res.set('X-Robots-Tag', 'noindex, nofollow');
        return res.status(500).send('server error');
    }
});

function serverTimestamp() {
    // Works across admin SDK versions
    if (FieldValueCompat && typeof FieldValueCompat.serverTimestamp === 'function') {
        return FieldValueCompat.serverTimestamp();
    }
    if (admin.firestore && admin.firestore.FieldValue && typeof admin.firestore.FieldValue.serverTimestamp === 'function') {
        return admin.firestore.FieldValue.serverTimestamp();
    }
    // Fallback: use Date for emulator-only safety
    return new Date();
}

// ------------------------------
// Security helpers: reCAPTCHA + simple Firestore rate limiting
// ------------------------------
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || functions.config().recaptcha?.secret || '';

async function verifyRecaptcha(token, remoteIp) {
    if (!RECAPTCHA_SECRET) return { ok: false, reason: 'recaptcha_not_configured' };
    try {
        const params = new URLSearchParams();
        params.set('secret', RECAPTCHA_SECRET);
        params.set('response', token || '');
        if (remoteIp) params.set('remoteip', remoteIp);
        const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const data = await resp.json();
        if (!data.success) return { ok: false, reason: (data['error-codes'] && data['error-codes'].join(',')) || 'recaptcha_failed' };
        if (typeof data.score === 'number' && data.score < 0.3) return { ok: false, reason: 'low_score' };
        return { ok: true };
    } catch (e) {
        console.warn('reCAPTCHA verify error', e?.message || e);
        return { ok: false, reason: 'recaptcha_error' };
    }
}

function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (Array.isArray(xf)) return xf[0];
    if (typeof xf === 'string') return xf.split(',')[0].trim();
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// Sliding-window-ish limiter using Firestore bucket documents
async function checkAndIncrementRate(key, windowSecs, limit) {
    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / (windowSecs * 1000));
    const docId = `${key}:${bucket}`.replace(/[^a-zA-Z0-9:_\-\.]/g, '_');
    const ref = db.collection('rateLimits').doc(docId);
    let current = 0;
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
            tx.set(ref, { key, bucket, count: 1, createdAt: admin.firestore.FieldValue.serverTimestamp() });
            current = 1;
        } else {
            const data = snap.data() || {};
            current = (data.count || 0) + 1;
            tx.update(ref, { count: current, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
    });
    return { allowed: current <= limit, count: current };
}

// (Earlier non-CORS versions of registerArtistLead and supportContact removed to avoid duplicates)

// POST /register/artist-application
// Creates an artist application document with a server-generated unique referral code.
exports.registerArtistApplication = regionalFunctions
    // .runWith({ secrets: ['RECAPTCHA_SECRET', 'SENDGRID_API_KEY', 'SENDGRID_FROM', 'CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_WEBHOOK_SECRET'] })
    .https.onRequest(async (req, res) => {
        try {
            allowCors(req, res);
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'POST') return res.status(405).json({ ok: false, detail: 'Method not allowed' });

            const body = req.body || {};
            const ip = getClientIp(req);
            // Global IP rate limit: 50 requests per 10 minutes
            try {
                const ipRate = await checkAndIncrementRate(`ip:${ip}`, 600, 50);
                if (!ipRate.allowed) return res.status(429).json({ ok: false, detail: 'Too many requests (IP)' });
            } catch (e) {
                console.warn('Rate limit (IP) error', e?.message || e);
            }
            // Verify CAPTCHA if configured
            if (RECAPTCHA_SECRET) {
                const captchaToken = body.captchaToken || body.recaptchaToken || body['g-recaptcha-response'] || '';
                const v = await verifyRecaptcha(captchaToken, ip);
                if (!v.ok) return res.status(400).json({ ok: false, detail: 'Captcha verification failed', reason: v.reason });
            }
            const name = (body.name || '').toString().trim();
            const displayName = (body.displayName || '').toString().trim() || null;
            const phone = normalizePhone(body.phone);
            const city = (body.city || '').toString().trim() || null;
            const email = (body.email || '').toString().trim() || null;
            const category = (body.category || '').toString().trim() || null;
            const languages = Array.isArray(body.languages) ? body.languages.map((l) => String(l).trim()).slice(0, 10) : null;
            const bio = (body.bio || '').toString().trim();
            const referralCodeInput = (body.referralCode || '').toString().trim().toUpperCase() || null;
            const accessibility = body.accessibility && typeof body.accessibility === 'object' ? {
                isPhysicallyChallenged: !!body.accessibility.isPhysicallyChallenged,
                details: (body.accessibility.details || '').toString().slice(0, 500) || null,
            } : null;
            // Optional social handles/links
            const socialInput = (body.social && typeof body.social === 'object') ? body.social : null;
            const social = socialInput ? sanitizeSocial(socialInput) : null;

            if (!name || name.length < 2) return res.status(400).json({ ok: false, detail: 'Valid name required' });
            if (email && email.length > 200) return res.status(400).json({ ok: false, detail: 'Invalid email' });
            if (!phone || phone.length < 8) return res.status(400).json({ ok: false, detail: 'Valid phone required' });
            // Phone-based rate limit: 5 submissions per 10 minutes
            try {
                const phRate = await checkAndIncrementRate(`phone:${phone}`, 600, 5);
                if (!phRate.allowed) return res.status(429).json({ ok: false, detail: 'Too many requests (phone)' });
            } catch (e) {
                console.warn('Rate limit (phone) error', e?.message || e);
            }

            // Generate unique KA-prefixed artistId/referral code (KA + 4-6 chars)
            function genCode() {
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                const len = 4 + Math.floor(Math.random() * 3); // 4-6
                let out = 'KA';
                for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
                return out;
            }

            const now = serverTimestamp();
            const appRef = db.collection('artistApplications').doc();

            // Enforce phone uniqueness using phoneIndex; early check for quick fail and UX hint
            try {
                if (await isPhoneTaken(phone)) {
                    return res.status(409).json({ ok: false, detail: 'phone_in_use', message: 'This phone number is already registered. Please sign in instead.' });
                }
            } catch (_) { /* best-effort; transaction below is the source of truth */ }
            let referralCode = '';

            // Attempt up to 7 times to avoid rare collisions
            for (let attempt = 0; attempt < 7; attempt++) {
                const code = genCode();
                const codeLower = code.toLowerCase();
                // Pre-check both referralCodes registry and artistIdIndex to reduce collisions
                const [codeDoc, idxDoc] = await Promise.all([
                    db.collection('referralCodes').doc(code).get(),
                    db.collection('artistIdIndex').doc(codeLower).get()
                ]);
                if (codeDoc.exists || idxDoc.exists) continue;
                const codeRef = db.collection('referralCodes').doc(code);
                referralCode = code;
                // Reserve code and create app in a batch/transaction for atomicity
                await db.runTransaction(async (tx) => {
                    const codeSnap = await tx.get(codeRef);
                    if (codeSnap.exists) throw new Error('collision');
                    tx.set(codeRef, {
                        code,
                        type: 'artist_application',
                        reserved: true,
                        createdAt: now
                    });
                    // Phone reservation with upgrade precedence (lead < application < artist < user)
                    await txReserveOrUpgradePhone(tx, phone, { ownerType: 'artist_application', ownerId: appRef.id, source: 'registerArtistApplication' });

                    tx.set(appRef, {
                        name,
                        displayName: displayName || null,
                        phone,
                        phoneNormalized: phone,
                        city,
                        email: email || null,
                        category,
                        languages,
                        bio: bio ? bio.slice(0, 400) : null,
                        social: social && Object.keys(social).length ? social : null,
                        accessibility,
                        referralCode,
                        referredBy: referralCodeInput || null,
                        status: 'submitted', // submitted | in_review | approved | rejected
                        source: 'website',
                        createdAt: now,
                        updatedAt: now
                    });
                });
                break;
            }

            if (!referralCode) return res.status(500).json({ ok: false, detail: 'Failed to allocate referral code' });

            // KPIs: application submitted (non-blocking)
            (async () => { try { await KPIS.funnels.artistApplicationSubmitted(); } catch (e) { console.warn('KPI artistApplicationSubmitted failed', e?.message || e); } })();

            // Create an admin task (non-blocking)
            try {
                await db.collection('adminTasks').add({
                    type: 'review_artist_application',
                    applicationId: appRef.id,
                    applicantName: name,
                    applicantPhone: phone,
                    priority: 'normal',
                    status: 'pending',
                    createdAt: serverTimestamp()
                });
            } catch (e) {
                console.warn('Failed to create admin task for application', appRef.id, e.message);
            }

            // Applicant SMS confirmation removed (policy: no general SMS)

            // Send applicant confirmation email (non-blocking) and log outcome
            ; (async () => {
                if (!email) return;
                if (SENDGRID_API_KEY === '<SENDGRID_API_KEY>') return; // not configured
                try {
                    // ensure key is set
                    try { sgMail.setApiKey(SENDGRID_API_KEY); } catch (_e) { /* noop */ }
                    const { subjectTemplate, htmlTemplate, textTemplate } = require('./src/emailTemplates/applicantConfirmation');
                    const firstName = name.split(' ')[0] || 'there';
                    const subject = subjectTemplate(referralCode);
                    const bodyText = textTemplate({ firstName, referralCode });
                    const bodyHtml = htmlTemplate({ firstName, referralCode });
                    await sgMail.send({
                        to: email,
                        from: SENDGRID_FROM,
                        subject,
                        text: bodyText,
                        html: bodyHtml
                    });
                    try {
                        await db.collection('mailLogs').add({
                            to: email,
                            template: 'applicantConfirmation',
                            applicationId: appRef.id,
                            referralCode,
                            status: 'sent',
                            createdAt: serverTimestamp()
                        });
                    } catch (logErr) {
                        console.warn('mailLogs write (sent) failed', logErr?.message || logErr);
                    }
                } catch (_mailErr) {
                    console.warn('Failed to send applicant email', _mailErr?.message || _mailErr);
                    try {
                        await db.collection('mailLogs').add({
                            to: email,
                            template: 'applicantConfirmation',
                            applicationId: appRef.id,
                            referralCode,
                            status: 'failed',
                            error: String(_mailErr?.message || _mailErr),
                            createdAt: serverTimestamp()
                        });
                    } catch (logErr) {
                        console.warn('mailLogs write (failed) failed', logErr?.message || logErr);
                    }
                }
            })();

            // Create minimal artist record immediately on submit so admin Artists list populates
            try {
                const artistId = phone || appRef.id;
                const artistRef = db.collection('artists').doc(artistId);
                await db.runTransaction(async (tx) => {
                    const snap = await tx.get(artistRef);
                    if (snap.exists) return; // do not override existing
                    const ts = admin.firestore.FieldValue.serverTimestamp();
                    const artistIdPublic = referralCode; // Artist public identity = referralCode
                    const artistIdLower = artistIdPublic ? artistIdPublic.toLowerCase() : null;
                    tx.set(artistRef, {
                        uid: artistId,
                        displayName: displayName || name || '',
                        phone: phone,
                        phoneNormalized: phone,
                        email: email || '',
                        city: city || '',
                        primaryCategory: category || '',
                        categories: category ? [category] : [],
                        languages: Array.isArray(languages) ? languages : [],
                        bio: bio ? bio.slice(0, 400) : '',
                        social: social && Object.keys(social).length ? social : null,
                        profileStatus: 'submitted',
                        kyc: { kycStatus: 'pending', aadhaarVerified: false },
                        createdAt: ts,
                        updatedAt: ts,
                        source: 'application_submitted',
                        applicationId: appRef.id,
                        referralCode: artistIdPublic,
                        artistId: artistIdPublic,
                        artistIdLower: artistIdLower
                    });
                    // Create artistIdIndex for uniqueness mapping (case-insensitive)
                    if (artistIdLower) {
                        const idxRef = db.collection('artistIdIndex').doc(artistIdLower);
                        const idxSnap = await tx.get(idxRef);
                        if (idxSnap.exists) throw new Error('collision');
                        tx.set(idxRef, { uid: artistId, createdAt: ts });
                    }
                });
            } catch (e) {
                console.warn('Failed to create artist on submit for application', appRef.id, e?.message || e);
            }

            // Notify admins of new application (non-blocking)
            (async () => {
                try {
                    await notifyAdmin('new_artist_application', {
                        applicationId: appRef.id,
                        name,
                        phone,
                        city,
                        category
                    });
                } catch (nErr) {
                    console.warn('Failed to notify admins for new application', nErr?.message || nErr);
                }
            })();

            return res.status(200).json({ ok: true, id: appRef.id, referralCode });
        } catch (err) {
            if (err && err.message === 'collision') {
                return res.status(503).json({ ok: false, detail: 'Retry, code collision' });
            }
            if (err && err.message === 'phone_taken') {
                return res.status(409).json({ ok: false, detail: 'phone_in_use', message: 'This phone number is already registered. Please sign in instead.' });
            }
            console.error('registerArtistApplication error', err);
            const isEmu = process.env.FUNCTIONS_EMULATOR === 'true' || process.env.FIREBASE_EMULATOR_HUB;
            return res.status(500).json({ ok: false, detail: isEmu ? String(err?.message || err) : 'Internal error' });
        }
    });

// Daily cleanup of transient collections
exports.cleanupTransientDataDaily = regionalFunctions.pubsub.schedule('every 24 hours').onRun(async () => {
    const now = Date.now();
    const deleteOlderThan = async (collection, field, ageMs, pageSize = 300) => {
        const cutoff = new Date(now - ageMs);
        let total = 0;
        while (true) {
            const snap = await db.collection(collection).where(field, '<', cutoff).limit(pageSize).get();
            if (snap.empty) break;
            const batch = db.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            total += snap.size;
            if (snap.size < pageSize) break;
        }
        return total;
    };
    try {
        const deletedWebhookLogs = await deleteOlderThan('webhookLogs', 'receivedAt', 180 * 24 * 60 * 60 * 1000); // 180 days
        const deletedMailLogs = await deleteOlderThan('mailLogs', 'createdAt', 90 * 24 * 60 * 60 * 1000); // 90 days
        const deletedRate = await deleteOlderThan('rateLimits', 'createdAt', 8 * 24 * 60 * 60 * 1000); // 8 days
        // Optional: adminTasks older than 180 days and not open
        let deletedAdminTasks = 0;
        try {
            const cutoff = new Date(now - 180 * 24 * 60 * 60 * 1000);
            const snap = await db.collection('adminTasks').where('createdAt', '<', cutoff).where('status', 'in', ['completed', 'closed', 'resolved']).limit(500).get();
            if (!snap.empty) {
                const batch = db.batch();
                snap.docs.forEach(d => batch.delete(d.ref));
                await batch.commit();
                deletedAdminTasks = snap.size;
            }
        } catch (_) { /* best-effort */ }

        // Storage cleanup: delete gs:// default bucket temp/ older than 7 days
        let deletedStorage = 0;
        try {
            const bucket = admin.storage().bucket();
            const [files] = await bucket.getFiles({ prefix: 'temp/' });
            const cutoff = now - 7 * 24 * 60 * 60 * 1000;
            const toDelete = files.filter(f => {
                const updated = (f.metadata && f.metadata.updated) ? new Date(f.metadata.updated).getTime() : 0;
                return f.name && f.name.startsWith('temp/') && updated && updated < cutoff;
            }).slice(0, 200);
            for (const f of toDelete) {
                try { await f.delete(); deletedStorage++; } catch (_) { /* ignore */ }
            }
        } catch (se) { console.warn('Storage cleanup skipped', se?.message || se); }

        console.log('cleanupTransientDataDaily', { deletedWebhookLogs, deletedMailLogs, deletedRate, deletedAdminTasks, deletedStorage });
    } catch (e) {
        console.error('cleanupTransientDataDaily error', e?.message || e);
    }
    return null;
});

// Mirror approved artist applications into artists collection
exports.onArtistApplicationApproved = regionalFunctions.firestore
    .document('artistApplications/{appId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        if (before.status === after.status) return null;
        if (after.status !== 'approved') return null;
        try {
            const artistId = after.userId || after.uid || after.phoneNormalized || context.params.appId;
            const artistRef = db.collection('artists').doc(artistId);
            const exists = await artistRef.get();
            if (exists.exists) return null; // already created
            const publicId = (after.referralCode || '').toString().trim() || null;
            await artistRef.set({
                uid: artistId,
                displayName: after.displayName || after.name || '',
                phone: after.phone || after.phoneNormalized || '',
                email: after.email || '',
                city: after.city || '',
                primaryCategory: after.category || '',
                categories: after.category ? [after.category] : [],
                languages: Array.isArray(after.languages) ? after.languages : [],
                bio: after.bio || '',
                social: after.social && typeof after.social === 'object' && Object.keys(after.social).length ? sanitizeSocial(after.social) : null,
                profileStatus: 'submitted',
                kyc: { kycStatus: 'pending', aadhaarVerified: false },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                source: 'application_approved',
                applicationId: context.params.appId,
                ...(publicId ? { artistId: publicId, artistIdLower: publicId.toLowerCase(), referralCode: publicId } : {})
            });
            // Create identity index if we have a public id
            if (publicId) {
                try {
                    const idxRef = db.collection('artistIdIndex').doc(publicId.toLowerCase());
                    const idxSnap = await idxRef.get();
                    if (!idxSnap.exists) await idxRef.set({ uid: artistId, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'application_approved' });
                } catch (e) { console.warn('artistIdIndex create failed on approval', e?.message || e); }
            }
            await db.collection('auditLogs').add({
                action: 'artist_created_from_application',
                applicationId: context.params.appId,
                artistId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error('onArtistApplicationApproved error', e);
        }
        return null;
    });

// Callable: backfill artists from already-approved applications (one-off)
exports.backfillArtistsFromApprovedApplications = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Auth required');
    const userSnap = await db.collection('users').doc(context.auth.uid).get();
    const roles = (userSnap.data()?.roles) || [];
    if (!roles.includes('admin')) throw new functions.https.HttpsError('permission-denied', 'Admin only');
    const limit = Math.min(Number(data?.limit || 500), 1000);
    const snap = await db.collection('artistApplications').where('status', '==', 'approved').limit(limit).get();
    let created = 0, skipped = 0;
    for (const doc of snap.docs) {
        const app = doc.data();
        const artistId = app.userId || app.uid || app.phoneNormalized || doc.id;
        const ref = db.collection('artists').doc(artistId);
        const exists = await ref.get();
        if (exists.exists) { skipped++; continue; }
        const publicId = (app.referralCode || '').toString().trim() || null;
        await ref.set({
            uid: artistId,
            displayName: app.displayName || app.name || '',
            phone: app.phone || app.phoneNormalized || '',
            email: app.email || '',
            city: app.city || '',
            primaryCategory: app.category || '',
            categories: app.category ? [app.category] : [],
            languages: Array.isArray(app.languages) ? app.languages : [],
            bio: app.bio || '',
            social: app.social && typeof app.social === 'object' && Object.keys(app.social).length ? sanitizeSocial(app.social) : null,
            profileStatus: 'submitted',
            kyc: { kycStatus: 'pending', aadhaarVerified: false },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'backfill_application_approved',
            applicationId: doc.id,
            ...(publicId ? { artistId: publicId, artistIdLower: publicId.toLowerCase(), referralCode: publicId } : {})
        });
        try {
            if (publicId) {
                const idxRef = db.collection('artistIdIndex').doc(publicId.toLowerCase());
                const idxSnap = await idxRef.get();
                if (!idxSnap.exists) await idxRef.set({ uid: artistId, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'backfill_application_approved' });
            }
        } catch (_) { /* ignore */ }
        created++;
    }
    return { created, skipped, total: snap.size };
});

// Helper: make Cashfree Payouts API call
async function callPayoutsAPI(endpoint, payload) {
    const url = `https://payout-api.cashfree.com${endpoint}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-client-id': CF_CLIENT_ID,
            'x-client-secret': CF_CLIENT_SECRET
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`Payouts API error: ${response.status} ${data.message || JSON.stringify(data)}`);
    }
    return data;
}

// Callable: finalizeGigPayout - moves a staged gig payout (pending_settlement) to finalized and writes ledger entries.
exports.finalizeGigPayout = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Auth required');
    const userSnap = await db.collection('users').doc(context.auth.uid).get();
    const roles = (userSnap.data()?.roles) || [];
    if (!roles.includes('admin')) throw new functions.https.HttpsError('permission-denied', 'Admin only');
    const { gigId } = data || {};
    if (!gigId) throw new functions.https.HttpsError('invalid-argument', 'gigId required');
    const payoutRef = db.collection('gigPayouts').doc(gigId);
    try {
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(payoutRef);
            if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Staged payout not found');
            const payout = snap.data();
            if (payout.status !== 'pending_settlement') {
                return { skipped: true, status: payout.status };
            }
            const finalizedAt = admin.firestore.FieldValue.serverTimestamp();
            tx.update(payoutRef, {
                status: 'finalized',
                finalizedAt,
                updatedAt: finalizedAt
            });
            const ledgerRef = db.collection('platformLedger').doc();
            tx.set(ledgerRef, {
                type: 'gig_payout',
                gigId,
                artistId: payout.artistId,
                amount: payout.amount,
                createdAt: finalizedAt,
                source: 'finalizeGigPayout'
            });
            return { success: true, gigId };
        });
        return result;
    } catch (_e) {
        if (_e instanceof functions.https.HttpsError) throw _e;
        console.error('finalizeGigPayout error', _e);
        throw new functions.https.HttpsError('internal', 'Finalize failed');
    }
});

// Scheduled function: batch finalize any gigPayouts older than N minutes still pending_settlement.
exports.batchFinalizeGigPayouts = regionalFunctions.pubsub.schedule('every 15 minutes').onRun(async () => {
    const cutoff = Date.now() - 10 * 60 * 1000; // older than 10 minutes
    try {
        const snap = await db.collection('gigPayouts')
            .where('status', '==', 'pending_settlement')
            .orderBy('createdAt')
            .limit(50)
            .get();
        if (snap.empty) {
            console.log('No staged gig payouts to finalize');
            return null;
        }
        let finalized = 0; let skipped = 0;
        for (const doc of snap.docs) {
            const d = doc.data();
            const createdAt = d.createdAt?.toMillis ? d.createdAt.toMillis() : 0;
            if (createdAt && createdAt > cutoff) { skipped++; continue; }
            try {
                await db.runTransaction(async (tx) => {
                    const refSnap = await tx.get(doc.ref);
                    const current = refSnap.data();
                    if (current.status !== 'pending_settlement') { skipped++; return; }
                    const finalizedAt = admin.firestore.FieldValue.serverTimestamp();
                    tx.update(doc.ref, { status: 'finalized', finalizedAt, updatedAt: finalizedAt });
                    const ledgerRef = db.collection('platformLedger').doc();
                    tx.set(ledgerRef, {
                        type: 'gig_payout',
                        gigId: doc.id,
                        artistId: current.artistId,
                        amount: current.amount,
                        createdAt: finalizedAt,
                        source: 'batchFinalizeGigPayouts'
                    });
                });
                finalized++;
            } catch (err) {
                console.error('Batch finalize error for gigPayout', doc.id, err.message);
            }
        }
        console.log(`batchFinalizeGigPayouts completed finalized=${finalized} skipped=${skipped}`);
    } catch (_e) {
        console.error('batchFinalizeGigPayouts top-level error', _e);
    }
    return null;
});

// Admin-only: Backfill missing artistId/artistIdLower and artistIdIndex mappings for existing artist docs.
// Usage (callable): adminBackfillArtistIdentity({ pageSize?, startAfterId? })
exports.adminBackfillArtistIdentity = regionalFunctions
    .runWith({ timeoutSeconds: 540, memory: '1GB' })
    .https.onCall(async (data, context) => {
        if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Auth required');
        const userSnap = await db.collection('users').doc(context.auth.uid).get();
        const roles = (userSnap.data()?.roles) || [];
        if (!roles.includes('admin')) throw new functions.https.HttpsError('permission-denied', 'Admin only');

        const pageSizeRaw = Number(data?.pageSize);
        const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 500) : 200;
        const startAfterId = typeof data?.startAfterId === 'string' && data.startAfterId ? data.startAfterId : null;

        // Helper to generate a unique KA code and ensure artistIdIndex reservation
        async function allocateUniqueArtistCode(tx) {
            for (let i = 0; i < 10; i++) {
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                const len = 4 + Math.floor(Math.random() * 3);
                let code = 'KA';
                for (let j = 0; j < len; j++) code += chars[Math.floor(Math.random() * chars.length)];
                const codeLower = code.toLowerCase();
                const idxRef = db.collection('artistIdIndex').doc(codeLower);
                const snap = await tx.get(idxRef);
                if (snap.exists) continue;
                return { code, codeLower, idxRef };
            }
            throw new functions.https.HttpsError('resource-exhausted', 'Failed to allocate unique artist id');
        }

        try {
            let query = db.collection('artists').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
            if (startAfterId) query = query.startAfter(startAfterId);
            const snap = await query.get();
            if (snap.empty) return { processed: 0, updated: 0, indexed: 0, conflicts: 0, next: null };

            let updated = 0; let indexed = 0; let conflicts = 0;
            for (const doc of snap.docs) {
                await db.runTransaction(async (tx) => {
                    const ref = doc.ref;
                    const curSnap = await tx.get(ref);
                    if (!curSnap.exists) return;
                    const cur = curSnap.data() || {};
                    let artistIdPublic = (cur.artistId || cur.referralCode || '').toString().trim();
                    let artistIdLower = artistIdPublic ? artistIdPublic.toLowerCase() : '';
                    const uid = cur.uid || doc.id;

                    // Determine desired public id
                    if (!artistIdPublic || artistIdPublic.length < 3) {
                        const alloc = await allocateUniqueArtistCode(tx);
                        artistIdPublic = alloc.code;
                        artistIdLower = alloc.codeLower;
                        // Reserve idx for this uid
                        tx.set(alloc.idxRef, { uid, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'backfill' });
                        indexed++;
                    } else {
                        // Ensure index exists and points to this uid
                        const idxRef = db.collection('artistIdIndex').doc(artistIdLower);
                        const idxSnap = await tx.get(idxRef);
                        if (!idxSnap.exists) {
                            tx.set(idxRef, { uid, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'backfill' });
                            indexed++;
                        } else {
                            const idxUid = idxSnap.data()?.uid;
                            if (idxUid && idxUid !== uid) {
                                // Conflict: same artistId mapped to another uid; record and skip changing identity
                                conflicts++;
                                const auditRef = db.collection('auditLogs').doc();
                                tx.set(auditRef, {
                                    action: 'artist_id_conflict',
                                    artistDocId: doc.id,
                                    currentUid: uid,
                                    conflictingUid: idxUid,
                                    artistId: artistIdPublic,
                                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                                });
                            }
                        }
                    }

                    // Update artist document fields if missing or mismatched
                    const updates = {};
                    if (cur.artistId !== artistIdPublic) updates.artistId = artistIdPublic;
                    if (cur.artistIdLower !== artistIdLower) updates.artistIdLower = artistIdLower;
                    if (!cur.referralCode) updates.referralCode = artistIdPublic;
                    if (Object.keys(updates).length) {
                        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
                        tx.set(ref, updates, { merge: true });
                        updated++;
                    }
                });
            }

            const last = snap.docs[snap.docs.length - 1];
            return { processed: snap.size, updated, indexed, conflicts, next: last ? last.id : null };
        } catch (e) {
            console.error('adminBackfillArtistIdentity error', e?.message || e);
            throw new functions.https.HttpsError('internal', 'Backfill failed');
        }
    });

// ------------------------------------------------------
// Admin utility: cleanup specific test submissions (one-off)
// Usage: POST /utils/cleanupTestSubmissions?confirm=yes
// Body optional, hard-codes known test IDs and referral codes to prevent accidental deletions.
exports.cleanupTestSubmissions = regionalFunctions.https.onRequest(async (req, res) => {
    try {
        allowCors(req, res);
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ ok: false, detail: 'Method not allowed' });
        const confirm = (req.query.confirm || '').toString();
        if (confirm !== 'yes') return res.status(400).json({ ok: false, detail: 'Pass confirm=yes to execute' });

        // Only delete known test documents created during deliverability tests
        const appIds = [
            'yQ7FAu0qYfskG19YPwO9', // F9YJ54
            'uBeNSHdkVCHJQzAgPZIz', // 3JTGKG
            '6xdIHRQANisJERzE53Ri'  // DJCBAL
        ];
        const referralCodes = ['F9YJ54', '3JTGKG', 'DJCBAL'];

        let deletedApps = 0, deletedCodes = 0, deletedMailLogs = 0;

        // Delete application docs
        for (const id of appIds) {
            try {
                await db.collection('artistApplications').doc(id).delete();
                deletedApps++;
            } catch (e) {
                console.warn('cleanup: failed to delete application', id, e?.message || e);
            }
        }

        // Delete referral code docs
        for (const code of referralCodes) {
            try {
                await db.collection('referralCodes').doc(code).delete();
                deletedCodes++;
            } catch (e) {
                console.warn('cleanup: failed to delete referral code', code, e?.message || e);
            }
        }

        // Delete mailLogs related to these applications
        try {
            for (const id of appIds) {
                const snap = await db.collection('mailLogs').where('applicationId', '==', id).get();
                const batch = db.batch();
                snap.forEach((doc) => batch.delete(doc.ref));
                if (!snap.empty) {
                    await batch.commit();
                    deletedMailLogs += snap.size;
                }
            }
        } catch (e) {
            console.warn('cleanup: failed to delete some mailLogs', e?.message || e);
        }

        return res.status(200).json({ ok: true, deletedApps, deletedCodes, deletedMailLogs });
    } catch (err) {
        console.error('cleanupTestSubmissions error', err);
        return res.status(500).json({ ok: false, detail: 'Internal error' });
    }
});

// Helper: Generic Cashfree API call (for SMS, etc.)
async function callCashfreeAPI(endpoint, payload, method = 'POST') {
    const url = `${CF_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-client-id': CF_CLIENT_ID,
            'x-client-secret': CF_CLIENT_SECRET
        },
        body: method !== 'GET' ? JSON.stringify(payload) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(`Cashfree API error: ${response.status} ${data.message || JSON.stringify(data)}`);
    }
    return data;
}

// Helper: Log webhook and check for duplicates
async function logWebhookAndCheckIdempotency(eventId, event, req) {
    const webhookLogRef = db.collection('webhookLogs').doc(eventId);
    const existing = await webhookLogRef.get();

    if (existing.exists) {
        const logData = existing.data();
        if (logData.status === 'processed') {
            console.log('Webhook already processed', eventId);
            return { isDuplicate: true };
        }
    }

    // Log the webhook
    await webhookLogRef.set({
        eventId,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        rawBody: req.rawBody || JSON.stringify(req.body),
        headers: req.headers,
        status: 'processing',
        eventType: event.type || event.event,
        source: 'cashfree'
    });

    return { isDuplicate: false, logRef: webhookLogRef };
}

// ********** Pub/Sub Queue Management **********
// Enqueue payout job to Pub/Sub
async function enqueuePayoutJob(jobData) {
    try {
        const dataBuffer = Buffer.from(JSON.stringify(jobData));
        // Ensure topic exists (auto-create if missing) to make first enqueue resilient
        const topic = pubsub.topic(PAYOUT_TOPIC);
        try {
            await topic.get({ autoCreate: true });
        } catch (tErr) {
            console.warn('Topic ensure/get failed (will attempt publish anyway):', tErr?.message || tErr);
        }
        const messageId = await topic.publish(dataBuffer);
        console.log(`Enqueued payout job with message ID: ${messageId}`);
        return messageId;
    } catch (error) {
        console.error('Failed to enqueue payout job:', error);
        throw error;
    }
}


// Process payout job from Pub/Sub
async function processPayoutJob(jobData) {
    const { bookingId, payoutType, recipientId, amount, bankDetails, transferId } = jobData;

    try {
        console.log(`Processing ${payoutType} payout for booking ${bookingId}, amount: ₹${amount}`);

        // Find payment document
        const paymentsSnap = await db.collection('payments').where('bookingId', '==', bookingId).limit(1).get();
        if (paymentsSnap.empty) {
            throw new Error(`No payment found for booking ${bookingId}`);
        }
        const paymentRef = paymentsSnap.docs[0].ref;

        if (payoutType === 'artist') {
            try {
                const promoResult = await applyAutoPromoSpend({
                    userId: recipientId,
                    bookingId,
                    payoutType,
                    payoutAmount: amount,
                });
                if (promoResult?.applied) {
                    console.log(`Auto promo spend applied for ${recipientId}: ₹${promoResult.applied}`);
                } else if (promoResult?.skipped) {
                    console.log(`Auto promo spend skipped for ${recipientId}: ${promoResult.skipped}`);
                } else if (promoResult?.error) {
                    console.warn(`Auto promo spend failed for ${recipientId}: ${promoResult.error}`);
                }
            } catch (autoErr) {
                console.error('applyAutoPromoSpend threw error', autoErr);
            }
        }

        // Add beneficiary if not exists
        const beneId = `${payoutType}_${recipientId}`;
        const beneficiaryPayload = {
            beneId,
            name: bankDetails.name || 'Recipient',
            email: bankDetails.email || '',
            phone: bankDetails.phone || '',
            bankDetails: {
                bankAccount: bankDetails.accountNumber,
                ifsc: bankDetails.ifsc,
                bankName: bankDetails.bankName || ''
            },
            address: {
                address1: bankDetails.address || '',
                city: bankDetails.city || '',
                state: bankDetails.state || '',
                pincode: bankDetails.pincode || ''
            }
        };

        await callPayoutsAPI('/payout/v1/addBeneficiary', beneficiaryPayload);

        // Initiate transfer
        const transferPayload = {
            beneId,
            amount: amount.toString(),
            transferId,
            remarks: `${payoutType} payout for booking ${bookingId}`
        };

        const transferResult = await callPayoutsAPI('/payout/v1/requestTransfer', transferPayload);

        // Update payment document with payout result
        const payoutUpdate = {
            payoutId: transferResult.transferId || transferId,
            amount,
            status: 'initiated',
            cfReferenceId: transferResult.referenceId,
            initiatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await paymentRef.update({
            [`payouts.${payoutType}`]: payoutUpdate,
            [`payoutAttempts.${payoutType}`]: admin.firestore.FieldValue.arrayUnion({
                attemptId: transferId,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: 'initiated',
                amount
            })
        });

        console.log(`${payoutType} payout initiated for booking ${bookingId}`);
        return { success: true, transferId: transferResult.transferId };

    } catch (error) {
        console.error(`Payout processing failed for ${payoutType} in booking ${bookingId}:`, error);

        // Update payment document with failure
        try {
            const paymentsSnap = await db.collection('payments').where('bookingId', '==', bookingId).limit(1).get();
            if (!paymentsSnap.empty) {
                const paymentRef = paymentsSnap.docs[0].ref;
                await paymentRef.update({
                    [`payoutAttempts.${payoutType}`]: admin.firestore.FieldValue.arrayUnion({
                        attemptId: transferId,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'failed',
                        error: error.message,
                        amount
                    })
                });
            }
        } catch (_updateError) {
            console.error('Failed to update payout failure:', _updateError);
        }

        throw error;
    }
}

// Cashfree API helper shortcuts removed (inline calls used)

// ********** Webhook Security **********
// Verify Cashfree webhook signature using raw body
function verifyCashfreeSignature(req, secret) {
    try {
        const signature = req.headers['x-webhook-signature'] || req.headers['x-cashfree-signature'];
        if (!signature) {
            console.warn('No webhook signature found');
            return false;
        }

        // Use raw body for HMAC calculation
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const expectedBuffer = crypto
            .createHmac('sha256', secret)
            .update(rawBody, 'utf8')
            .digest();

        let provided = null;

        // Cashfree documentation specifies Base64, but retain hex fallback.
        // Try Base64 first (per current API), then fall back to hex.
        const trimmedSignature = signature.trim();
        try {
            provided = Buffer.from(trimmedSignature, 'base64');
        } catch (_) {
            provided = null;
        }

        if (!provided || provided.length !== expectedBuffer.length) {
            try {
                provided = Buffer.from(trimmedSignature, 'hex');
            } catch (_) {
                provided = null;
            }
        }

        if (!provided || provided.length !== expectedBuffer.length) {
            console.warn('Signature length mismatch');
            return false;
        }

        // Use timing-safe comparison
        try {
            return crypto.timingSafeEqual(provided, expectedBuffer);
        } catch (err) {
            console.error('timingSafeEqual error', {
                header: trimmedSignature,
                headerLength: trimmedSignature.length,
                providedLength: provided?.length,
                expectedLength: expectedBuffer.length,
                expectedBase64: expectedBuffer.toString('base64'),
                error: err.message
            });
            throw err;
        }
    } catch (error) {
        console.error('Signature verification error:', error);
        return false;
    }
}

// -------------- createOrder (callable) -----------------
// Verifies booking and creates Cashfree order, writes payments doc.
// Client calls this before opening checkout; server returns paymentParams (url/orderId).
exports.createOrder = regionalFunctions.https.onCall(async (data, context) => {
    // Authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const uid = context.auth.uid;
    const { bookingId } = data || {};
    if (!bookingId) {
        throw new functions.https.HttpsError('invalid-argument', 'bookingId required');
    }

    // Use Firestore transaction for atomic operations
    const bookingRef = db.collection('bookings').doc(bookingId);
    let serverAmount;
    let bookingData;

    try {
        return await db.runTransaction(async (tx) => {
            const bookingSnapTx = await tx.get(bookingRef);
            if (!bookingSnapTx.exists) {
                throw new functions.https.HttpsError('not-found', 'Booking not found');
            }

            bookingData = bookingSnapTx.data();

            // Validate booking ownership and status
            if (bookingData.clientId !== uid) {
                throw new functions.https.HttpsError('permission-denied', 'Only booking creator can create order');
            }
            if (bookingData.status !== 'pending_payment') {
                throw new functions.https.HttpsError('failed-precondition', 'Booking not in pending_payment state');
            }

            // Determine booking type (default to 'gig' for backward compatibility)
            const bookingType = String((bookingData.type || bookingData.bookingType || 'gig')).toLowerCase();
            const isProject = bookingType === 'project';

            // For projects: require proposal acceptance AND a completed proposal call
            if (isProject) {
                if (!bookingData.proposal || bookingData.proposal.accepted !== true) {
                    throw new functions.https.HttpsError('failed-precondition', 'Proposal must be accepted before payment for projects');
                }
                const callCompleted = !!(
                    bookingData.callCompleted ||
                    (bookingData.call && bookingData.call.completed === true) ||
                    (bookingData.gating && bookingData.gating.callCompleted === true)
                );
                if (!callCompleted) {
                    throw new functions.https.HttpsError('failed-precondition', 'Project requires a completed proposal call before payment');
                }
            }

            // Derive server-side amount from booking data (don't trust client)
            serverAmount = bookingData.amount || bookingData.proposal?.amount || 0;
            if (!serverAmount || serverAmount <= 0) {
                throw new functions.https.HttpsError('failed-precondition', 'Invalid booking amount');
            }

            // Create Cashfree order
            const orderPayload = {
                orderId: `kalaqaar_${bookingId}_${Date.now()}`,
                orderAmount: serverAmount.toString(),
                orderCurrency: 'INR',
                customerDetails: {
                    customerId: uid,
                    customerEmail: bookingData.clientEmail || '',
                    customerPhone: bookingData.clientPhone || ''
                }
            };

            let cfResp;
            let gatewayOrderId;
            let paymentUrl;

            if (CF_MOCK) {
                gatewayOrderId = orderPayload.orderId;
                paymentUrl = `https://mock.cashfree.test/pay/${gatewayOrderId}`;
                cfResp = {
                    order_id: gatewayOrderId,
                    orderId: gatewayOrderId,
                    payment_link: paymentUrl,
                    paymentLink: paymentUrl,
                    status: 'MOCK_SUCCESS',
                    environment: 'mock',
                };
            } else {
                const res = await fetch(`${CF_BASE_URL}/pg/orders`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-client-id': CF_CLIENT_ID,
                        'x-client-secret': CF_CLIENT_SECRET
                    },
                    body: JSON.stringify(orderPayload)
                });

                cfResp = await res.json();
                if (!res.ok) {
                    console.error('Cashfree order creation failed', cfResp);
                    throw new functions.https.HttpsError('internal', 'Payment gateway order creation failed');
                }

                gatewayOrderId = cfResp?.order_id || cfResp?.orderId || orderPayload.orderId;
                paymentUrl = cfResp?.payment_link || cfResp?.paymentLink || null;
            }

            // Create payment document atomically
            const paymentRef = db.collection('payments').doc();
            tx.set(paymentRef, {
                bookingId,
                gateway: 'cashfree',
                gatewayOrderId,
                gatewayResponse: cfResp,
                amountExpected: serverAmount,
                escrowHeld: false,
                releaseStatus: 'held_pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Update booking with payment reference
            tx.update(bookingRef, {
                paymentRef: paymentRef.id,
                gatewayOrderId,
                bookingType: bookingType, // normalize type if not already set
                paymentInitiatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Return payment details to client
            return {
                paymentRefId: paymentRef.id,
                gatewayOrderId,
                paymentUrl,
                amount: serverAmount,
                raw: cfResp
            };
        });

    } catch (err) {
        console.error('createOrder error', err);
        if (err instanceof functions.https.HttpsError) {
            throw err;
        }
        throw new functions.https.HttpsError('internal', 'createOrder failed');
    }
});

/**
 * ---------------- Website API endpoints ----------------
 * Expose minimal HTTPS APIs for the static website forms to POST to.
 * - POST /api/register/artist-lead
 * - POST /api/support/contact
 * These will typically be reached via Firebase Hosting rewrites so they are same-origin.
 */

// Small helper: normalize and very basic phone sanity
function normalizePhone(phone) {
    if (!phone) return '';
    const p = String(phone).replace(/[^0-9+]/g, '').trim();
    if (!p) return '';
    if (p.startsWith('+')) return p;
    if (p.startsWith('91') && p.length >= 12) return '+' + p;
    if (/^[0-9]{10}$/.test(p)) return '+91' + p;
    return p;
}

function allowCors(req, res) {
    const origin = req.headers.origin || '';
    const defaultAllowed = [
        'https://kalaqaar.com',
        'https://www.kalaqaar.com',
        'https://kalaqaar.web.app',
        'https://kalaqaar.firebaseapp.com',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
    ];
    const cfg = process.env.CORS_ALLOWED_ORIGINS || functions.config().cors?.allowed_origins || '';
    const extra = cfg ? cfg.split(',').map(s => s.trim()).filter(Boolean) : [];
    const allowed = [...new Set([...defaultAllowed, ...extra])];
    if (allowed.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
    }
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ------------------------------
// Phone Index helpers (enforce uniqueness across registrations)
// phoneIndex/{phoneNormalized} -> { ownerType, ownerId, source, createdAt, updatedAt }
// ownerType: 'artist_application' | 'artist' | 'user' | 'lead'
// ------------------------------
function phoneIndexRef(phoneNorm) {
    return db.collection('phoneIndex').doc(phoneNorm);
}

async function isPhoneTaken(phoneNorm) {
    if (!phoneNorm) return false;
    const snap = await phoneIndexRef(phoneNorm).get();
    return snap.exists;
}

// Reserve or upgrade phone ownerType if precedence increases.
// Precedence: lead (1) < artist_application (2) < artist (3) < user (4)
const PHONE_OWNER_PRECEDENCE = { lead: 1, artist_application: 2, artist: 3, user: 4 };
async function txReserveOrUpgradePhone(tx, phoneNorm, payload) {
    const ref = phoneIndexRef(phoneNorm);
    const snap = await tx.get(ref);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const newType = payload.ownerType;
    const newPrec = PHONE_OWNER_PRECEDENCE[newType] || 0;
    if (!snap.exists) {
        tx.set(ref, {
            phone: phoneNorm,
            ownerType: newType,
            ownerId: payload.ownerId,
            source: payload.source || null,
            createdAt: now,
            updatedAt: now
        });
        return { action: 'created' };
    }
    const existing = snap.data() || {};
    const oldType = existing.ownerType;
    const oldPrec = PHONE_OWNER_PRECEDENCE[oldType] || 0;
    if (newPrec > oldPrec) {
        tx.update(ref, {
            ownerType: newType,
            ownerId: payload.ownerId,
            source: payload.source || existing.source || null,
            updatedAt: now
        });
        return { action: 'upgraded', from: oldType, to: newType };
    }
    // No change
    return { action: 'kept', ownerType: oldType };
}

// Sanitize social handles/URLs. Accept values like full URLs or @handles, normalize to URLs where possible.
function sanitizeSocial(input) {
    const out = {};
    try {
        const { instagram, youtube, spotify, twitter, x } = input || {};
        const trim = (s) => (s || '').toString().trim().slice(0, 200);
        const norm = (label, val) => {
            const v = trim(val);
            if (!v) return null;
            // Heuristics per network
            if (label === 'instagram') {
                if (v.startsWith('http')) return v;
                const handle = v.replace(/^@+/, '');
                return `https://instagram.com/${handle}`;
            }
            if (label === 'youtube') {
                // Accept channel/user/video URLs as-is; if only an id/handle is provided, leave as-is
                return v;
            }
            if (label === 'spotify') {
                return v;
            }
            if (label === 'twitter' || label === 'x') {
                if (v.startsWith('http')) return v;
                const handle = v.replace(/^@+/, '');
                return `https://x.com/${handle}`;
            }
            return v;
        };
        const ig = norm('instagram', instagram);
        const yt = norm('youtube', youtube);
        const sp = norm('spotify', spotify);
        const tw = norm('twitter', twitter || x);
        if (ig) out.instagram = ig;
        if (yt) out.youtube = yt;
        if (sp) out.spotify = sp;
        if (tw) out.twitter = tw;
    } catch (_) { /* noop */ }
    return out;
}

exports.registerArtistLead = regionalFunctions.https.onRequest(async (req, res) => {
    try {
        allowCors(req, res);
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ ok: false, detail: 'Method not allowed' });

        const body = req.body || {};
        const name = (body.name || '').toString().trim();
        const displayName = (body.displayName || '').toString().trim();
        const phone = normalizePhone(body.phone);
        const city = (body.city || '').toString().trim() || null;
        const category = (body.category || '').toString().trim() || null;
        const languages = Array.isArray(body.languages) ? body.languages.map((l) => String(l).trim()).slice(0, 10) : null;
        const bio = (body.bio || '').toString().trim();
        const accessibility = body.accessibility && typeof body.accessibility === 'object' ? {
            isPhysicallyChallenged: !!body.accessibility.isPhysicallyChallenged,
            details: (body.accessibility.details || '').toString().slice(0, 500) || null,
        } : null;
        const performerType = body.performerType === 'group' ? 'group' : (body.performerType === 'individual' ? 'individual' : null);
        const groupSize = body.groupSize !== null && body.groupSize !== undefined ? Number(body.groupSize) : null;

        // Validation
        if (!name || name.length < 2) return res.status(400).json({ ok: false, detail: 'Valid name required' });
        if (!phone || phone.length < 8) return res.status(400).json({ ok: false, detail: 'Valid phone required' });
        if (performerType === 'group' && (!groupSize || groupSize < 2)) {
            return res.status(400).json({ ok: false, detail: 'Group size must be at least 2' });
        }

        // If phone is already registered anywhere, don't create a duplicate lead
        try {
            if (await isPhoneTaken(phone)) {
                // Try to find an existing lead by phone to return its id
                let existingId = null;
                const leadSnap = await db.collection('leads').where('phoneNormalized', '==', phone).limit(1).get();
                if (!leadSnap.empty) existingId = leadSnap.docs[0].id;
                return res.status(200).json({ ok: true, duplicate: true, message: 'Phone already registered, please sign in instead.', id: existingId });
            }
        } catch (_) { /* ignore */ }

        const now = serverTimestamp();
        const ref = db.collection('leads').doc();
        await db.runTransaction(async (tx) => {
            await txReserveOrUpgradePhone(tx, phone, { ownerType: 'lead', ownerId: ref.id, source: 'registerArtistLead' });
            tx.set(ref, {
                name,
                displayName: displayName || null,
                phone,
                phoneNormalized: phone,
                city,
                category,
                languages,
                bio: bio ? bio.slice(0, 400) : null,
                accessibility,
                performerType,
                groupSize,
                source: 'website',
                createdAt: now,
                updatedAt: now,
            });
        });

        return res.status(200).json({ ok: true, id: ref.id });
    } catch (err) {
        console.error('registerArtistLead error', err);
        return res.status(500).json({ ok: false, detail: 'Internal error' });
    }
});

exports.supportContact = regionalFunctions.https.onRequest(async (req, res) => {
    try {
        allowCors(req, res);
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ ok: false, detail: 'Method not allowed' });

        const body = req.body || {};
        const name = (body.name || '').toString().trim();
        const email = (body.email || '').toString().trim() || null;
        const phone = normalizePhone(body.phone || '');
        const message = (body.message || '').toString().trim();

        if (!name || name.length < 2) return res.status(400).json({ ok: false, detail: 'Valid name required' });
        if (!message || message.length < 2) return res.status(400).json({ ok: false, detail: 'Message required' });

        const now = serverTimestamp();
        const ref = db.collection('supportMessages').doc();
        await ref.set({
            name,
            email,
            phone: phone || null,
            message,
            source: 'website',
            createdAt: now,
        });

        return res.status(200).json({ ok: true, id: ref.id });
    } catch (err) {
        console.error('supportContact error', err);
        return res.status(500).json({ ok: false, detail: 'Internal error' });
    }
});

// ------------------------------
// Health check endpoint (asia-south1)
// Matches Hosting rewrite to function "health"
// ------------------------------
exports.health = regionalFunctions.https.onRequest(async (_req, res) => {
    try {
        // Basic Firestore connectivity check
        const ref = db.collection('_health_check').doc('ping');
        await ref.set({ ts: admin.firestore.FieldValue.serverTimestamp() });
        await ref.delete();
        return res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (e) {
        console.error('Health check failed', e?.message || e);
        return res.status(503).json({ status: 'unhealthy', error: String(e?.message || e) });
    }
});

// -------------- checkPhoneExists (callable) ---------------
// Returns whether a phone number is already in use (in phoneIndex) and hints what to do.
// No auth required; rate-limit upstream via existing IP rate limiter if exposed publicly.
exports.checkPhoneExists = regionalFunctions.https.onCall(async (data, _context) => {
    const phoneInput = (data && data.phone) ? String(data.phone) : '';
    const norm = normalizePhone(phoneInput);
    if (!norm) {
        throw new functions.https.HttpsError('invalid-argument', 'Valid phone required');
    }
    try {
        const ref = phoneIndexRef(norm);
        const snap = await ref.get();
        if (!snap.exists) return { exists: false };
        const rec = snap.data() || {};
        return { exists: true, ownerType: rec.ownerType || null, ownerId: rec.ownerId || null };
    } catch (e) {
        console.error('checkPhoneExists error', e?.message || e);
        throw new functions.https.HttpsError('internal', 'Lookup failed');
    }
});

// -------------- generateArtistBio (callable) ---------------
// Returns 2-3 short bio suggestions based on basic artist info. Does not write to Firestore.
// Client must show preview and save only after user approval.
exports.generateArtistBio = regionalFunctions
    .runWith({ timeoutSeconds: 15, memory: '256MB', secrets: ['OPENAI_API_KEY'] })
    .https.onCall(async (data, context) => {
        // Auth required to tie rate limits to UID
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
        }
        if (!OPENAI_API_KEY) {
            throw new functions.https.HttpsError('failed-precondition', 'AI not configured');
        }

        // Extract basic fields, avoid KYC/contact in prompt
        const displayName = (data?.displayName || '').toString().trim();
        const category = (data?.category || data?.primaryCategory || '').toString().trim();
        const city = (data?.city || '').toString().trim();
        const languages = Array.isArray(data?.languages) ? data.languages.map((v) => String(v).trim()).slice(0, 5) : [];
        const style = (data?.style || '').toString().trim();
        const tone = (data?.tone || 'professional').toString().trim();

        if (!category) {
            throw new functions.https.HttpsError('invalid-argument', 'category required');
        }

        // Per-UID rate limit: max 20 calls per day-bucket
        try {
            const rate = await checkAndIncrementRate(`bio:${context.auth.uid}`, 24 * 3600, 20);
            if (!rate.allowed) throw new functions.https.HttpsError('resource-exhausted', 'Daily bio generation limit reached');
        } catch (e) {
            if (e instanceof functions.https.HttpsError) throw e;
            // best-effort: continue if rate store unavailable
        }

        // Compose prompt
        const prompt = [
            'You are Kalaqaar GPT, a helpful assistant for Indian performing artists.',
            'Write 2 to 3 concise bio options (each 1-3 sentences, max ~280 chars) for a marketplace profile.',
            'Keep it authentic, avoid exaggerated claims. Do not include contact info, pricing or external links.',
            'Use simple, friendly tone and Indian context. Output as a JSON array of strings only.',
            '',
            `Artist name: ${displayName || '—'}`,
            `Category: ${category}`,
            `City: ${city || '—'}`,
            `Languages: ${languages.join(', ') || '—'}`,
            style ? `Style: ${style}` : '',
            tone ? `Tone: ${tone}` : ''
        ].filter(Boolean).join('\n');

        // Call OpenAI (chat.completions)
        try {
            const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    temperature: 0.8,
                    max_tokens: 220,
                    messages: [
                        { role: 'system', content: 'You are a concise copywriter for artist bios. Return only JSON.' },
                        { role: 'user', content: prompt }
                    ]
                })
            });
            if (!resp.ok) {
                const errTxt = await resp.text();
                console.error('OpenAI error', resp.status, errTxt);
                throw new functions.https.HttpsError('internal', 'AI generation failed');
            }
            const dataJson = await resp.json();
            const raw = dataJson?.choices?.[0]?.message?.content || '';
            // Attempt to parse JSON array; fallback to line-split
            let suggestions = [];
            try {
                suggestions = JSON.parse(raw);
                if (!Array.isArray(suggestions)) suggestions = [];
            } catch (_) {
                suggestions = raw
                    .split(/\n+/)
                    .map((s) => s.replace(/^[-•\d\.\)\s]+/, '').trim())
                    .filter(Boolean)
                    .slice(0, 3);
            }

            // Safety: strip links/emails/phones; limit length
            const sanitize = (s) => String(s || '')
                .replace(/https?:\/\/\S+/gi, '')
                .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
                .replace(/\+?\d[\d\s-]{7,}/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 280);
            const cleaned = suggestions.map(sanitize).filter((s) => s.length >= 40).slice(0, 3);
            if (!cleaned.length) {
                throw new functions.https.HttpsError('internal', 'No suggestions produced');
            }
            return { ok: true, suggestions: cleaned, aiGenerated: true };
        } catch (e) {
            if (e instanceof functions.https.HttpsError) throw e;
            console.error('generateArtistBio error', e?.message || e);
            throw new functions.https.HttpsError('internal', 'Failed to generate bio');
        }
    });

// -------------- updateFcmToken (callable) ---------------
// Stores/updates the user's FCM token for notifications.
exports.updateFcmToken = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }
    const uid = context.auth.uid;
    const token = (data && typeof data.token === 'string') ? data.token.trim() : '';
    if (!token) {
        throw new functions.https.HttpsError('invalid-argument', 'token required');
    }
    try {
        await db.collection('users').doc(uid).set({
            fcmToken: token,
            lastTokenUpdate: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { ok: true };
    } catch (e) {
        console.error('updateFcmToken error', e);
        throw new functions.https.HttpsError('internal', 'Failed to update token');
    }
});

// -------------- markProposalCallComplete (callable) ---------------
// Marks that the required proposal call has been completed for a booking (server-authoritative record).
// Either the client or the artist on the booking may mark completion. Optionally includes duration/notes.
exports.markProposalCallComplete = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }
    const { bookingId, durationMinutes, notes } = data || {};
    if (!bookingId) {
        throw new functions.https.HttpsError('invalid-argument', 'bookingId required');
    }
    try {
        const ref = db.collection('bookings').doc(bookingId);
        const snap = await ref.get();
        if (!snap.exists) {
            throw new functions.https.HttpsError('not-found', 'Booking not found');
        }
        const booking = snap.data();
        const uid = context.auth.uid;
        if (booking.clientId !== uid && booking.artistId !== uid) {
            throw new functions.https.HttpsError('permission-denied', 'Only booking parties may mark call completion');
        }
        const updates = {
            call: {
                ...(booking.call || {}),
                completed: true,
                completedBy: uid,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                durationMinutes: typeof durationMinutes === 'number' && durationMinutes > 0 ? Math.round(durationMinutes) : (booking.call?.durationMinutes || null),
                notes: (notes && String(notes).slice(0, 500)) || (booking.call?.notes || null)
            },
            gating: {
                ...(booking.gating || {}),
                callCompleted: true
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await ref.set(updates, { merge: true });

        // Create immutable call log entry (best-effort)
        try {
            await db.collection('callLogs').add({
                bookingId,
                markedBy: uid,
                clientId: booking.clientId,
                artistId: booking.artistId,
                durationMinutes: updates.call.durationMinutes || null,
                notes: updates.call.notes || null,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                type: 'proposal_call_complete'
            });
        } catch (_) { /* ignore */ }

        return { ok: true };
    } catch (e) {
        if (e instanceof functions.https.HttpsError) throw e;
        console.error('markProposalCallComplete error', e);
        throw new functions.https.HttpsError('internal', 'Failed to mark call complete');
    }
});

// -------------- syncUserArtistRole (callable) ---------------
// On first app login, link a website-created artist (keyed by phone) to artists/{uid}
// and set users/{uid}.roles.artist.status and users/{uid}.activeRole accordingly.
exports.syncUserArtistRole = regionalFunctions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }
    const uid = context.auth.uid;
    const phoneFromAuth = context.auth.token?.phone_number || null;
    if (!phoneFromAuth) {
        // Nothing to link; user may be email-auth or missing phone
        return { ok: true, didLink: false, reason: 'no_phone' };
    }
    const phoneNorm = normalizePhone(phoneFromAuth);
    try {
        // Find artist by phone
        let sourceArtistDoc = null;
        // Prefer an exact document id match first
        const byId = await db.collection('artists').doc(phoneNorm).get();
        if (byId.exists) {
            sourceArtistDoc = { id: byId.id, data: byId.data() };
        } else {
            const snap = await db.collection('artists')
                .where('phoneNormalized', '==', phoneNorm)
                .limit(1)
                .get();
            if (!snap.empty) {
                sourceArtistDoc = { id: snap.docs[0].id, data: snap.docs[0].data() };
            }
        }

        // If nothing to link, exit
        if (!sourceArtistDoc) {
            return { ok: true, didLink: false, reason: 'no_artist_found' };
        }

        // Merge into artists/{uid} (do not overwrite non-empty fields)
        const targetRef = db.collection('artists').doc(uid);
        await db.runTransaction(async (tx) => {
            const targetSnap = await tx.get(targetRef);
            const incoming = sourceArtistDoc.data;
            const base = targetSnap.exists ? targetSnap.data() : {};
            const merged = {
                // Keep existing identification, fallback to source
                uid,
                displayName: base?.displayName || incoming?.displayName || incoming?.name || '',
                phone: phoneFromAuth,
                phoneNormalized: phoneNorm,
                email: base?.email || incoming?.email || '',
                city: base?.city || incoming?.city || '',
                primaryCategory: base?.primaryCategory || incoming?.primaryCategory || incoming?.category || '',
                categories: Array.isArray(base?.categories) && base.categories.length ? base.categories : (incoming?.categories || (incoming?.category ? [incoming.category] : [])),
                languages: Array.isArray(base?.languages) && base.languages.length ? base.languages : (incoming?.languages || []),
                bio: base?.bio || incoming?.bio || '',
                social: base?.social || (incoming?.social && Object.keys(incoming.social || {}).length ? incoming.social : null),
                profileStatus: base?.profileStatus || incoming?.profileStatus || 'submitted',
                kyc: base?.kyc || incoming?.kyc || { kycStatus: 'pending', aadhaarVerified: false },
                source: base?.source || incoming?.source || 'website_sync',
                linkedFrom: base?.linkedFrom || sourceArtistDoc.id,
                applicationId: base?.applicationId || incoming?.applicationId || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: targetSnap.exists ? (base?.createdAt || admin.firestore.FieldValue.serverTimestamp()) : admin.firestore.FieldValue.serverTimestamp()
            };
            // Ensure phoneIndex is upgraded to 'user' for this uid (best-effort)
            try {
                await txReserveOrUpgradePhone(tx, phoneNorm, { ownerType: 'user', ownerId: uid, source: 'syncUserArtistRole' });
            } catch (_ignored) { /* ignore */ }

            if (targetSnap.exists) {
                tx.update(targetRef, merged);
            } else {
                tx.set(targetRef, merged);
            }
        });

        // Update user roles and activeRole
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        const userData = userSnap.exists ? userSnap.data() : {};
        const existingRoles = new Set(rolesArrayFromData(userData));
        existingRoles.add('artist');
        const rolesMetadata = rolesMetadataFromData(userData);
        rolesMetadata.artist = {
            ...(rolesMetadata.artist || {}),
            status: 'submitted',
            linkedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'syncUserArtistRole'
        };
        const updatedRoles = Array.from(existingRoles);
        const userUpdate = {
            roles: updatedRoles,
            rolesMetadata,
            activeRole: updatedRoles.includes(userData?.activeRole)
                ? userData.activeRole
                : 'artist',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await userRef.set(userUpdate, { merge: true });

        // Optionally mark source as linked and archive stub
        try {
            const stubUpdate = {
                linkedUid: uid,
                linkedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            if (sourceArtistDoc.id !== uid) {
                stubUpdate.stubStatus = 'archived';
                stubUpdate.stubArchivedAt = admin.firestore.FieldValue.serverTimestamp();
                stubUpdate.stubMergedInto = uid;
                stubUpdate.active = false;
                stubUpdate.profileStatus = 'archived_stub';
            }
            await db.collection('artists').doc(sourceArtistDoc.id).set(stubUpdate, { merge: true });
        } catch (_) { /* ignore */ }

        return { ok: true, didLink: true, sourceId: sourceArtistDoc.id };
    } catch (e) {
        console.error('syncUserArtistRole error', e);
        throw new functions.https.HttpsError('internal', 'Failed to sync artist role');
    }
});


// -------------- cashfreeWebhook (onRequest) -----------------
// Cashfree will POST events to this endpoint. We verify signature and mark payments/bookings.
exports.cashfreeWebhook = regionalFunctions
    .runWith({ secrets: ['CASHFREE_WEBHOOK_SECRET'] })
    .https.onRequest(async (req, res) => {
        let logRef = null; // for idempotency logging updates
        try {
            // Allow Cashfree dashboard probe (usually GET/HEAD)
            if (req.method === 'GET' || req.method === 'HEAD') {
                return res.status(200).send('ok');
            }
            if (req.method !== 'POST') {
                return res.status(405).send('method not allowed');
            }
            const event = req.body || {};

            // Secure signature verification
            if (!verifyCashfreeSignature(req, CF_WEBHOOK_SECRET)) {
                console.warn('Invalid cashfree webhook signature');
                return res.status(400).send('invalid signature');
            }

            // Idempotency logging
            try {
                const eventId = event.eventId || event.id || `${Date.now()}:${Math.random()}`;
                const logged = await logWebhookAndCheckIdempotency(eventId, event, req);
                if (logged.isDuplicate) return res.status(200).send('duplicate');
                logRef = logged.logRef;
            } catch (_e) {
                console.warn('Webhook log failed, continuing:', _e.message);
            }

            // Extract fields across possible Cashfree payload shapes
            const orderObj = event.order || event.data?.order || event.data?.orderDetails || {};
            const paymentObj = event.payment || event.data?.payment || event.data?.paymentDetails || {};
            const orderId = orderObj.order_id || orderObj.orderId || event.orderId;
            const txStatus = paymentObj.payment_status || paymentObj.txStatus || event.txStatus || event.status;
            const referenceId = paymentObj.cf_payment_id || paymentObj.referenceId || event.referenceId;
            const orderAmount = Number(paymentObj.payment_amount || orderObj.order_amount || event.orderAmount || paymentObj.amount || 0);
            const _txTime = paymentObj.payment_time || paymentObj.txTime || event.txTime;

            // Find payment document by gatewayOrderId
            const paymentsSnap = await db.collection('payments').where('gatewayOrderId', '==', orderId).limit(1).get();
            if (paymentsSnap.empty) {
                console.warn('No payment record for orderId', orderId);
                return res.status(200).send('no payment record');
            }
            const paymentDocRef = paymentsSnap.docs[0].ref;
            const paymentData = paymentsSnap.docs[0].data();

            // Update on success
            if (txStatus === 'SUCCESS' || txStatus === 'SUCCESSFUL' || txStatus === 'success') {
                await paymentDocRef.update({
                    gatewayPaymentId: referenceId || paymentData.gatewayPaymentId || null,
                    amountPaid: orderAmount,
                    escrowHeld: true,
                    releaseStatus: 'held',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastWebhook: event
                });

                // update booking to 'paid'
                const bookingId = paymentData.bookingId || paymentData.bookingId || (await paymentDocRef.get()).data().bookingId;
                if (bookingId) {
                    const bookingRef = db.collection('bookings').doc(bookingId);
                    const bookingSnap = await bookingRef.get();
                    const b = bookingSnap.data() || {};
                    const bookingType = String((b.type || b.bookingType || 'gig')).toLowerCase();
                    await bookingRef.update({
                        status: 'paid',
                        paymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    // Notify user of successful payment
                    if (bookingSnap.exists) {
                        const booking = bookingSnap.data();
                        await sendNotification(booking.clientId, 'payment_success', {
                            amount: orderAmount,
                            bookingId
                        });
                    }

                    // For instant gigs, enqueue a follow-up admin task to ensure a brief on-call wrap-up is scheduled
                    if (bookingType === 'gig') {
                        try {
                            await db.collection('adminTasks').add({
                                type: 'gig_followup_call',
                                bookingId,
                                clientId: b.clientId || null,
                                artistId: b.artistId || null,
                                priority: 'low',
                                status: 'pending',
                                createdAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        } catch (e) {
                            console.warn('Failed to create follow-up admin task for gig', bookingId, e?.message || e);
                        }
                    }
                }

                // KPI: booking paid
                try { await KPIS.funnels.bookingPaid(orderAmount || 0); } catch (e) { console.warn('KPI bookingPaid failed', e?.message || e); }

                console.log('Payment success recorded for order', orderId);
                if (logRef) await logRef.update({ status: 'processed', processedAt: admin.firestore.FieldValue.serverTimestamp() });
                return res.status(200).send('ok');
            } else {
                // non-success (FAILED)
                await paymentDocRef.update({
                    releaseStatus: 'failed',
                    lastWebhook: event,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                // update booking status
                const bookingId = paymentData.bookingId;
                if (bookingId) {
                    await db.collection('bookings').doc(bookingId).update({
                        status: 'payment_failed',
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    // Notify user of failed payment
                    const bookingSnap = await db.collection('bookings').doc(bookingId).get();
                    if (bookingSnap.exists) {
                        const booking = bookingSnap.data();
                        await sendNotification(booking.clientId, 'payment_failed', {
                            amount: orderAmount,
                            bookingId
                        });
                    }
                }
                console.warn('Payment failed for order', orderId);
                if (logRef) await logRef.update({ status: 'processed', processedAt: admin.firestore.FieldValue.serverTimestamp() });
                return res.status(200).send('failed');
            }

        } catch (err) {
            console.error('cashfreeWebhook error', err);
            // Mark as failed in logs
            try {
                if (typeof logRef !== 'undefined' && logRef) {
                    await logRef.update({
                        status: 'failed',
                        error: err.message,
                        processedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            } catch (e) {
                console.warn('Failed to update webhook log status:', e.message);
            }
            return res.status(500).send('server error');
        }
    });


// -------------- cashfreePayoutWebhook (onRequest) -----------------
// Handles Cashfree Payouts webhooks for transfer status updates.
// Update payout status in payments doc and notify users/admins.
exports.cashfreePayoutWebhook = regionalFunctions
    .runWith({ secrets: ['CASHFREE_WEBHOOK_SECRET'] })
    .https.onRequest(async (req, res) => {
        try {
            // Allow Cashfree dashboard probe
            if (req.method === 'GET' || req.method === 'HEAD') {
                return res.status(200).send('ok');
            }
            if (req.method !== 'POST') {
                return res.status(405).send('method not allowed');
            }
            const event = req.body;

            // Secure signature verification
            if (!verifyCashfreeSignature(req, CF_WEBHOOK_SECRET)) {
                console.warn('Invalid payout webhook signature');
                return res.status(400).send('invalid signature');
            }

            // Payout webhook payload: { event: "TRANSFER_SUCCESS", transfer: { transferId, amount, status, beneId, referenceId } }
            const { event: _eventType, transfer } = event;
            const { transferId, status, beneId, referenceId } = transfer;

            // Find payment doc by transferId (artist payouts only)
            const paymentsSnap = await db.collection('payments')
                .where('payouts.artist.payoutId', '==', transferId)
                .limit(1).get();
            if (paymentsSnap.empty) {
                console.warn('No payment found for transferId', transferId);
                return res.status(200).send('no payment record');
            }
            const paymentRef = paymentsSnap.docs[0].ref;
            const payoutKey = 'artist';

            const paymentData = (await paymentRef.get()).data();

            // Update payout status
            const updateData = {};
            updateData[`payouts.${payoutKey}.status`] = status === 'SUCCESS' ? 'completed' : 'failed';
            updateData[`payouts.${payoutKey}.updatedAt`] = admin.firestore.FieldValue.serverTimestamp();
            if (referenceId) updateData[`payouts.${payoutKey}.cfReferenceId`] = referenceId;

            await paymentRef.update(updateData);

            // Notify user/admin
            const bookingId = paymentData.bookingId;
            const bookingSnap = await db.collection('bookings').doc(bookingId).get();
            const booking = bookingSnap.data();

            if (status === 'SUCCESS') {
                // Notify artist
                const recipientId = booking.artistId;
                await sendNotification(recipientId, 'payout_success', { amount: paymentData[`payouts.${payoutKey}.amount`], bookingId });
            } else {
                // Notify admin for failed payout
                await notifyAdmin('payout_failed', { transferId, beneId, bookingId });
            }

            console.log('Payout status updated for transfer', transferId, status);
            return res.status(200).send('ok');
        } catch (err) {
            console.error('cashfreePayoutWebhook error', err);
            return res.status(500).send('server error');
        }
    });

exports.releasePayout = regionalFunctions.firestore
    .document('bookings/{bookingId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const bookingId = context.params.bookingId;

        // Only act when status transitions to 'completed'
        if (before.status === 'completed' || after.status !== 'completed') {
            return null;
        }

        try {
            // Find payment document
            const paymentsSnap = await db.collection('payments').where('bookingId', '==', bookingId).limit(1).get();
            if (paymentsSnap.empty) {
                console.error('No payment found for booking', bookingId);
                return null;
            }
            const paymentRef = paymentsSnap.docs[0].ref;
            const paymentData = paymentsSnap.docs[0].data();

            if (!paymentData.escrowHeld) {
                console.warn('Escrow not held for booking', bookingId);
                return null;
            }

            const A = after.amount;
            const dist = computeDistribution(A);

            // Snapshot distribution to payment document
            await paymentRef.update({
                feeDistribution: dist,
                releaseRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
                releaseStatus: 'processing'
            });

            // ********** Payouts via Pub/Sub Queue **********
            const payoutJobs = [];

            // Artist payout job
            const artistId = after.artistId;
            const artistUserSnap = await db.collection('users').doc(artistId).get();
            if (!artistUserSnap.exists) {
                await paymentRef.update({ releaseStatus: 'failed', releaseError: 'artist_missing' });
                throw new Error('Artist user missing');
            }
            const artistUser = artistUserSnap.data();

            if (!artistUser.payoutBankDetails || !artistUser.payoutBankDetails.accountNumber) {
                await paymentRef.update({
                    releaseStatus: 'pending_artist_payout_info',
                    payoutSummary: { artistAmount: dist.artistNet, status: 'pending_info' }
                });
            } else {
                const artistJobData = {
                    bookingId,
                    payoutType: 'artist',
                    recipientId: artistId,
                    amount: dist.artistNet,
                    bankDetails: artistUser.payoutBankDetails,
                    transferId: `payout_artist_${bookingId}_${Date.now()}`
                };
                payoutJobs.push(artistJobData);
            }

            // No commission payouts (ambassador program removed)

            // Enqueue all payout jobs to Pub/Sub
            const enqueuedJobs = [];
            for (const jobData of payoutJobs) {
                try {
                    const messageId = await enqueuePayoutJob(jobData);
                    enqueuedJobs.push({ ...jobData, messageId, status: 'enqueued' });
                    console.log(`Enqueued ${jobData.payoutType} payout job for booking ${bookingId}`);
                } catch (err) {
                    console.error(`Failed to enqueue ${jobData.payoutType} payout job:`, err);
                    enqueuedJobs.push({ ...jobData, error: err.message, status: 'enqueue_failed' });
                }
            }

            // Write platform ledger entry
            const ledger = {
                bookingId,
                paymentId: paymentRef.id,
                platformRetained: dist.platformRetained,
                adminAmount: dist.adminAmount,
                platformFee: dist.platformFee,
                commission: dist.commission,
                gstCollectedTotal: dist.gstCollectedTotal,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('platformLedger').add(ledger);

            // Update payment document with enqueued jobs
            await paymentRef.update({
                releaseStatus: 'enqueued',
                enqueuedAt: admin.firestore.FieldValue.serverTimestamp(),
                enqueuedJobs,
                feeDistribution: dist
            });

            // Update booking with payout summary
            await db.collection('bookings').doc(bookingId).update({
                payoutSummary: {
                    artistAmount: dist.artistNet,
                    adminAmount: dist.adminAmount,
                    platformRetained: dist.platformRetained,
                    gstCollected: dist.gstCollectedTotal
                },
                payoutEnqueuedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`Enqueued ${enqueuedJobs.length} payout jobs for booking ${bookingId}`);
        } catch (err) {
            console.error('releasePayout error', err);
            // Update payment status to failed
            try {
                const paymentsSnap = await db.collection('payments').where('bookingId', '==', bookingId).limit(1).get();
                if (!paymentsSnap.empty) {
                    await paymentsSnap.docs[0].ref.update({
                        releaseStatus: 'failed',
                        releaseError: err.message,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            } catch (updateErr) {
                console.error('Failed to update payment status:', updateErr);
            }
        }

        return null;
    });

// ********** Pub/Sub Payout Worker **********
// Background function to process payout jobs from Pub/Sub queue
exports.processPayoutWorker = regionalFunctions.pubsub
    .topic(PAYOUT_TOPIC)
    .onPublish(async (message, _context) => {
        try {
            const jobData = JSON.parse(Buffer.from(message.data, 'base64').toString());
            console.log('Received payout job:', jobData);

            await processPayoutJob(jobData);

            console.log('Payout job processed successfully');
        } catch (error) {
            console.error('Payout worker error:', error);
            throw error;
        }
    });

// Ambassador management removed

// Commission payout callables removed

// ********** Notification Utilities **********
async function sendNotification(userId, type, data) {
    try {
        const userSnap = await db.collection('users').doc(userId).get();
        if (!userSnap.exists) return;

        const user = userSnap.data();
        const title = getNotificationTitle(type);
        const body = getNotificationBody(type, data);

        const channels = [];

        // Send FCM notification
        if (user.fcmToken) {
            const message = {
                token: user.fcmToken,
                notification: {
                    title,
                    body
                },
                data: {
                    type,
                    ...data
                }
            };
            await admin.messaging().send(message);
            channels.push('fcm');
        }

        // Send email if user has email
        if (user.email && SENDGRID_API_KEY !== '<SENDGRID_API_KEY>') {
            if (!sgMail.apiKey) sgMail.setApiKey(SENDGRID_API_KEY);
            const msg = {
                to: user.email,
                from: SENDGRID_FROM, // verified sender
                subject: title,
                text: body,
                html: `<strong>${body}</strong>`
            };
            await sgMail.send(msg);
            channels.push('email');
        }

        // Log notification
        await db.collection('notifications').add({
            userId,
            type,
            data,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            channels
        });

    } catch (err) {
        console.error('sendNotification error', err);
    }
}

// SMS helpers removed: no general SMS channel is used now.

function getNotificationTitle(type) {
    switch (type) {
        case 'payout_success': return 'Payout Successful';
        case 'refund_initiated': return 'Refund Initiated';
        case 'booking_confirmed': return 'Booking Confirmed';
        case 'payment_success': return 'Payment Successful';
        case 'payment_failed': return 'Payment Failed';
        case 'dispute_created': return 'Payment Dispute';
        default: return 'Notification';
    }
}

function getNotificationBody(type, data) {
    switch (type) {
        case 'payout_success': return `₹${data.amount} has been credited to your account for booking ${data.bookingId}`;
        case 'refund_initiated': return `Refund of ₹${data.amount} initiated for booking ${data.bookingId}`;
        case 'booking_confirmed': return `Your booking ${data.bookingId} has been confirmed`;
        case 'payment_success': return `Payment of ₹${data.amount} received successfully for booking ${data.bookingId}`;
        case 'payment_failed': return `Payment failed for booking ${data.bookingId}. Please try again.`;
        case 'dispute_created': return `A dispute has been raised for your payment on booking ${data.bookingId}`;
        default: return 'You have a new notification';
    }
}

// ********** Admin Refund Function **********
exports.refundBooking = regionalFunctions.https.onCall(async (data, context) => {
    // Only allow authenticated admins
    if (!context.auth) {
        throw new functions.https.HttpsError('permission-denied', 'Authentication required');
    }

    const callerUid = context.auth.uid;
    const callerPhone = context.auth.token?.phone_number || null;
    const callerEmail = context.auth.token?.email || null;

    // Check user role - only admin can refund bookings
    const userRole = await adminApi.checkUserRole(callerUid, callerPhone, callerEmail);
    if (userRole.role !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Only admin can refund bookings.');
    }

    const { bookingId, reason } = data;
    if (!bookingId) {
        throw new functions.https.HttpsError('invalid-argument', 'bookingId required');
    }

    try {
        const bookingRef = db.collection('bookings').doc(bookingId);
        const bookingSnap = await bookingRef.get();

        if (!bookingSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'Booking not found');
        }

        const booking = bookingSnap.data();

        if (booking.status !== 'confirmed') {
            throw new functions.https.HttpsError('failed-precondition', 'Only confirmed bookings can be refunded');
        }

        // Get payment details
        const paymentsSnap = await db.collection('payments').where('bookingId', '==', bookingId).limit(1).get();
        if (paymentsSnap.empty) {
            throw new functions.https.HttpsError('not-found', 'Payment not found');
        }
        const paymentRef = paymentsSnap.docs[0].ref;
        const payment = paymentsSnap.docs[0].data();

        // Check if refund already initiated
        if (payment.refundStatus) {
            throw new functions.https.HttpsError('already-exists', 'Refund already initiated');
        }

        // Initiate refund via Cashfree
        const refundPayload = {
            refund_amount: payment.amountPaid.toString(),
            refund_id: `refund_${bookingId}_${Date.now()}`,
            refund_note: reason || 'Admin initiated refund'
        };

        const refundResult = await callCashfreeAPI(`/api/v2/payments/${payment.gatewayPaymentId}/refunds`, refundPayload, 'POST');

        // Update payment doc
        await paymentRef.update({
            refundStatus: 'initiated',
            refundId: refundResult.refund_id,
            refundAmount: refundResult.refund_amount,
            refundInitiatedAt: admin.firestore.FieldValue.serverTimestamp(),
            refundReason: reason,
            refundProcessedBy: context.auth.uid
        });

        // Update booking status
        await bookingRef.update({
            status: 'refunded',
            refundedBy: context.auth.uid,
            refundedAt: admin.firestore.FieldValue.serverTimestamp(),
            refundReason: reason || 'Admin initiated refund',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return { success: true, refundId: refundResult.refund_id };
    } catch (error) {
        console.error('refundBooking error:', error);
        throw new functions.https.HttpsError('internal', 'Failed to initiate refund');
    }
});

// ********** Dispute Management **********
exports.cashfreeDisputeWebhook = regionalFunctions
    .runWith({ secrets: ['CASHFREE_WEBHOOK_SECRET'] })
    .https.onRequest(async (req, res) => {
        try {
            // Allow Cashfree dashboard probe
            if (req.method === 'GET' || req.method === 'HEAD') {
                return res.status(200).send('ok');
            }
            if (req.method !== 'POST') {
                return res.status(405).send('method not allowed');
            }
            const event = req.body;

            // Secure signature verification
            if (!verifyCashfreeSignature(req, CF_WEBHOOK_SECRET)) {
                console.warn('Invalid dispute webhook signature');
                return res.status(400).send('invalid signature');
            }

            const { type, data } = event;
            const dispute = data.dispute || data;

            // Find payment by orderId
            const orderId = dispute.order_id || dispute.orderId;
            const paymentsSnap = await db.collection('payments').where('gatewayOrderId', '==', orderId).limit(1).get();
            if (paymentsSnap.empty) {
                console.warn('No payment found for dispute orderId', orderId);
                return res.status(200).send('no payment record');
            }
            const paymentRef = paymentsSnap.docs[0].ref;
            const paymentData = paymentsSnap.docs[0].data();

            // Update dispute status
            await paymentRef.update({
                disputeStatus: type,
                disputeData: dispute,
                disputeUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Log dispute
            await db.collection('disputes').add({
                paymentId: paymentRef.id,
                bookingId: paymentData.bookingId,
                type,
                data: dispute,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Notify user of dispute
            const bookingSnap = await db.collection('bookings').doc(paymentData.bookingId).get();
            if (bookingSnap.exists) {
                const booking = bookingSnap.data();
                await sendNotification(booking.clientId, 'dispute_created', {
                    bookingId: paymentData.bookingId,
                    disputeId: dispute.dispute_id
                });
            }

            // Notify admin
            await notifyAdmin('dispute_created', { orderId, type, disputeId: dispute.dispute_id });

            console.log('Dispute recorded', type, orderId);
            return res.status(200).send('ok');
        } catch (err) {
            console.error('cashfreeDisputeWebhook error', err);
            return res.status(500).send('server error');
        }
    });

// Helper: notify admin (for disputes, failed payouts)
async function notifyAdmin(type, data) {
    try {
        const adminUids = new Set();

        // Legacy single role field
        const roleSnap = await db.collection('users').where('role', '==', 'admin').get();
        roleSnap.forEach(doc => adminUids.add(doc.id));

        // Preferred roles array
        const rolesSnap = await db.collection('users').where('roles', 'array-contains', 'admin').get();
        rolesSnap.forEach(doc => adminUids.add(doc.id));

        // Admins collection
        const adminsCol = await db.collection('admins').get();
        adminsCol.forEach(doc => adminUids.add(doc.id));

        for (const uid of adminUids) {
            await sendNotification(uid, type, data);
        }
    } catch (err) {
        console.error('notifyAdmin error', err);
    }
}

// ********** Test Pub/Sub Payout Queue **********
exports.testPayoutQueue = regionalFunctions.https.onCall(async (data, context) => {
    // Allow authenticated users for testing
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { bookingId, payoutType, recipientId, amount } = data;
    if (!bookingId || !payoutType || !recipientId || !amount) {
        throw new functions.https.HttpsError('invalid-argument', 'bookingId, payoutType, recipientId, and amount required');
    }

    try {
        // Get user bank details for testing
        const userSnap = await db.collection('users').doc(recipientId).get();
        if (!userSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'Recipient user not found');
        }
        const user = userSnap.data();

        if (!user.payoutBankDetails || !user.payoutBankDetails.accountNumber) {
            throw new functions.https.HttpsError('failed-precondition', 'Recipient has no payout bank details');
        }

        // Create test payout job
        const testJobData = {
            bookingId,
            payoutType,
            recipientId,
            amount: parseFloat(amount),
            bankDetails: user.payoutBankDetails,
            transferId: `test_payout_${payoutType}_${bookingId}_${Date.now()}`
        };

        // Enqueue the job
        const messageId = await enqueuePayoutJob(testJobData);

        return {
            success: true,
            messageId,
            jobData: testJobData,
            message: `Payout job enqueued successfully for ${payoutType} payout`
        };

    } catch (err) {
        console.error('testPayoutQueue error', err);
        throw new functions.https.HttpsError('internal', 'Test payout queue failed');
    }
});

// ********** Artist Registration Workflow **********
// Cloud Function triggered when artist profile status changes to 'submitted'
exports.onArtistProfileSubmitted = regionalFunctions.firestore
    .document('artists/{artistId}')
    .onUpdate(async (change, context) => {
        const artistId = context.params.artistId;
        const beforeData = change.before.data();
        const afterData = change.after.data();

        // Only trigger when profileStatus changes to 'submitted'
        if (beforeData?.profileStatus !== 'submitted' && afterData?.profileStatus === 'submitted') {
            console.log(`Artist ${artistId} submitted profile for verification`);

            try {
                const db = admin.firestore();
                const batch = db.batch();

                // 1. Create admin task
                const adminTaskRef = db.collection('adminTasks').doc();
                batch.set(adminTaskRef, {
                    type: 'verify_artist_profile',
                    artistId: artistId,
                    artistName: afterData.displayName || 'Unknown Artist',
                    artistEmail: afterData.email || '',
                    artistPhone: afterData.phone || '',
                    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'pending', // pending | in_review | approved | rejected
                    priority: 'normal', // normal | high | urgent
                    assignedTo: null, // admin user ID
                    notes: '',
                    kycRequired: !!(afterData.kyc?.panNumberMasked),
                    payoutRequired: !!(afterData.payouts?.upi),
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // 2. Referral commission setup removed with ambassador program

                // 3. Create audit log entry
                const auditRef = db.collection('auditLogs').doc();
                batch.set(auditRef, {
                    action: 'artist_profile_submitted',
                    actorId: artistId,
                    actorType: 'artist',
                    targetId: artistId,
                    targetType: 'artist',
                    details: {
                        profileStatus: 'submitted',
                        hasKyc: !!(afterData.kyc?.panNumberMasked),
                        hasPayout: !!(afterData.payouts?.upi),
                        referralCode: null
                    },
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    ipAddress: null, // Add if you track IP
                    userAgent: null // Add if you track user agent
                });

                // Commit all changes
                await batch.commit();
                console.log(`Successfully processed artist profile submission for ${artistId}`);

            } catch (error) {
                console.error(`Error processing artist profile submission for ${artistId}:`, error);

                // Create error log
                try {
                    await admin.firestore().collection('errorLogs').add({
                        function: 'onArtistProfileSubmitted',
                        artistId: artistId,
                        error: error.message,
                        stack: error.stack,
                        data: { before: beforeData, after: afterData },
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                } catch (logError) {
                    console.error('Failed to log error:', logError);
                }

                // Re-throw to mark function as failed
                throw error;
            }
        }

        return null;
    });

// Referral code validation removed with ambassador program

// ********** Migration Function **********
// Callable function to migrate artistProfiles to artists collection
exports.migrateArtistProfiles = regionalFunctions.https.onCall(async (data, context) => {
    // Only allow authenticated admin users
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const callerUid = context.auth.uid;
    const callerPhone = context.auth.token?.phone_number || null;

    // Check admin status using the new function
    const userRole = await adminApi.checkUserRole(callerUid, callerPhone);
    if (userRole.role !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }

    const { dryRun = true, limit = 500 } = data || {};

    try {
        const db = admin.firestore();
        const batch = db.batch();

        console.log('Starting migration. dryRun=', dryRun, 'limit=', limit);

        // Get artistProfiles
        const artistProfilesSnapshot = await db.collection('artistProfiles').limit(limit).get();

        if (artistProfilesSnapshot.empty) {
            return { message: 'No artistProfiles found to migrate', count: 0 };
        }

        let migratedCount = 0;
        let skippedCount = 0;

        for (const doc of artistProfilesSnapshot.docs) {
            const oldData = doc.data();
            const artistId = doc.id;

            // Check if artist already exists in new collection
            const existingArtist = await db.collection('artists').doc(artistId).get();
            if (existingArtist.exists) {
                console.log(`Skipping ${artistId} - already exists in artists collection`);
                skippedCount++;
                continue;
            }

            // Map old data structure to new unified structure
            const newArtistData = {
                uid: oldData.userId || artistId,
                displayName: oldData.displayName || '',
                email: oldData.email || '', // May not exist in old structure
                phone: oldData.phone || '',
                whatsapp: oldData.whatsapp || oldData.phone || '',
                bio: oldData.bio || '',
                primaryCategory: oldData.categories?.[0] || oldData.category || '',
                categories: oldData.categories || [],
                hourlyRate: oldData.hourlyRate || 0,
                baseRate: oldData.hourlyRate || 0,
                city: oldData.city || '',
                languages: oldData.languages || [],
                availability: oldData.availability || '',
                experience: oldData.experience || '',
                portfolio: oldData.portfolio || [],
                profileImage: oldData.profileImage || '',
                // Set KYC status based on whether they were verified
                kyc: {
                    panNumberMasked: oldData.panNumber ? maskPanNumber(oldData.panNumber) : '',
                    idType: oldData.idType || '',
                    kycStatus: oldData.verifiedByAdmin ? 'verified' : 'pending',
                },
                payouts: {
                    upi: oldData.upiId || '',
                },
                // Set profile status based on verification
                profileStatus: oldData.verifiedByAdmin ? 'verified' : 'incomplete',
                verifiedAt: oldData.verifiedByAdmin ? oldData.updatedAt || admin.firestore.FieldValue.serverTimestamp() : null,
                verifiedBy: oldData.verifiedByAdmin ? 'migration_admin' : null,
                createdAt: oldData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                migratedFrom: 'artistProfiles',
                migrationDate: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (!dryRun) {
                // Add to batch
                const newArtistRef = db.collection('artists').doc(artistId);
                batch.set(newArtistRef, newArtistData);
            }

            migratedCount++;
            console.log(`${dryRun ? 'DRY:' : 'MIGRATE:'} artist ${artistId} (${oldData.displayName})`);
        }

        if (!dryRun) {
            // Commit the batch
            await batch.commit();

            // Create migration log
            await db.collection('migrationLogs').add({
                type: 'artistProfiles_to_artists',
                migratedCount: migratedCount,
                skippedCount: skippedCount,
                totalProcessed: artistProfilesSnapshot.size,
                executedBy: context.auth.uid,
                executedAt: admin.firestore.FieldValue.serverTimestamp(),
                status: 'completed'
            });
        }

        return {
            message: dryRun ? 'Dry run completed' : 'Migration completed successfully',
            stats: {
                totalFound: artistProfilesSnapshot.size,
                migrated: migratedCount,
                skipped: skippedCount,
                dryRun: dryRun
            }
        };

    } catch (error) {
        console.error('Migration error:', error);
        throw new functions.https.HttpsError('internal', `Migration failed: ${error.message}`);
    }
});

// Helper function to mask PAN number
function maskPanNumber(pan) {
    if (!pan || pan.length < 10) return pan;
    return 'XXXXXX' + pan.substring(pan.length - 4);
}

// ********** Admin Artist Verification Function **********
// Note: Using improved version from adminApi.js

// Removed duplicate simple adminApi export block (consolidated below)

// Basic health check for monitoring service status
exports.health = regionalFunctions.https.onRequest(async (req, res) => {
    try {
        // Check Firestore connectivity
        const testDoc = await db.collection('health').doc('test').get();

        // Check Firebase Auth
        const authStatus = admin.auth ? 'ok' : 'error';

        // Check environment variables
        const envStatus = {
            cashfreeConfigured: CF_CLIENT_ID !== '<CASHFREE_CLIENT_ID>',
            sendgridConfigured: SENDGRID_API_KEY !== '<SENDGRID_API_KEY>'
        };

        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                firestore: testDoc.exists ? 'ok' : 'ok', // Firestore query successful
                firebaseAuth: authStatus,
                cashfree: envStatus.cashfreeConfigured ? 'configured' : 'not_configured',
                sendgrid: envStatus.sendgridConfigured ? 'configured' : 'not_configured'
            },
            uptime: process.uptime(),
            memory: process.memoryUsage()
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

// ********** Artist Verification API **********

// Initiate artist verification process
exports.initiateArtistVerification = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }

    try {
        const { artistId, artistData } = data;
        const result = await ArtistVerificationService.initiateVerification(artistId, artistData);
        return result;
    } catch (error) {
        console.error('Error initiating verification:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// Upload verification document
exports.uploadVerificationDocument = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }

    try {
        const { verificationId, documentType, documentData } = data;
        const result = await ArtistVerificationService.uploadDocument(verificationId, documentType, documentData);
        return result;
    } catch (error) {
        console.error('Error uploading document:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// Review verification (Admin only)
exports.reviewArtistVerification = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }

    // Check admin permissions
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }

    try {
        const { verificationId, reviewData } = data;
        const result = await ArtistVerificationService.reviewVerification(
            verificationId,
            context.auth.uid,
            reviewData
        );
        return result;
    } catch (error) {
        console.error('Error reviewing verification:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// Get verification status
exports.getArtistVerificationStatus = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }

    try {
        const { artistId } = data;
        const result = await ArtistVerificationService.getVerificationStatus(artistId);
        return result;
    } catch (error) {
        console.error('Error getting verification status:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// Allow app to update FCM token
exports.updateFcmToken = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }
    const { token } = data || {};
    if (!token || typeof token !== 'string' || token.length < 20) {
        throw new functions.https.HttpsError('invalid-argument', 'Valid token required');
    }
    try {
        const userRef = db.collection('users').doc(context.auth.uid);
        await userRef.set({ fcmToken: token, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true };
    } catch (e) {
        console.error('updateFcmToken error', e);
        throw new functions.https.HttpsError('internal', 'Failed to update token');
    }
});

// ========================
// Artist Daily Metrics
// ========================

function formatDateKeyIST(date = new Date()) {
    // Convert to IST (UTC+5:30) for business day bucketing
    const utc = date.getTime() + date.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 330 * 60000);
    return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Increment daily count on artist create
exports.onArtistCreatedDailyMetric = regionalFunctions.firestore
    .document('artists/{artistId}')
    .onCreate(async (snap, _ctx) => {
        try {
            const data = snap.data() || {};
            // Skip metrics increment for migration/alias copies
            if (data.migrated === true || (typeof data.source === 'string' && data.source.startsWith('migration'))) {
                return null;
            }
            const key = formatDateKeyIST(new Date());
            const ref = db.collection('metrics').doc('artistDaily');
            await ref.set({ [key]: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch (e) {
            console.error('onArtistCreatedDailyMetric failed', e);
        }
        return null;
    });

// Rebuild last 60 days metrics hourly for consistency
exports.rebuildArtistDailyMetrics = regionalFunctions.pubsub
    .schedule('every 1 hours')
    .timeZone('Asia/Kolkata')
    .onRun(async () => {
        try {
            const now = new Date();
            const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days
            const snap = await db.collection('artists').where('createdAt', '>=', cutoff).get();
            const counts = {};
            snap.forEach(doc => {
                const d = doc.data();
                let created = d.createdAt?.toDate ? d.createdAt.toDate() : (d.createdAt instanceof Date ? d.createdAt : null);
                if (!created) created = new Date();
                const key = formatDateKeyIST(created);
                counts[key] = (counts[key] || 0) + 1;
            });
            const ref = db.collection('metrics').doc('artistDaily');
            await ref.set({ ...counts, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: false });
            console.log('rebuildArtistDailyMetrics updated keys:', Object.keys(counts).length);
        } catch (e) {
            console.error('rebuildArtistDailyMetrics error', e);
        }
        return null;
    });

// ========================
// Backfill: Submitted Applications -> Artists
// ========================
exports.backfillArtistsFromSubmittedApplications = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Auth required');
    const callerUid = context.auth.uid;
    const callerPhone = context.auth.token?.phone_number || null;
    const roleInfo = await adminApi.checkUserRole(callerUid, callerPhone);
    if (roleInfo.role !== 'admin') throw new functions.https.HttpsError('permission-denied', 'Admin only');
    const limit = Math.min(Number(data?.limit || 500), 1000);
    try {
        // Fetch submitted/in_review/rejected (anything not approved) plus approved (safe skip on exists)
        const statuses = ['submitted', 'in_review', 'rejected', 'approved'];
        let created = 0, skipped = 0;
        for (const chunk of [statuses.slice(0, 3), statuses.slice(3)]) {
            const qSnap = await db.collection('artistApplications')
                .where('status', 'in', chunk)
                .limit(limit)
                .get();
            for (const docSnap of qSnap.docs) {
                const app = docSnap.data();
                const artistId = app.userId || app.uid || normalizePhone(app.phone || app.phoneNormalized) || docSnap.id;
                if (!artistId) { skipped++; continue; }
                const ref = db.collection('artists').doc(artistId);
                const exists = await ref.get();
                if (exists.exists) { skipped++; continue; }
                await ref.set({
                    uid: artistId,
                    displayName: app.displayName || app.name || '',
                    phone: app.phone || app.phoneNormalized || '',
                    phoneNormalized: normalizePhone(app.phone || app.phoneNormalized || ''),
                    email: app.email || '',
                    city: app.city || '',
                    primaryCategory: app.category || '',
                    categories: app.category ? [app.category] : [],
                    languages: Array.isArray(app.languages) ? app.languages : [],
                    bio: app.bio || '',
                    social: app.social && typeof app.social === 'object' && Object.keys(app.social).length ? sanitizeSocial(app.social) : null,
                    profileStatus: 'submitted',
                    kyc: { kycStatus: 'pending', aadhaarVerified: false },
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    source: 'backfill_application_submitted',
                    applicationId: docSnap.id
                });
                created++;
            }
        }
        return { created, skipped };
    } catch (e) {
        console.error('backfillArtistsFromSubmittedApplications error', e);
        throw new functions.https.HttpsError('internal', 'Backfill failed');
    }
});

// ========================
// Admin: Standardize Artist IDs to Phone
// ========================
exports.adminStandardizeArtistIdsToPhone = regionalFunctions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Auth required');
    const callerUid = context.auth.uid;
    const callerPhone = context.auth.token?.phone_number || null;
    const roleInfo = await adminApi.checkUserRole(callerUid, callerPhone);
    if (roleInfo.role !== 'admin') throw new functions.https.HttpsError('permission-denied', 'Admin only');
    const limit = Math.min(Number(data?.limit || 500), 2000);
    try {
        const snap = await db.collection('artists').limit(limit).get();
        let migrated = 0, aliased = 0, skipped = 0;
        for (const docSnap of snap.docs) {
            const oldId = docSnap.id;
            const a = docSnap.data();
            const phoneNorm = normalizePhone(a.phone || a.phoneNormalized || '');
            if (!phoneNorm || oldId === phoneNorm) { skipped++; continue; }
            const targetRef = db.collection('artists').doc(phoneNorm);
            const targetSnap = await targetRef.get();
            if (targetSnap.exists) { skipped++; continue; }
            const dataCopy = { ...a, uid: phoneNorm, phone: a.phone || phoneNorm, phoneNormalized: phoneNorm, migrated: true, source: 'migration_id_standardize', updatedAt: admin.firestore.FieldValue.serverTimestamp() };
            await targetRef.set(dataCopy, { merge: false });
            aliased++;
            await docSnap.ref.set({ migratedToId: phoneNorm, alias: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            migrated++;
            // Optional alias map
            await db.collection('artistAliases').doc(oldId).set({ newId: phoneNorm, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        }
        return { migrated, aliased, skipped, scanned: snap.size };
    } catch (e) {
        console.error('adminStandardizeArtistIdsToPhone error', e);
        throw new functions.https.HttpsError('internal', 'Standardization failed');
    }
});

// ========================
// Security Functions
// ========================

// Import security functions
const securityFunctions = require('./src/securityFunctions');

// Export security functions
exports.dataRetentionCleanup = securityFunctions.dataRetentionCleanup;
exports.securityAudit = securityFunctions.securityAudit;
exports.adminGetSecurityDashboard = securityFunctions.adminGetSecurityDashboard;
exports.adminManualDataCleanup = securityFunctions.adminManualDataCleanup;
exports.adminSecurityActions = securityFunctions.adminSecurityActions;
exports.getUserSecurityStatus = securityFunctions.getUserSecurityStatus;
exports.onSecurityFlagAdded = securityFunctions.onSecurityFlagAdded;

// ========================
// Admin API Functions
// ========================

// Export existing admin functions
exports.addAdminUser = adminApi.addAdminUser;
exports.getUserRole = adminApi.getUserRole;
exports.createArtistProfile = adminApi.createArtistProfile;
exports.updateArtistProfile = adminApi.updateArtistProfile;
exports.removeAdminUser = adminApi.removeAdminUser;
exports.adminDeactivateUser = adminApi.adminDeactivateUser;
exports.adminBulkDeactivate = adminApi.adminBulkDeactivate;
exports.adminMarkFlagReviewed = adminApi.adminMarkFlagReviewed;
exports.addAuditorUser = adminApi.addAuditorUser;
exports.approveAuditor = adminApi.approveAuditor;
exports.adminResolveDispute = adminApi.adminResolveDispute;
exports.getPlatformKPIs = adminApi.getPlatformKPIs;
exports.getOperationalMetrics = adminApi.getOperationalMetrics;
exports.adminLinkApplicationToTask = adminApi.adminLinkApplicationToTask;
exports.adminReviewArtistApplication = adminApi.adminReviewArtistApplication;
exports.adminVerifyArtistProfile = adminApi.adminVerifyArtistProfile;
exports.normalizeUserRoles = adminApi.normalizeUserRoles;
exports.adminLinkArtistByPhone = adminApi.adminLinkArtistByPhone;
exports.checkUserRole = adminApi.checkUserRole;

// Storage Optimization Functions
try {
    const storageOptimization = require('./src/storageOptimization');
    exports.optimizePortfolioImage = storageOptimization.optimizePortfolioImage;
    exports.manageStorageBackups = storageOptimization.manageStorageBackups;
    exports.generateStorageReport = storageOptimization.generateStorageReport;
    exports.invalidateCDNCache = storageOptimization.invalidateCDNCache;
} catch (e) {
    console.warn('storageOptimization module unavailable, skipping related exports:', e?.message || e);
}

// ========================
// Wallet Functions
// ========================
// Expose wallet callables and scheduled jobs
exports.grantFirstBookingCredit = wallet.grantFirstBookingCredit;
exports.grantReferralBonus = wallet.grantReferralBonus;
exports.applyWalletCredits = wallet.applyWalletCredits;
exports.processRefundToWallet = wallet.processRefundToWallet;
exports.getWalletStatistics = wallet.getWalletStatistics;
exports.expireStaleCredits = wallet.expireStaleCredits;

// ========================
// Organization Functions
// ========================
const orgs = require('./src/orgs');
exports.createOrg = orgs.createOrg;
exports.inviteMember = orgs.inviteMember;
exports.setMemberRole = orgs.setMemberRole;
exports.removeMember = orgs.removeMember;
