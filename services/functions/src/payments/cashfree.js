'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const {
    PAYOUT_STAGE1_DELAY_HOURS,
    PAYOUT_STAGE2_DELAY_HOURS,
    DISPUTE_WINDOW_HOURS,
    REQUIRE_PAN_FOR_PAYOUT,
    ECO_TCS_RATE,
    ECO_TCS_BORNE_BY_PLATFORM,
    ESCROW_FEE_RATE,
    roundInr,
    deriveFyTurnover,
    computeTdsForPayout,
} = require('../config/settlementPolicy');

const BOOKINGS_COLLECTION = 'bookings';
const PAYMENTS_COLLECTION = 'payments';
const WEBHOOK_LOGS_COLLECTION = 'webhookLogs';
const DISPUTES_COLLECTION = 'disputes';
const PLATFORM_LEDGER_COLLECTION = 'platformLedger';
const PAYOUT_TRANSFERS_COLLECTION = 'payout_transfers';

const CASHFREE_ORDER_PREFIX = 'kalaqaar';

const PAYMENT_SUCCESS_STATUSES = new Set(['success', 'successful', 'success_webhook', 'payment_success', 'payment_success_webhook', 'payment_success_webhook_v2']);
const PAYMENT_FAILURE_STATUSES = new Set(['failed', 'failure', 'payment_failed', 'payment_failure_webhook', 'cancelled']);

// V1 (locked): payout/dispute timings are sourced from config/settlementPolicy.js.

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function buildConfig() {
    const environmentRaw = process.env.CASHFREE_ENVIRONMENT || process.env.CASHFREE_ENV || '';
    const sandboxFlag = process.env.CASHFREE_SANDBOX;
    const mockFlag = process.env.CASHFREE_MOCK;

    const isSandbox = parseBoolean(sandboxFlag, true);
    const environment = environmentRaw
        ? String(environmentRaw).toUpperCase()
        : (isSandbox ? 'SANDBOX' : 'PRODUCTION');

    const clientId = process.env.CASHFREE_CLIENT_ID || '';
    const clientSecret = process.env.CASHFREE_CLIENT_SECRET || '';
    const payoutClientId = process.env.CASHFREE_PAYOUT_CLIENT_ID || clientId;
    const payoutClientSecret = process.env.CASHFREE_PAYOUT_CLIENT_SECRET || clientSecret;
    const webhookSecret = process.env.CASHFREE_WEBHOOK_SECRET || '';
    const apiVersion = process.env.CASHFREE_API_VERSION || '2022-09-01';

    const pgBaseUrl = environment === 'PRODUCTION' || environment === 'LIVE' || environment === 'PROD'
        ? 'https://api.cashfree.com'
        : 'https://sandbox.cashfree.com';
    const payoutBaseUrl = environment === 'PRODUCTION' || environment === 'LIVE' || environment === 'PROD'
        ? 'https://payout-api.cashfree.com'
        : 'https://payout-gamma.cashfree.com';

    return {
        environment,
        isSandbox,
        mock: parseBoolean(mockFlag, false),
        clientId,
        clientSecret,
        payoutClientId,
        payoutClientSecret,
        webhookSecret,
        apiVersion,
        pgBaseUrl,
        payoutBaseUrl,
    };
}

function toCompactJson(payload) {
    try {
        return JSON.stringify(payload);
    } catch (_) {
        return '';
    }
}

function normalizeIdentityName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function identitySimilarityPercent(left, right) {
    const a = normalizeIdentityName(left);
    const b = normalizeIdentityName(right);
    if (!a || !b) return 0;
    if (a === b) return 100;
    const aTokens = new Set(a.split(' ').filter(Boolean));
    const bTokens = new Set(b.split(' ').filter(Boolean));
    if (!aTokens.size || !bTokens.size) return 0;
    let overlap = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) overlap += 1;
    }
    const score = (2 * overlap) / (aTokens.size + bTokens.size);
    return Math.round(score * 100);
}

function evaluateIdentityMatch({ profile, userData }) {
    const thresholdScore = Number(process.env.IDENTITY_MATCH_MIN_SCORE || '70');
    const thresholdSimilarity = Number(process.env.IDENTITY_MATCH_MIN_SIMILARITY || '70');
    const kyc = (profile && profile.kyc && typeof profile.kyc === 'object') ? profile.kyc : {};
    const overrideApproved =
        kyc.identityOverrideApproved === true ||
        profile.identityOverrideApproved === true ||
        userData.identityOverrideApproved === true;
    if (overrideApproved) {
        return { passed: true, reason: 'identity_override', thresholdScore, thresholdSimilarity };
    }

    const registeredName =
        profile.legalName ||
        profile.displayName ||
        profile.businessName ||
        userData.displayName ||
        userData.name ||
        userData.fullName ||
        null;
    const panName = kyc.panName || kyc.verifiedPanName || null;
    const upiName = kyc.upiName || kyc.vpaName || null;
    const bankName = kyc.bankAccountHolderName || userData?.payoutBankDetails?.name || null;

    const numericCandidates = [
        Number(kyc.nameMatchPanProfile),
        Number(kyc.nameMatchUpiProfile),
        Number(kyc.nameMatchUpiPan),
        Number(kyc.upiNameMatch),
    ].filter((n) => Number.isFinite(n));
    const bestNumericScore = numericCandidates.length ? Math.max(...numericCandidates) : null;
    if (bestNumericScore !== null) {
        if (bestNumericScore >= thresholdScore) {
            return {
                passed: true,
                reason: 'identity_score_threshold',
                thresholdScore,
                thresholdSimilarity,
                bestNumericScore,
            };
        }
        return {
            passed: false,
            reason: 'identity_score_below_threshold',
            thresholdScore,
            thresholdSimilarity,
            bestNumericScore,
            registeredName,
            panName,
            upiName,
            bankName,
        };
    }

    const comparisons = [
        { source: 'pan', value: panName },
        { source: 'upi', value: upiName },
        { source: 'bank', value: bankName },
    ].filter((x) => x.value);
    if (!registeredName || comparisons.length === 0) {
        return {
            passed: false,
            reason: 'identity_data_missing',
            thresholdScore,
            thresholdSimilarity,
            registeredName,
            panName,
            upiName,
            bankName,
        };
    }

    let bestSimilarity = 0;
    let bestSource = null;
    for (const item of comparisons) {
        const score = identitySimilarityPercent(registeredName, item.value);
        if (score > bestSimilarity) {
            bestSimilarity = score;
            bestSource = item.source;
        }
    }
    if (bestSimilarity >= thresholdSimilarity) {
        return {
            passed: true,
            reason: 'identity_similarity_threshold',
            thresholdScore,
            thresholdSimilarity,
            bestSimilarity,
            bestSource,
        };
    }
    return {
        passed: false,
        reason: 'identity_similarity_below_threshold',
        thresholdScore,
        thresholdSimilarity,
        bestSimilarity,
        bestSource,
        registeredName,
        panName,
        upiName,
        bankName,
    };
}

module.exports = function buildCashfreeIntegration({
    admin,
    functions,
    fetch,
    db,
    pubsub,
    adminApi,
    computeDistribution,
    applyAutoPromoSpend,
    sendNotification,
    notifyAdmin,
    KPIS,
    payoutTopicName = 'kalaqaar-payouts',
}) {
    const FieldValue = admin.firestore.FieldValue;
    const config = buildConfig();

    function asDate(value) {
        if (!value) return null;
        if (value instanceof Date) return value;
        if (typeof value.toDate === 'function') {
            try { return value.toDate(); } catch (_) { return null; }
        }
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    async function resolvePartnerIdByReferralCode(referralCode) {
        const code = String(referralCode || '').trim().toUpperCase();
        if (!code) return null;
        try {
            const docSnap = await db.collection('referralCodes').doc(code).get();
            if (docSnap.exists) {
                const d = docSnap.data() || {};
                if (String(d.status || '').toLowerCase() === 'active' && d.partnerId) return String(d.partnerId);
            }
        } catch (_) {}
        try {
            const q = await db.collection('referralCodes').where('code', '==', code).where('status', '==', 'active').limit(1).get();
            if (!q.empty) {
                const d = q.docs[0].data() || {};
                if (d.partnerId) return String(d.partnerId);
            }
        } catch (_) {}
        return null;
    }

    async function accruePartnerCommissionsV1({ bookingId, booking, serviceItems, platformFeeBase, stage2EligibleAt }) {
        if (!platformFeeBase || platformFeeBase <= 0) return;
        if (!bookingId || !booking) return;
        if (!Array.isArray(serviceItems) || !serviceItems.length) return;

        // Idempotency: one-time accrual per booking.
        try {
            if (booking.partnerCommissionsAccruedAt) return;
        } catch (_) {}

        const totalGross = serviceItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
        if (!totalGross || totalGross <= 0) return;

        // partnerId -> base platform fee share
        const partnerShares = new Map();

        for (const it of serviceItems) {
            const type = String(it?.type || '').trim().toLowerCase();
            const supplierId = String(it?.supplierId || it?.uid || '').trim();
            const gross = Math.max(0, Math.round(Number(it?.amount || 0)));
            if (!supplierId || !gross) continue;

            const col = type === 'vendor' ? 'vendors' : 'artists';
            let referralCode = null;
            try {
                const pSnap = await db.collection(col).doc(supplierId).get();
                const p = pSnap.exists ? (pSnap.data() || {}) : {};
                referralCode = p.referralCode || null;
            } catch (_) {}
            if (!referralCode) continue;

            const partnerId = await resolvePartnerIdByReferralCode(referralCode);
            if (!partnerId) continue;

            const share = Math.round((platformFeeBase * gross) / totalGross);
            if (share <= 0) continue;
            partnerShares.set(partnerId, (partnerShares.get(partnerId) || 0) + share);
        }

        if (!partnerShares.size) return;

        // For each partner: apply tiered rate based on eligibleBookingCount.
        const payableAtDate = (() => {
            const base = asDate(stage2EligibleAt) || new Date();
            return new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
        })();
        const Ts = admin && admin.firestore && admin.firestore.Timestamp;
        const payableAt = (Ts && typeof Ts.fromDate === 'function') ? Ts.fromDate(payableAtDate) : payableAtDate;

        for (const [partnerId, baseShare] of partnerShares.entries()) {
            const commissionRef = db.collection('partner_commissions').doc(`${bookingId}_${partnerId}`);

            await db.runTransaction(async (tx) => {
                const existing = await tx.get(commissionRef);
                if (existing.exists) return;

                const partnerRef = db.collection('partners').doc(String(partnerId));
                const partnerSnap = await tx.get(partnerRef);
                const partner = partnerSnap.exists ? (partnerSnap.data() || {}) : {};
                const count = Number(partner.eligibleBookingCount || 0);
                const rate = count < 10 ? 0.25 : 0.20;
                const commissionAmount = Math.max(0, Math.round(baseShare * rate));

                tx.set(commissionRef, {
                    schemaVersion: 1,
                    bookingId,
                    partnerId,
                    platformFeeBaseShare: baseShare,
                    commissionRate: rate,
                    commissionAmount,
                    basis: 'platform_fee_ex_gst',
                    status: 'accrued',
                    payableAt,
                    createdAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp(),
                }, { merge: true });

                tx.set(partnerRef, {
                    eligibleBookingCount: count + 1,
                    updatedAt: FieldValue.serverTimestamp(),
                }, { merge: true });
            });
        }

        await db.collection(BOOKINGS_COLLECTION).doc(bookingId).set({
            partnerCommissionsAccruedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    }

    function ensurePgCredentials() {
        if (!config.clientId || !config.clientSecret) {
            throw new functions.https.HttpsError('failed-precondition', 'Cashfree client credentials are not configured');
        }
    }

    function ensurePayoutCredentials() {
        if (!config.payoutClientId || !config.payoutClientSecret) {
            throw new functions.https.HttpsError('failed-precondition', 'Cashfree payout credentials are not configured');
        }
    }

    async function callPg(path, { method = 'POST', body = undefined, idempotencyKey, headers = {} } = {}) {
        ensurePgCredentials();
        const requestHeaders = {
            'Content-Type': 'application/json',
            'x-client-id': config.clientId,
            'x-client-secret': config.clientSecret,
            'x-api-version': config.apiVersion,
            ...headers,
        };
        if (idempotencyKey) {
            requestHeaders['x-idempotency-key'] = idempotencyKey;
        }
        const response = await fetch(`${config.pgBaseUrl}${path}`, {
            method,
            headers: requestHeaders,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_error) {
            data = { raw: text };
        }
        if (!response.ok) {
            const error = new Error(`Cashfree PG error ${response.status}`);
            error.response = data;
            error.status = response.status;
            throw error;
        }
        return data;
    }

    async function callPayout(path, { method = 'POST', body = undefined } = {}) {
        ensurePayoutCredentials();
        const response = await fetch(`${config.payoutBaseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': config.payoutClientId,
                'x-client-secret': config.payoutClientSecret,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_error) {
            data = { raw: text };
        }
        if (!response.ok) {
            const error = new Error(`Cashfree payout error ${response.status}`);
            error.response = data;
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function verifyWebhookSignature(req) {
        // We'll attempt verification against multiple possible secrets because
        // Cashfree variants may sign with: a dedicated webhook secret, PG client secret,
        // or Payout client secret depending on product/version.
        const candidateSecrets = [
            config.webhookSecret,
            config.clientSecret,
            config.payoutClientSecret,
        ].filter((s) => typeof s === 'string' && s.length > 0);
        if (!candidateSecrets.length) {
            console.warn('Cashfree webhook: no candidate secrets configured');
            return false;
        }

        const signatureHeader =
            req.headers['x-webhook-signature'] ||
            req.headers['x-cashfree-signature'] ||
            req.headers['x-cf-signature'] ||
            req.headers['x-client-signature'];
        if (!signatureHeader) {
            console.warn('Cashfree webhook missing signature header');
            return false;
        }

        const rawBody = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body || {}));
        const expectedFor = (secret) => crypto.createHmac('sha256', secret).update(rawBody).digest();

        const trimmed = String(signatureHeader).trim();
        const digestLength = expectedFor(candidateSecrets[0]).length;
        let provided = null;
        try {
            provided = Buffer.from(trimmed, 'base64');
        } catch (_) {
            provided = null;
        }
        if (!provided || provided.length !== digestLength) {
            try {
                provided = Buffer.from(trimmed, 'hex');
            } catch (_) {
                provided = null;
            }
        }
        if (!provided || provided.length !== digestLength) {
            console.warn('Cashfree webhook signature length mismatch');
            return false;
        }
        for (const secret of candidateSecrets) {
            try {
                const expected = expectedFor(secret);
                if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
                    return true;
                }
            } catch (_e) {
                // continue to next secret
            }
        }
        console.warn('Cashfree webhook signature did not match any candidate secret');
        return false;
    }

    function isDashboardTest(req, evt) {
        const flag = String(process.env.ALLOW_CASHFREE_DASHBOARD_TESTS || '').toLowerCase();
        if (flag === 'true' || flag === '1') return true;
        const ua = String(req.headers['user-agent'] || '').toLowerCase();
        const signatureHeader =
            req.headers['x-webhook-signature'] ||
            req.headers['x-cashfree-signature'] ||
            req.headers['x-cf-signature'] ||
            req.headers['x-client-signature'];
        const evtFlag = String(evt?.event || evt?.type || '').toLowerCase();
        const testHeader = (req.headers['x-cf-test'] || req.headers['x-cashfree-test'] || '').toString().toLowerCase();
        return (!signatureHeader && (ua.includes('cashfree') || evtFlag === 'test' || evtFlag === 'ping' || testHeader === 'true'));
    }

    async function recordWebhook(eventId, payload, req, source) {
        const safeEventId = eventId || `fallback:${Date.now()}`;
        const logRef = db.collection(WEBHOOK_LOGS_COLLECTION).doc(safeEventId);
        const existing = await logRef.get();
        if (existing.exists && existing.data()?.status === 'processed') {
            return { duplicate: true, logRef };
        }
        await logRef.set({
            eventId: safeEventId,
            status: 'processing',
            source,
            receivedAt: FieldValue.serverTimestamp(),
            rawBody: req.rawBody ? req.rawBody.toString('utf8') : toCompactJson(payload),
            headers: req.headers,
            attempts: FieldValue.increment ? FieldValue.increment(1) : 1,
        }, { merge: true });
        return { duplicate: false, logRef };
    }

    async function markWebhookLog(logRef, status, extra = {}) {
        if (!logRef) return;
        try {
            await logRef.set({
                status,
                processedAt: FieldValue.serverTimestamp(),
                ...extra,
            }, { merge: true });
        } catch (error) {
            console.warn('Failed to update webhook log', error);
        }
    }

    function normalizeStatus(statusRaw) {
        if (!statusRaw) return null;
        return String(statusRaw).trim().toLowerCase();
    }

    function buildOrderId(bookingId) {
        return `${CASHFREE_ORDER_PREFIX}_${bookingId}_${Date.now()}`;
    }

    const createOrderSchema = z.object({
        bookingId: z.string({ required_error: 'bookingId is required.' }).min(1, 'bookingId cannot be empty.'),
    });

    async function createOrder(data, context, options = {}) {
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
        }

        const validation = createOrderSchema.safeParse(data);
        if (!validation.success) {
            const errorDetails = validation.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }));
            throw new functions.https.HttpsError('invalid-argument', 'Invalid data provided.', { errors: errorDetails });
        }

        const { bookingId } = validation.data;
        const uid = context.auth.uid;

        const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'Booking not found');
        }
        const booking = bookingSnap.data();

        const allowAdminBypass = options && options.allowAdminBypass === true;
        if (!allowAdminBypass && booking.clientId !== uid) {
            throw new functions.https.HttpsError('permission-denied', 'Only booking creator can initiate payment');
        }
        if (booking.status !== 'pending_payment') {
            throw new functions.https.HttpsError('failed-precondition', 'Booking is not awaiting payment');
        }

        const bookingType = String(booking.type || booking.bookingType || 'gig').toLowerCase();
        if (bookingType === 'project') {
            if (!booking.proposal || booking.proposal.accepted !== true) {
                throw new functions.https.HttpsError('failed-precondition', 'Project proposal must be accepted before payment');
            }
            const callCompleted = Boolean(
                booking.callCompleted ||
                (booking.call && booking.call.completed === true) ||
                (booking.gating && booking.gating.callCompleted === true)
            );
            if (!callCompleted) {
                throw new functions.https.HttpsError('failed-precondition', 'Project requires a completed proposal call before payment');
            }
        }

        // Phase-1: Use client total payable from Phase-1 pricing
        let amount;
        if (booking.clientTotalPayable && booking.pricingModel === 'CLIENT_ONLY_PLATFORM_FEES') {
            // Phase-1 pricing already calculated
            amount = Number(booking.clientTotalPayable);
        } else {
            // Fallback to legacy amount calculation
            amount = Number(booking.amountDueNow || booking.amount || booking.proposal?.amount || 0);
        }
        
        if (!amount || amount <= 0) {
            throw new functions.https.HttpsError('failed-precondition', 'Booking amount not available');
        }

        const orderId = buildOrderId(bookingId);
        const orderPayload = {
            order_id: orderId,
            order_amount: Number(amount),
            order_currency: 'INR',
            customer_details: {
                customer_id: uid,
                customer_email: booking.clientEmail || '',
                customer_phone: booking.clientPhone || '',
            },
            order_meta: {
                return_url: booking.returnUrl || undefined,
            },
        };

        let gatewayOrderId = orderId;
        let paymentLink = null;
        let gatewayResponse = null;

        if (config.mock) {
            gatewayResponse = {
                order_id: orderId,
                orderId,
                payment_session_id: `mock_session_${orderId}`,
                payment_link: `https://mock.cashfree.test/pay/${orderId}`,
                status: 'MOCK_SUCCESS',
            };
            paymentLink = gatewayResponse.payment_link;
        } else {
            try {
                gatewayResponse = await callPg('/pg/orders', {
                    method: 'POST',
                    body: orderPayload,
                    idempotencyKey: orderId,
                });
            } catch (error) {
                console.error('Cashfree order creation failed', error.response || error);
                throw new functions.https.HttpsError('internal', 'Cashfree order creation failed');
            }
            gatewayOrderId = gatewayResponse?.order_id || gatewayResponse?.orderId || orderId;
            paymentLink = gatewayResponse?.payment_link || gatewayResponse?.paymentLink || null;
        }

        const paymentRef = db.collection(PAYMENTS_COLLECTION).doc();

        await db.runTransaction(async (tx) => {
            const latestSnap = await tx.get(bookingRef);
            if (!latestSnap.exists) {
                throw new functions.https.HttpsError('not-found', 'Booking not found');
            }
            const latest = latestSnap.data();
            if (latest.status !== 'pending_payment') {
                throw new functions.https.HttpsError('failed-precondition', 'Booking state changed while creating order');
            }

            tx.set(paymentRef, {
                bookingId,
                createdBy: uid,
                gateway: 'cashfree',
                gatewayOrderId,
                gatewayResponse,
                amountExpected: amount,
                environment: config.environment,
                escrowHeld: false,
                releaseStatus: 'held_pending',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });

            tx.update(bookingRef, {
                paymentRef: paymentRef.id,
                gatewayOrderId,
                bookingType,
                paymentInitiatedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });
        });

        return {
            paymentRefId: paymentRef.id,
            gatewayOrderId,
            paymentUrl: paymentLink,
            amount,
            raw: gatewayResponse,
            environment: config.environment,
        };
    }

    // Admin-only HTTP wrapper to create an order and return a payment link
    // Useful for end-to-end manual testing from tools like Postman.
    async function createOrderHttp(req, res) {
        try {
            // CORS minimal
            const origin = req.headers.origin || '';
            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
            }
            res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

            const bypass = String(req.headers['x-test-bypass'] || '').trim();
            const allowBypass = (process.env.TEST_BYPASS_TOKEN && bypass === process.env.TEST_BYPASS_TOKEN);
            let decoded = null;
            if (!allowBypass) {
                const authHeader = req.headers.authorization || '';
                const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
                if (!idToken) return res.status(401).json({ ok: false, error: 'missing_auth' });
                try { decoded = await admin.auth().verifyIdToken(idToken); } catch (_e) { return res.status(401).json({ ok: false, error: 'invalid_auth' }); }
                try {
                    const role = await adminApi.checkUserRole(decoded.uid, decoded.phone_number || null, decoded.email || null);
                    if (!role || role.role !== 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
                } catch (_) { return res.status(403).json({ ok: false, error: 'forbidden' }); }
            }

            const body = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
            const bookingId = String(body.bookingId || '').trim();
            if (!bookingId) return res.status(400).json({ ok: false, error: 'bookingId required' });

            const result = await createOrder(
                { bookingId },
                { auth: { uid: decoded ? decoded.uid : 'admin_bypass' } },
                { allowAdminBypass: true }
            );
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            console.error('createOrderHttp error', error);
            return res.status(500).json({ ok: false, error: error?.message || 'internal_error' });
        }
    }

    // Admin-only HTTP endpoint: mark a booking as completed to trigger payout
    async function adminCompleteBookingHttp(req, res) {
        try {
            const origin = req.headers.origin || '';
            if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
            res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

            const bypass = String(req.headers['x-test-bypass'] || '').trim();
            const allowBypass = (process.env.TEST_BYPASS_TOKEN && bypass === process.env.TEST_BYPASS_TOKEN);
            if (!allowBypass) {
                const authHeader = req.headers.authorization || '';
                const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
                if (!idToken) return res.status(401).json({ ok: false, error: 'missing_auth' });
                let decoded;
                try { decoded = await admin.auth().verifyIdToken(idToken); } catch (_) { return res.status(401).json({ ok: false, error: 'invalid_auth' }); }
                try {
                    const role = await adminApi.checkUserRole(decoded.uid, decoded.phone_number || null, decoded.email || null);
                    if (!role || role.role !== 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
                } catch (_) { return res.status(403).json({ ok: false, error: 'forbidden' }); }
            }

            const body = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
            const bookingId = String(body.bookingId || '').trim();
            if (!bookingId) return res.status(400).json({ ok: false, error: 'bookingId required' });

            const ref = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ ok: false, error: 'booking_not_found' });
            await ref.set({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return res.status(200).json({ ok: true });
        } catch (error) {
            console.error('adminCompleteBookingHttp error', error);
            return res.status(500).json({ ok: false, error: error?.message || 'internal_error' });
        }
    }

    // Admin-only HTTP endpoint: get payment + payout status for a booking
    async function getPayoutStatusHttp(req, res) {
        try {
            const origin = req.headers.origin || '';
            if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
            res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

            const bypass = String(req.headers['x-test-bypass'] || '').trim();
            const allowBypass = (process.env.TEST_BYPASS_TOKEN && bypass === process.env.TEST_BYPASS_TOKEN);
            if (!allowBypass) {
                const authHeader = req.headers.authorization || '';
                const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
                if (!idToken) return res.status(401).json({ ok: false, error: 'missing_auth' });
                let decoded;
                try { decoded = await admin.auth().verifyIdToken(idToken); } catch (_) { return res.status(401).json({ ok: false, error: 'invalid_auth' }); }
                try {
                    const role = await adminApi.checkUserRole(decoded.uid, decoded.phone_number || null, decoded.email || null);
                    if (!role || role.role !== 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
                } catch (_) { return res.status(403).json({ ok: false, error: 'forbidden' }); }
            }

            const bookingId = String(req.query.bookingId || '').trim();
            if (!bookingId) return res.status(400).json({ ok: false, error: 'bookingId required' });

            const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('bookingId', '==', bookingId).limit(1).get();
            if (paymentsSnap.empty) return res.status(404).json({ ok: false, error: 'payment_not_found' });
            const payment = paymentsSnap.docs[0].data();
            const paymentId = paymentsSnap.docs[0].id;
            return res.status(200).json({ ok: true, paymentId, payment });
        } catch (error) {
            console.error('getPayoutStatusHttp error', error);
            return res.status(500).json({ ok: false, error: error?.message || 'internal_error' });
        }
    }

    // Admin-only HTTP endpoint: seed a test booking and (optionally) payout + KYC for the artist
    async function seedTestBookingHttp(req, res) {
        try {
            const origin = req.headers.origin || '';
            if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
            res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

            const bypass = String(req.headers['x-test-bypass'] || '').trim();
            const allowBypass = (process.env.TEST_BYPASS_TOKEN && bypass === process.env.TEST_BYPASS_TOKEN);
            if (!allowBypass) {
                const authHeader = req.headers.authorization || '';
                const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
                if (!idToken) return res.status(401).json({ ok: false, error: 'missing_auth' });
                let decoded;
                try { decoded = await admin.auth().verifyIdToken(idToken); } catch (_) { return res.status(401).json({ ok: false, error: 'invalid_auth' }); }
                try {
                    const role = await adminApi.checkUserRole(decoded.uid, decoded.phone_number || null, decoded.email || null);
                    if (!role || role.role !== 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
                } catch (_) { return res.status(403).json({ ok: false, error: 'forbidden' }); }
            }

            const body = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
            let artistId = String(body.artistUid || body.artistId || '').trim();
            let clientId = String(body.clientUid || body.clientId || '').trim();
            const amount = Number(body.amount || 11);
            let bookingId = String(body.bookingId || '').trim();
            // Auto-generate dummy IDs if not provided
            const now = Date.now();
            if (!artistId) artistId = `artist_${now}`;
            if (!clientId) clientId = `client_${now}`;
            if (!bookingId) bookingId = `test_${artistId.slice(0,6)}_${now}`;

            const artistRef = db.collection('artists').doc(artistId);
            const userRef = db.collection('users').doc(artistId);
            const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);

            // Seed/patch artist KYC (verified) and unlock payouts
            await artistRef.set({
                uid: artistId,
                kyc: { kycStatus: 'verified', panVerified: true, upiVerified: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
                payoutsLocked: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            // Seed payout bank details if provided
            const bank = body.payoutBankDetails || {};
            if (bank && (bank.accountNumber || bank.ifsc)) {
                await userRef.set({
                    payoutBankDetails: {
                        accountNumber: String(bank.accountNumber || ''),
                        ifsc: String(bank.ifsc || ''),
                        bankName: String(bank.bankName || 'Test Bank'),
                        name: String(bank.name || 'Test Recipient'),
                        phone: String(bank.phone || ''),
                        email: String(bank.email || ''),
                        address: String(bank.address || ''),
                        city: String(bank.city || ''),
                        state: String(bank.state || ''),
                        pincode: String(bank.pincode || ''),
                    }
                }, { merge: true });
            }

            // Create a basic booking doc (pending_payment so order creation can proceed)
            await bookingRef.set({
                id: bookingId,
                artistId,
                clientId,
                amount,
                status: 'pending_payment',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            return res.status(200).json({ ok: true, bookingId, artistId, clientId, amount });
        } catch (error) {
            console.error('seedTestBookingHttp error', error);
            return res.status(500).json({ ok: false, error: error?.message || 'internal_error' });
        }
    }

    // One-call E2E setup: generates dummy artist/client, seeds booking, creates order, returns payment link
    async function fullE2ESetupHttp(req, res) {
        try {
            const origin = req.headers.origin || '';
            if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
            res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-test-bypass');
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

            const bypass = String(req.headers['x-test-bypass'] || '').trim();
            const allowBypass = (process.env.TEST_BYPASS_TOKEN && bypass === process.env.TEST_BYPASS_TOKEN);
            if (!allowBypass) return res.status(401).json({ ok: false, error: 'missing_or_invalid_bypass' });

            // Generate IDs
            const now = Date.now();
            const artistId = `artist_${now}`;
            const clientId = `client_${now}`;
            const bookingId = `e2e_${now}`;
            const amount = Number((req.body && req.body.amount) || 11);

            const artistRef = db.collection('artists').doc(artistId);
            const userRef = db.collection('users').doc(artistId);
            const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);

            // Seed artist (verified) + payout details
            await artistRef.set({ uid: artistId, displayName: 'E2E Artist', kyc: { kycStatus: 'verified', panVerified: true, upiVerified: true }, payoutsLocked: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            await userRef.set({ payoutBankDetails: { accountNumber: '000111222333', ifsc: 'HDFC0001234', bankName: 'Test Bank', name: 'E2E Recipient' } }, { merge: true });

            // Seed booking pending payment
            await bookingRef.set({ id: bookingId, artistId, clientId, amount, status: 'pending_payment', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

            // Create order via internal function (will call Cashfree unless CASHFREE_MOCK=true)
            const order = await createOrder(
                { bookingId },
                { auth: { uid: 'admin_bypass' } },
                { allowAdminBypass: true }
            );
            return res.status(200).json({ ok: true, bookingId, artistId, clientId, amount, ...order });
        } catch (error) {
            console.error('fullE2ESetupHttp error', error);
            return res.status(500).json({ ok: false, error: error?.message || 'internal_error' });
        }
    }

    // Admin-only HTTP endpoint: fully self-test escrow+payout flow without external network.
    // It seeds artist/client/booking, simulates PG success (escrow), marks booking completed,
    // and simulates payout success by updating the payments doc like the payout webhook would.
    async function paymentsSelfTestHttp(req, res) {
        try {
            const origin = req.headers.origin || '';
            if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
            res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-test-bypass');
            if (req.method === 'OPTIONS') return res.status(204).end();
            if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

            const bypass = String(req.headers['x-test-bypass'] || '').trim();
            const allowBypass = (process.env.TEST_BYPASS_TOKEN && bypass === process.env.TEST_BYPASS_TOKEN);
            if (!allowBypass) return res.status(401).json({ ok: false, error: 'missing_or_invalid_bypass' });

            const now = Date.now();
            const artistId = `artist_${now}`;
            const clientId = `client_${now}`;
            const bookingId = `selftest_${now}`;
            const amount = 11;

            const artistRef = db.collection('artists').doc(artistId);
            const userRef = db.collection('users').doc(artistId);
            const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);

            // Seed artist + KYC
            await artistRef.set({
                uid: artistId,
                displayName: 'SelfTest Artist',
                kyc: { kycStatus: 'verified', panVerified: true, upiVerified: true },
                payoutsLocked: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            await userRef.set({
                payoutBankDetails: {
                    accountNumber: '000111222333', ifsc: 'HDFC0001234', bankName: 'Test Bank', name: 'SelfTest Recipient'
                }
            }, { merge: true });

            // Seed booking pending payment
            await bookingRef.set({
                id: bookingId, artistId, clientId, amount, status: 'pending_payment',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            // Create a payment doc and simulate PG success (escrow held)
            const paymentRef = db.collection(PAYMENTS_COLLECTION).doc();
            await paymentRef.set({
                bookingId,
                gateway: 'cashfree',
                gatewayOrderId: `MOCK_${bookingId}`,
                amountExpected: amount,
                amountPaid: amount,
                escrowHeld: true,
                releaseStatus: 'held',
                status: 'paid',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Mark booking paid
            await bookingRef.set({ status: 'paid', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

            // Complete booking (this would normally trigger releasePayout)
            await bookingRef.set({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

            // Simulate payout success update (as if from payout webhook)
            await paymentRef.set({
                payouts: { artist: { status: 'completed', amount } },
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            const outSnap = await paymentRef.get();
            return res.status(200).json({ ok: true, bookingId, artistId, clientId, paymentId: paymentRef.id, payment: outSnap.data() });
        } catch (error) {
            console.error('paymentsSelfTestHttp error', error);
            return res.status(500).json({ ok: false, error: error?.message || 'internal_error' });
        }
    }

    async function handlePaymentWebhook(req, res) {
        try {
            if (req.method === 'GET' || req.method === 'HEAD') {
                return res.status(200).send('ok');
            }
            if (req.method !== 'POST') {
                return res.status(405).send('method not allowed');
            }
            const evt = (req.body || {});
            const isTest = isDashboardTest(req, evt);
            if (!isTest && !verifyWebhookSignature(req)) {
                console.warn('Cashfree PG webhook invalid signature', { headers: Object.keys(req.headers || {}) });
                return res.status(400).send('invalid signature');
            }

            const event = evt;
            const eventId = event.eventId || event.id || event.cf_event_id || event.data?.payment?.cf_payment_id || `payment:${Date.now()}`;
            const { duplicate, logRef } = await recordWebhook(eventId, event, req, 'cashfree:payment');
            if (duplicate) {
                return res.status(200).send('duplicate');
            }

            const orderObj = event.order || event.data?.order || event.data?.orderDetails || {};
            const paymentObj = event.payment || event.data?.payment || event.data?.paymentDetails || {};

            const orderId = orderObj.order_id || orderObj.orderId || event.orderId;
            const txStatusRaw = paymentObj.payment_status || paymentObj.paymentStatus || paymentObj.txStatus || event.txStatus || event.status;
            const status = normalizeStatus(txStatusRaw);
            const paymentId = paymentObj.cf_payment_id || paymentObj.payment_id || paymentObj.referenceId || event.referenceId;
            const orderAmount = Number(paymentObj.payment_amount || paymentObj.amount || orderObj.order_amount || event.orderAmount || 0);

            if (!orderId) {
                if (isTest) {
                    await markWebhookLog(logRef, 'processed', { note: 'dashboard_test', headers: Object.keys(req.headers || {}) });
                    return res.status(200).send('ok');
                }
                await markWebhookLog(logRef, 'failed', { error: 'missing_orderId' });
                return res.status(400).send('missing orderId');
            }

            const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('gatewayOrderId', '==', orderId).limit(1).get();
            if (paymentsSnap.empty) {
                console.warn('Cashfree webhook with unknown orderId', orderId);
                await markWebhookLog(logRef, 'processed', { note: 'no payment record' });
                return res.status(200).send('no payment record');
            }

            const paymentRef = paymentsSnap.docs[0].ref;
            const paymentData = paymentsSnap.docs[0].data();

            if (status && PAYMENT_SUCCESS_STATUSES.has(status)) {
                await paymentRef.update({
                    gatewayPaymentId: paymentId || paymentData.gatewayPaymentId || null,
                    amountPaid: orderAmount || paymentData.amountPaid || 0,
                    escrowHeld: true,
                    releaseStatus: 'held',
                    status: 'paid',
                    lastWebhook: event,
                    updatedAt: FieldValue.serverTimestamp(),
                });

                const bookingId = paymentData.bookingId;
                if (bookingId) {
                    const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
                    const bookingSnap = await bookingRef.get();
                    if (bookingSnap.exists) {
                        const booking = bookingSnap.data();
                        const now = FieldValue.serverTimestamp();
                        const stage = String(booking?.paymentStage || '').toLowerCase();
                        const dueLater = Number(booking?.amountDueLater || 0);
                        const bookingUpdate = {
                            status: 'paid',
                            paymentCapturedAt: now,
                            updatedAt: now,
                        };

                        // Phase-1: payment staging (advance → balance → paid_full)
                        if (stage === 'balance') {
                            bookingUpdate.paidFull = true;
                            bookingUpdate.paidFullAt = now;
                            bookingUpdate.paymentStage = 'paid_full';
                        } else {
                            bookingUpdate.advancePaid = true;
                            bookingUpdate.advancePaidAt = now;
                            // If there is no remaining balance, treat this as fully paid.
                            if (dueLater <= 0) {
                                bookingUpdate.paidFull = true;
                                bookingUpdate.paidFullAt = now;
                                bookingUpdate.paymentStage = 'paid_full';
                            }
                        }

                        await bookingRef.update(bookingUpdate);

                        // V1: Create calendar blocks only after advance is paid.
                        try {
                            if (bookingUpdate.advancePaid === true) {
                                const startDate = String(booking?.eventDate || '').trim();
                                const endDate = String(booking?.eventEndDate || booking?.eventDate || '').trim();

                                const primaryUids = [booking?.artistId, booking?.vendorId].map((x) => String(x || '').trim()).filter(Boolean);
                                const fallbackUids = [
                                    ...(Array.isArray(booking?.assignedArtistIds) ? booking.assignedArtistIds : []),
                                    ...(Array.isArray(booking?.assignedVendorIds) ? booking.assignedVendorIds : []),
                                ].map((x) => String(x || '').trim()).filter(Boolean);

                                const uids = Array.from(new Set((primaryUids.length ? primaryUids : fallbackUids).slice(0, 10)));

                                const parseYmd = (ymd) => {
                                    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
                                    if (!m) return null;
                                    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));
                                    return Number.isNaN(d.getTime()) ? null : d;
                                };

                                const s = parseYmd(startDate);
                                const e = parseYmd(endDate);
                                if (s && e && uids.length) {
                                    const from = s.getTime() <= e.getTime() ? s : e;
                                    const to = s.getTime() <= e.getTime() ? e : s;
                                    const batch = db.batch();
                                    const ts = FieldValue.serverTimestamp();
                                    const blockIds = [];

                                    for (let cur = new Date(from.getTime()); cur.getTime() <= to.getTime(); cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000)) {
                                        const y = cur.getUTCFullYear();
                                        const mth = String(cur.getUTCMonth() + 1).padStart(2, '0');
                                        const dayNum = String(cur.getUTCDate()).padStart(2, '0');
                                        const day = `${y}-${mth}-${dayNum}`;

                                        uids.forEach((uid) => {
                                            const blockId = `${uid}_${day}`;
                                            blockIds.push(blockId);
                                            const ref = db.collection('calendar_blocks').doc(blockId);
                                            batch.set(ref, {
                                                schemaVersion: 1,
                                                blockId,
                                                bookingId,
                                                uid,
                                                date: day,
                                                status: 'blocked',
                                                createdAt: ts,
                                                updatedAt: ts,
                                            }, { merge: true });
                                        });
                                    }

                                    await batch.commit();
                                    await bookingRef.set({
                                        calendarLocked: true,
                                        calendarBlockIds: blockIds,
                                        calendarBlockStartDate: startDate || null,
                                        calendarBlockEndDate: endDate || null,
                                        updatedAt: ts,
                                    }, { merge: true });
                                }
                            }
                        } catch (e) {
                            console.warn('Failed to create calendar blocks for booking', bookingId, e?.message || e);
                        }

                        await sendNotification(booking.clientId, 'payment_success', {
                            amount: orderAmount,
                            bookingId,
                        });
                        // Notify artist that client payment has been received (funds held)
                        try {
                            if (booking.artistId) {
                                await sendNotification(booking.artistId, 'payment_success', {
                                    amount: orderAmount,
                                    bookingId,
                                });
                            }
                            if (booking.vendorId) {
                                await sendNotification(booking.vendorId, 'payment_success', {
                                    amount: orderAmount,
                                    bookingId,
                                });
                            }
                        } catch (error) {
                            console.warn('Artist notification on payment_success failed', error?.message || error);
                        }

                        const bookingType = String(booking.type || booking.bookingType || 'gig').toLowerCase();
                        if (bookingType === 'gig') {
                            try {
                                await db.collection('adminTasks').add({
                                    type: 'gig_followup_call',
                                    bookingId,
                                    clientId: booking.clientId || null,
                                    artistId: booking.artistId || null,
                                    priority: 'low',
                                    status: 'pending',
                                    createdAt: FieldValue.serverTimestamp(),
                                });
                            } catch (error) {
                                console.warn('Failed to create follow-up admin task', bookingId, error);
                            }
                        }
                    }
                }

                try {
                    await KPIS.funnels.bookingPaid(orderAmount || 0);
                } catch (error) {
                    console.warn('Failed to record KPI.bookingPaid', error?.message || error);
                }

                await markWebhookLog(logRef, 'processed', { status: 'success' });
                return res.status(200).send('ok');
            }

            if (status && PAYMENT_FAILURE_STATUSES.has(status)) {
                await paymentRef.update({
                    status: 'failed',
                    releaseStatus: 'failed',
                    lastWebhook: event,
                    updatedAt: FieldValue.serverTimestamp(),
                });

                const bookingId = paymentData.bookingId;
                if (bookingId) {
                    const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
                    await bookingRef.update({
                        status: 'payment_failed',
                        updatedAt: FieldValue.serverTimestamp(),
                    });

                    const bookingSnap = await bookingRef.get();
                    if (bookingSnap.exists) {
                        const booking = bookingSnap.data();
                        await sendNotification(booking.clientId, 'payment_failed', {
                            amount: orderAmount,
                            bookingId,
                        });
                    }
                }

                // Enhanced Payment Failure Alert
                console.error(JSON.stringify({
                    message: 'Cashfree payment failed or was cancelled by user.',
                    severity: 'WARNING', // Warning because it might be a user cancellation, not a system error
                    context: 'payment_webhook',
                    orderId,
                    bookingId: paymentData.bookingId,
                    paymentStatus: status,
                }));

                await markWebhookLog(logRef, 'processed', { status: 'failed' });
                return res.status(200).send('failed');
            }

            console.log('Unhandled Cashfree payment status', status, orderId);
            await paymentRef.update({
                lastWebhook: event,
                updatedAt: FieldValue.serverTimestamp(),
            });
            await markWebhookLog(logRef, 'processed', { status: status || 'unknown' });
            return res.status(200).send('unhandled');
        } catch (error) {
            console.error('cashfreeWebhook error', error);
            return res.status(500).send('server error');
        }
    }

    async function handlePayoutWebhook(req, res) {
        try {
            if (req.method === 'GET' || req.method === 'HEAD') {
                return res.status(200).send('ok');
            }
            if (req.method !== 'POST') {
                return res.status(405).send('method not allowed');
            }
            const evt = (req.body || {});
            const isTest = isDashboardTest(req, evt);
            if (!isTest && !verifyWebhookSignature(req)) {
                console.warn('Cashfree Payout webhook invalid signature', { headers: Object.keys(req.headers || {}) });
                return res.status(400).send('invalid signature');
            }

            const event = evt;
            const eventId = event.eventId || event.id || event.transfer?.transferId || `payout:${Date.now()}`;
            const { duplicate, logRef } = await recordWebhook(eventId, event, req, 'cashfree:payout');
            if (duplicate) {
                return res.status(200).send('duplicate');
            }

            const transfer = event.transfer || event.data?.transfer || event;
            const transferId = transfer.transferId || transfer.transfer_id;
            const statusRaw = transfer.status || transfer.event;
            const status = normalizeStatus(statusRaw);
            const referenceId = transfer.referenceId || transfer.cfReferenceId || transfer.reference_id;

            if (!transferId) {
                if (isTest) {
                    await markWebhookLog(logRef, 'processed', { note: 'dashboard_test', headers: Object.keys(req.headers || {}) });
                    return res.status(200).send('ok');
                }
                await markWebhookLog(logRef, 'failed', { error: 'missing_transferId' });
                return res.status(400).send('missing transferId');
            }

            let payoutType = 'artist';
            let stageKey = null;
            let paymentRef = null;
            let paymentData = null;

            // Prefer the durable transfer mapping (supports multi-stage payouts).
            try {
                const mapSnap = await db.collection(PAYOUT_TRANSFERS_COLLECTION).doc(String(transferId)).get();
                if (mapSnap.exists) {
                    const mapped = mapSnap.data() || {};
                    if (String(mapped.kind || '') === 'partner_payout') {
                        const partnerPayoutId = String(mapped.partnerPayoutId || transferId);
                        const payoutRef = db.collection('partner_payouts').doc(partnerPayoutId);
                        const payoutSnapBefore = await payoutRef.get();
                        const payoutBefore = payoutSnapBefore.exists ? (payoutSnapBefore.data() || {}) : {};
                        const previousStatus = String(payoutBefore.status || '').toLowerCase();
                        const nextStatus = status === 'success' ? 'completed' : status === 'failure' ? 'failed' : status;
                        await payoutRef.set({
                            status: nextStatus,
                            transferId,
                            cfReferenceId: referenceId || null,
                            updatedAt: FieldValue.serverTimestamp(),
                            lastWebhook: event,
                        }, { merge: true });

                        // Mark commission rows for this payout id.
                        try {
                            const qs = await db.collection('partner_commissions')
                                .where('partnerPayoutId', '==', partnerPayoutId)
                                .where('status', '==', 'paying')
                                .limit(250)
                                .get();
                            if (!qs.empty) {
                                const batch = db.batch();
                                qs.docs.forEach((d) => {
                                    batch.set(d.ref, {
                                        status: status === 'success' ? 'paid' : status === 'failure' ? 'failed' : 'paying',
                                        paidAt: status === 'success' ? FieldValue.serverTimestamp() : null,
                                        updatedAt: FieldValue.serverTimestamp(),
                                    }, { merge: true });
                                });
                                await batch.commit();
                            }
                        } catch (e) {
                            console.warn('Failed to update partner commissions from payout webhook', partnerPayoutId, e?.message || e);
                        }

                        await db.collection(PAYOUT_TRANSFERS_COLLECTION).doc(String(transferId)).set({
                            status: nextStatus,
                            updatedAt: FieldValue.serverTimestamp(),
                        }, { merge: true });

                        // Notify partner only on state transition to terminal status.
                        const partnerId = String(mapped.partnerId || payoutBefore.partnerId || '').trim();
                        const payoutAmount = Math.round(Number(payoutBefore.amount || transfer.amount || 0));
                        const transitioned =
                            (nextStatus === 'completed' || nextStatus === 'failed') &&
                            previousStatus !== nextStatus;
                        if (partnerId && transitioned) {
                            const notificationType = nextStatus === 'completed'
                                ? 'partner_payout_completed'
                                : 'partner_payout_failed';
                            try {
                                await sendNotification(partnerId, notificationType, {
                                    amount: payoutAmount,
                                    transferId,
                                    reason: transfer.reason || transfer.failureReason || null,
                                });
                            } catch (notifyError) {
                                console.warn('Failed to notify partner payout status', partnerId, notifyError?.message || notifyError);
                            }
                        }

                        await markWebhookLog(logRef, 'processed', { status: status || 'unknown', kind: 'partner_payout' });
                        return res.status(200).send('ok');
                    }
                    payoutType = String(mapped.payoutType || payoutType);
                    stageKey = String(mapped.stageKey || '').trim() || null;
                    const paymentId = String(mapped.paymentId || '').trim();
                    if (paymentId) {
                        paymentRef = db.collection(PAYMENTS_COLLECTION).doc(paymentId);
                        const pSnap = await paymentRef.get();
                        if (pSnap.exists) {
                            paymentData = pSnap.data() || {};
                        } else {
                            paymentRef = null;
                        }
                    }
                }
            } catch (e) {
                console.warn('Payout transfer mapping lookup failed', transferId, e?.message || e);
            }

            // Fallback: best-effort query by latest payoutId (legacy behavior).
            if (!paymentRef) {
                let paymentsSnap = await db.collection(PAYMENTS_COLLECTION)
                    .where('payouts.artist.payoutId', '==', transferId)
                    .limit(1)
                    .get();
                if (paymentsSnap.empty) {
                    payoutType = 'vendor';
                    paymentsSnap = await db.collection(PAYMENTS_COLLECTION)
                        .where('payouts.vendor.payoutId', '==', transferId)
                        .limit(1)
                        .get();
                }
                if (paymentsSnap.empty) {
                    console.warn('Cashfree payout webhook with unknown transferId', transferId);
                    await markWebhookLog(logRef, 'processed', { note: 'no payment record' });
                    return res.status(200).send('no payment record');
                }
                paymentRef = paymentsSnap.docs[0].ref;
                paymentData = paymentsSnap.docs[0].data();
            }

            const payout = paymentData?.payouts?.[payoutType] || {};
            const amount = payout.amount || transfer.amount || null;

            const update = {
                [`payouts.${payoutType}.status`]: status === 'success' ? 'completed' : status === 'failure' ? 'failed' : status,
                [`payouts.${payoutType}.updatedAt`]: FieldValue.serverTimestamp(),
                lastWebhook: event,
                updatedAt: FieldValue.serverTimestamp(),
            };
            if (referenceId) {
                update[`payouts.${payoutType}.cfReferenceId`] = referenceId;
            }

            await paymentRef.update(update);

            try {
                await db.collection(PAYOUT_TRANSFERS_COLLECTION).doc(String(transferId)).set({
                    status: status === 'success' ? 'completed' : status === 'failure' ? 'failed' : status,
                    updatedAt: FieldValue.serverTimestamp(),
                    lastWebhookAt: FieldValue.serverTimestamp(),
                }, { merge: true });
            } catch (_) {}

            const bookingId = paymentData.bookingId;
            if (bookingId) {
                const bookingSnap = await db.collection(BOOKINGS_COLLECTION).doc(bookingId).get();
                const booking = bookingSnap.data();
                if (status === 'success' && booking) {
                    const recipient = payoutType === 'vendor' ? booking.vendorId : booking.artistId;
                    if (recipient) {
                        const stageNotificationType = stageKey === 'stage1'
                            ? 'payout_stage1_success'
                            : stageKey === 'stage2'
                                ? 'payout_stage2_success'
                                : 'payout_success';
                        await sendNotification(recipient, stageNotificationType, {
                            amount,
                            bookingId,
                            stage: stageKey || null,
                        });
                    }
                } else if (status !== 'success') {
                    await notifyAdmin('payout_failed', { transferId, bookingId, status });
                    // Enhanced Payout Failure Alert
                    console.error(JSON.stringify({
                        message: 'Critical: Cashfree payout failed.',
                        severity: 'CRITICAL',
                        context: 'payout_webhook',
                        transferId,
                        bookingId,
                        payoutStatus: status,
                    }));
                }
            }

            await markWebhookLog(logRef, 'processed', { status: status || 'unknown' });
            return res.status(200).send('ok');
        } catch (error) {
            console.error('cashfreePayoutWebhook error', error);
            return res.status(500).send('server error');
        }
    }

    async function enqueuePayoutJob(jobData) {
        const topic = pubsub.topic(payoutTopicName);
        try {
            await topic.get({ autoCreate: true });
        } catch (error) {
            console.warn('Pub/Sub topic ensure failed (continuing)', error?.message || error);
        }
        const messageId = await topic.publishMessage({ data: Buffer.from(JSON.stringify(jobData)) });
        return messageId;
    }

    async function notifyPayoutHoldOnce({ paymentRef, bookingId, recipientId, reason, stageKey }) {
        if (!paymentRef || !recipientId) return;
        const stage = stageKey === 'stage1' || stageKey === 'stage2' ? stageKey : 'single';
        const key = `${stage}:${String(reason || 'hold')}:${recipientId}`;
        let shouldNotify = false;
        try {
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(paymentRef);
                const data = snap.data() || {};
                const existing = Array.isArray(data.payoutHoldNotificationKeys) ? data.payoutHoldNotificationKeys : [];
                if (existing.includes(key)) return;
                tx.update(paymentRef, {
                    payoutHoldNotificationKeys: [...existing, key],
                    updatedAt: FieldValue.serverTimestamp(),
                });
                shouldNotify = true;
            });
        } catch (error) {
            console.warn('notifyPayoutHoldOnce transaction failed', bookingId, recipientId, error?.message || error);
        }
        if (!shouldNotify) return;
        try {
            await sendNotification(recipientId, 'payout_on_hold', {
                bookingId,
                stage,
                reason: String(reason || 'manual_review'),
            });
        } catch (error) {
            console.warn('notifyPayoutHoldOnce send failed', bookingId, recipientId, error?.message || error);
        }
    }

    async function processPayoutJob(jobData) {
        const { bookingId, payoutType, recipientId, amount, bankDetails, transferId, stageKey } = jobData;

        const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('bookingId', '==', bookingId).limit(1).get();
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
                    console.log('Auto-promo spend applied for artist', recipientId, bookingId, promoResult);
                }
            } catch (promoError) {
                console.warn('Auto-promo spend failed for artist', recipientId, bookingId, promoError);
            }
        }

        if (payoutType === 'vendor') {
            console.log('Processing vendor payout (no deductions)', recipientId, amount);
        }

        const beneId = `${payoutType}_${recipientId}`;
        const beneficiaryPayload = {
            beneId,
            name: bankDetails.name || 'Recipient',
            email: bankDetails.email || '',
            phone: bankDetails.phone || '',
            bankDetails: {
                bankAccount: bankDetails.accountNumber,
                ifsc: bankDetails.ifsc,
                bankName: bankDetails.bankName || '',
            },
            address: {
                address1: bankDetails.address || '',
                city: bankDetails.city || '',
                state: bankDetails.state || '',
                pincode: bankDetails.pincode || '',
            },
        };

        await callPayout('/payout/v1/addBeneficiary', beneficiaryPayload);

        // Durable mapping for payout webhooks (handles multi-stage payouts safely).
        try {
            await db.collection(PAYOUT_TRANSFERS_COLLECTION).doc(String(transferId)).set({
                transferId: String(transferId),
                bookingId: String(bookingId),
                paymentId: paymentRef.id,
                payoutType: String(payoutType),
                recipientId: String(recipientId),
                stageKey: stageKey ? String(stageKey) : null,
                amount: Number(amount),
                status: 'requested',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (e) {
            console.warn('Failed to write payout transfer mapping', transferId, e?.message || e);
        }

        const transferPayload = {
            beneId,
            amount: amount.toString(),
            transferId,
            remarks: `${payoutType} payout${stageKey ? ` (${stageKey})` : ''} for booking ${bookingId}`,
        };
        const transferResult = await callPayout('/payout/v1/requestTransfer', transferPayload);

        const payoutUpdate = {
            payoutId: transferResult.transferId || transferId,
            amount,
            status: 'initiated',
            cfReferenceId: transferResult.referenceId || transferResult.cfReferenceId || null,
            initiatedAt: FieldValue.serverTimestamp(),
        };

        await paymentRef.update({
            [`payouts.${payoutType}`]: payoutUpdate,
            [`payoutAttempts.${payoutType}`]: FieldValue.arrayUnion({
                attemptId: transferId,
                stageKey: stageKey || null,
                timestamp: FieldValue.serverTimestamp(),
                status: 'initiated',
                amount,
            }),
            updatedAt: FieldValue.serverTimestamp(),
        });

        try {
            await db.collection(PAYOUT_TRANSFERS_COLLECTION).doc(String(transferId)).set({
                status: 'initiated',
                payoutId: payoutUpdate.payoutId,
                cfReferenceId: payoutUpdate.cfReferenceId || null,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (_) {}
    }

    async function releasePayout(change, context) {
        const before = change.before.data();
        const after = change.after.data();
        const bookingId = context.params.bookingId;

        if (before.status === 'completed' || after.status !== 'completed') {
            return null;
        }

        const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('bookingId', '==', bookingId).limit(1).get();
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

        // V1 (locked): schedule a 2-stage payout plan:
        // - Stage 1: 50% at completion (Hour 0)
        // - Stage 2: remaining 50% at completion + 12 hours (if no dispute)
        // Admin/EA can hold payouts by setting booking.payoutHold=true (manual override).
        const completedAt = asDate(after?.completedAt) || new Date();
        const stage1At = new Date(completedAt.getTime() + PAYOUT_STAGE1_DELAY_HOURS * 60 * 60 * 1000);
        const stage2At = new Date(completedAt.getTime() + PAYOUT_STAGE2_DELAY_HOURS * 60 * 60 * 1000);
        const Ts = admin && admin.firestore && admin.firestore.Timestamp;
        const stage1EligibleAt = (Ts && typeof Ts.fromDate === 'function') ? Ts.fromDate(stage1At) : stage1At;
        const stage2EligibleAt = (Ts && typeof Ts.fromDate === 'function') ? Ts.fromDate(stage2At) : stage2At;

        // Idempotency: if release plan already exists, do not reschedule.
        if (paymentData?.releasePlanVersion === 2 || paymentData?.releasePlan?.stage1?.eligibleAt) {
            return null;
        }

        await paymentRef.update({
            releasePlanVersion: 2,
            releasePlan: {
                stage1: { key: 'stage1', fraction: 0.5, eligibleAt: stage1EligibleAt, status: 'scheduled' },
                stage2: { key: 'stage2', fraction: 0.5, eligibleAt: stage2EligibleAt, status: 'scheduled' },
            },
            releaseStatus: 'scheduled',
            releaseScheduledAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });
        await db.collection(BOOKINGS_COLLECTION).doc(bookingId).update({
            payoutHold: (after.payoutHold === true),
            payoutPlan: {
                version: 2,
                stage1EligibleAt,
                stage2EligibleAt,
                disputeWindowHours: DISPUTE_WINDOW_HOURS,
            },
            updatedAt: FieldValue.serverTimestamp(),
        });
        return null;
    }

    async function releasePayoutNow({ bookingId, booking, paymentRef, paymentData, stageKey }) {
        if (!paymentData?.escrowHeld) {
            console.warn('Escrow not held for booking', bookingId);
            return { status: 'blocked', reason: 'escrow_not_held' };
        }
        if (booking?.payoutHold === true) {
            await paymentRef.update({
                releaseStatus: 'hold',
                releaseError: 'payout_hold',
                releaseStage: stageKey || null,
                updatedAt: FieldValue.serverTimestamp(),
            });
            return { status: 'hold', reason: 'payout_hold' };
        }
        if (paymentData?.disputeStatus) {
            await paymentRef.update({
                releaseStatus: 'blocked_dispute',
                releaseError: 'dispute_open',
                updatedAt: FieldValue.serverTimestamp(),
            });
            return { status: 'hold', reason: 'dispute_open' };
        }

        // Compute distribution on provider subtotal (service amount), not the client total.
        const rawItems = Array.isArray(booking?.serviceItems) ? booking.serviceItems : [];
        const serviceItems = rawItems
            .map((it) => ({
                type: String(it?.type || '').trim().toLowerCase(),
                supplierId: String(it?.supplierId || it?.uid || '').trim(),
                amount: Number(it?.amount || 0),
            }))
            .filter((it) => (it.type === 'artist' || it.type === 'vendor') && it.supplierId && Number.isFinite(it.amount) && it.amount > 0)
            .slice(0, 4);

        // Back-compat fallback if booking.serviceItems is missing.
        if (serviceItems.length === 0) {
            const providerSubtotal = Number(booking?.pricing?.subtotal ?? booking?.subtotal ?? booking?.bookingAmount ?? 0);
            const base = Number.isFinite(providerSubtotal) && providerSubtotal > 0
                ? providerSubtotal
                : Number(booking?.amountTotal || booking?.pricing?.totalCustomerPayable || booking?.amount || 0);
            if (booking?.artistId) {
                serviceItems.push({ type: 'artist', supplierId: String(booking.artistId), amount: Math.max(0, Math.round(base)) });
            } else if (booking?.vendorId) {
                serviceItems.push({ type: 'vendor', supplierId: String(booking.vendorId), amount: Math.max(0, Math.round(base)) });
            }
        }

        const totalServiceAmount = serviceItems.reduce((sum, it) => sum + (Number.isFinite(it.amount) ? it.amount : 0), 0);
        const distribution = computeDistribution(totalServiceAmount);
        const stage = (stageKey === 'stage1' || stageKey === 'stage2') ? stageKey : 'single';
        await paymentRef.update({
            feeDistribution: distribution,
            releaseRequestedAt: FieldValue.serverTimestamp(),
            releaseStage: stage,
            updatedAt: FieldValue.serverTimestamp(),
        });

        if (!serviceItems.length) {
            await paymentRef.update({
                releaseStatus: 'failed',
                releaseError: 'missing_service_items',
                updatedAt: FieldValue.serverTimestamp(),
            });
            return { status: 'blocked', reason: 'missing_service_items' };
        }

        const payoutJobs = [];
        const supplierSummary = {};
        const allocations = {};
        const ecoTcsRate = Number.isFinite(ECO_TCS_RATE) && ECO_TCS_RATE >= 0 ? Number(ECO_TCS_RATE) : 0;

        const loadProfile = async (type, uid) => {
            const col = type === 'vendor' ? 'vendors' : 'artists';
            const snap = await db.collection(col).doc(uid).get();
            return snap.exists ? (snap.data() || {}) : {};
        };

        for (const item of serviceItems) {
            const supplierId = item.supplierId;

            const userSnap = await db.collection('users').doc(supplierId).get();
            if (!userSnap.exists) {
                await paymentRef.update({
                    releaseStatus: 'failed',
                    releaseError: `${item.type}_missing`,
                    updatedAt: FieldValue.serverTimestamp(),
                });
                throw new Error(`Supplier user missing (${item.type})`);
            }
            const userData = userSnap.data() || {};

            let profile = {};
            // Enforce payouts lock and KYC verification based on role profile.
            try {
                profile = await loadProfile(item.type, supplierId);
                if (profile.payoutsLocked === true) {
                    await paymentRef.update({
                        releaseStatus: 'blocked_payouts_locked',
                        releaseError: 'payouts_locked',
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.warn('Payouts locked for', item.type, supplierId, 'booking', bookingId);
                    return { status: 'blocked', reason: 'payouts_locked', blockedRecipientId: supplierId };
                }
                const kycStatus = profile?.kyc?.kycStatus || null;
                const panOk = profile?.kyc?.panVerified === true;
                const upiOk = profile?.kyc?.upiVerified === true;
                const bankOk = profile?.kyc?.bankVerified === true;
                const meetsKyc = (kycStatus === 'verified') || (panOk && (upiOk || bankOk));
                if (!meetsKyc) {
                    await paymentRef.update({
                        releaseStatus: 'pending_kyc',
                        releaseError: 'kyc_not_verified',
                        pendingKycFor: { type: item.type, uid: supplierId },
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.warn('Payout blocked by KYC for', item.type, supplierId, 'booking', bookingId);
                    return { status: 'blocked', reason: 'kyc_not_verified', blockedRecipientId: supplierId };
                }
                if (REQUIRE_PAN_FOR_PAYOUT && !panOk) {
                    await paymentRef.update({
                        releaseStatus: 'pending_kyc',
                        releaseError: 'pan_required',
                        pendingKycFor: { type: item.type, uid: supplierId, check: 'pan' },
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.warn('Payout blocked by PAN requirement for', item.type, supplierId, 'booking', bookingId);
                    return { status: 'blocked', reason: 'pan_required', blockedRecipientId: supplierId };
                }

                const identityMatch = evaluateIdentityMatch({ profile, userData });
                if (!identityMatch.passed) {
                    await paymentRef.update({
                        releaseStatus: 'pending_identity_review',
                        releaseError: 'identity_match_failed',
                        pendingIdentityFor: {
                            type: item.type,
                            uid: supplierId,
                            reason: identityMatch.reason,
                            thresholdScore: identityMatch.thresholdScore,
                            thresholdSimilarity: identityMatch.thresholdSimilarity,
                            bestNumericScore: identityMatch.bestNumericScore ?? null,
                            bestSimilarity: identityMatch.bestSimilarity ?? null,
                            bestSource: identityMatch.bestSource ?? null,
                        },
                        [`identityChecks.${supplierId}`]: identityMatch,
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.warn('Payout blocked by identity check for', item.type, supplierId, 'booking', bookingId, identityMatch.reason);
                    return { status: 'blocked', reason: 'identity_match_failed', blockedRecipientId: supplierId };
                }
            } catch (identityOrKycError) {
                await paymentRef.update({
                    releaseStatus: 'pending_identity_review',
                    releaseError: 'identity_check_error',
                    pendingIdentityFor: {
                        type: item.type,
                        uid: supplierId,
                        reason: 'identity_check_error',
                    },
                    updatedAt: FieldValue.serverTimestamp(),
                });
                console.error('Identity/KYC payout guard error', item.type, supplierId, bookingId, identityOrKycError?.message || identityOrKycError);
                return { status: 'blocked', reason: 'identity_check_error', blockedRecipientId: supplierId };
            }

            if (!userData.payoutBankDetails || !userData.payoutBankDetails.accountNumber) {
                await paymentRef.update({
                    releaseStatus: 'pending_payout_info',
                    releaseError: 'missing_payout_bank_details',
                    pendingPayoutInfoFor: { type: item.type, uid: supplierId },
                    updatedAt: FieldValue.serverTimestamp(),
                });
                return { status: 'blocked', reason: 'missing_payout_bank_details', blockedRecipientId: supplierId };
            }

            const grossTotal = roundInr(item.amount);
            const panOk = profile?.kyc?.panVerified === true;
            const fyTurnover = deriveFyTurnover(profile, userData);
            const tds = computeTdsForPayout({
                serviceFee: grossTotal,
                panVerified: panOk,
                fyTurnover,
            });
            const tdsTotal = Math.max(0, roundInr(tds.amount));
            const tcsPlatformCostTotal = ECO_TCS_BORNE_BY_PLATFORM ? Math.max(0, roundInr(grossTotal * ecoTcsRate)) : 0;

            // Split gross + TDS deterministically so stage1 + stage2 sums exactly to totals.
            const grossStage1 = Math.floor(grossTotal * 0.5);
            const tdsStage1 = Math.floor(tdsTotal * 0.5);
            const tcsPlatformCostStage1 = Math.floor(tcsPlatformCostTotal * 0.5);
            const stageGross = stage === 'stage1'
                ? grossStage1
                : stage === 'stage2'
                    ? (grossTotal - grossStage1)
                    : grossTotal;
            const stageTds = stage === 'stage1'
                ? tdsStage1
                : stage === 'stage2'
                    ? (tdsTotal - tdsStage1)
                    : tdsTotal;
            const stageTcsPlatformCost = stage === 'stage1'
                ? tcsPlatformCostStage1
                : stage === 'stage2'
                    ? (tcsPlatformCostTotal - tcsPlatformCostStage1)
                    : tcsPlatformCostTotal;
            const stageNet = Math.max(0, stageGross - stageTds);

            allocations[supplierId] = {
                type: item.type,
                grossTotal,
                tdsRate: tds.rate,
                tdsReason: tds.reason,
                fyTurnover: tds.turnover,
                tdsTotal,
                netTotal: Math.max(0, grossTotal - tdsTotal),
                tcsPlatformCostTotal,
                stage,
                stageGross,
                stageTds,
                stageTcsPlatformCost,
                stageNet,
                note: 'TDS withheld from supplier payout; TCS is platform-borne cost (ledger only)',
            };

            supplierSummary[supplierId] = allocations[supplierId];
            payoutJobs.push({
                bookingId,
                payoutType: item.type,
                recipientId: supplierId,
                amount: stageNet,
                bankDetails: userData.payoutBankDetails,
                stageKey: stage,
                transferId: `payout_${item.type}_${stage}_${bookingId}_${Date.now()}_${supplierId.slice(-6)}`,
            });
        }

        const enqueuedJobs = [];
        for (const job of payoutJobs) {
            try {
                const messageId = await enqueuePayoutJob(job);
                enqueuedJobs.push({ ...job, status: 'enqueued', messageId });
            } catch (error) {
                console.error('Failed to enqueue payout job', job, error);
                enqueuedJobs.push({ ...job, status: 'enqueue_failed', error: error.message });
            }
        }

        const supplierRows = Object.values(allocations);
        const stageTdsTotal = supplierRows.reduce((sum, row) => sum + (Number(row?.stageTds || 0)), 0);
        const stageTcsPlatformCostTotal = supplierRows.reduce((sum, row) => sum + (Number(row?.stageTcsPlatformCost || 0)), 0);
        const stageNetTotal = supplierRows.reduce((sum, row) => sum + (Number(row?.stageNet || 0)), 0);

        await paymentRef.update({
            [`releasePlan.${stage}.allocations`]: allocations,
            [`releasePlan.${stage}.enqueuedJobs`]: enqueuedJobs,
            [`releasePlan.${stage}.ecoTcsRate`]: ecoTcsRate,
            [`releasePlan.${stage}.ecoTcsPayer`]: ECO_TCS_BORNE_BY_PLATFORM ? 'platform_borne' : 'supplier_withheld',
            [`releasePlan.${stage}.tdsWithheldTotal`]: stageTdsTotal,
            [`releasePlan.${stage}.tcsPlatformCostTotal`]: stageTcsPlatformCostTotal,
            updatedAt: FieldValue.serverTimestamp(),
        });

        // Write/update a single ledger record per booking (idempotent).
        const grossCollected = Math.max(
            0,
            Number(booking?.amountTotal || booking?.pricing?.totalCustomerPayable || paymentData?.amountPaid || paymentData?.amountExpected || 0)
        );
        const escrowFeeEstimated = Math.max(0, roundInr(grossCollected * ESCROW_FEE_RATE));
        await db.collection(PLATFORM_LEDGER_COLLECTION).doc(bookingId).set({
            bookingId,
            paymentId: paymentRef.id,
            taxPolicyVersion: 'v1.1_pan_mandatory_tds_platform_tcs',
            grossCollected,
            escrowFeeRate: ESCROW_FEE_RATE,
            escrowFeeEstimated,
            escrowFeeSource: 'estimated_rate',
            platformRetained: distribution.platformRetained,
            adminAmount: distribution.adminAmount,
            platformFee: distribution.platformFee,
            commission: distribution.commission,
            gstCollectedTotal: distribution.gstCollectedTotal,
            ecoTcsRate: distribution.ecoTcsRate ?? ecoTcsRate ?? null,
            ecoTcsWithheld: ECO_TCS_BORNE_BY_PLATFORM ? 0 : (distribution.ecoTcsWithheld ?? null),
            ecoTcsPayer: ECO_TCS_BORNE_BY_PLATFORM ? 'platform_borne' : (distribution.ecoTcsPayer ?? 'supplier_withheld'),
            tdsWithheldStage: stageTdsTotal,
            tcsPlatformCostStage: stageTcsPlatformCostTotal,
            stages: {
                [stage]: {
                    tdsWithheld: stageTdsTotal,
                    tcsPlatformCost: stageTcsPlatformCostTotal,
                    supplierNetPayout: stageNetTotal,
                    updatedAt: FieldValue.serverTimestamp(),
                },
            },
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        await db.collection(BOOKINGS_COLLECTION).doc(bookingId).update({
            payoutSummary: {
                providerGross: distribution.artistGross ?? null,
                tdsWithheldStage: stageTdsTotal,
                tcsPlatformCostStage: stageTcsPlatformCostTotal,
                ecoTcsWithheld: ECO_TCS_BORNE_BY_PLATFORM ? 0 : (distribution.ecoTcsWithheld ?? null),
                ecoTcsPayer: ECO_TCS_BORNE_BY_PLATFORM ? 'platform_borne' : (distribution.ecoTcsPayer ?? null),
                providerNet: stageNetTotal,
                suppliers: supplierSummary,
                adminAmount: distribution.adminAmount,
                platformRetained: distribution.platformRetained,
                gstCollected: distribution.gstCollectedTotal,
            },
            payoutEnqueuedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });

        return { status: 'enqueued' };
    }

    // Runs periodically to auto-release payouts based on the staged release plan (V1).
    async function payoutScheduler(_context) {
        const nowTs = admin.firestore.Timestamp.now();

        async function processStage(stageKey) {
            const dueSnap = await db.collection(PAYMENTS_COLLECTION)
                .where(`releasePlan.${stageKey}.status`, '==', 'scheduled')
                .where(`releasePlan.${stageKey}.eligibleAt`, '<=', nowTs)
                .limit(25)
                .get();

            if (dueSnap.empty) return;

            for (const doc of dueSnap.docs) {
                const paymentRef = doc.ref;
                const paymentData = doc.data() || {};
                const bookingId = paymentData.bookingId;
                if (!bookingId) {
                    await paymentRef.update({
                        [`releasePlan.${stageKey}.status`]: 'failed',
                        [`releasePlan.${stageKey}.error`]: 'missing_bookingId',
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    continue;
                }

                // Claim stage (idempotency)
                let claimed = false;
                try {
                    await db.runTransaction(async (tx) => {
                        const snap = await tx.get(paymentRef);
                        const p = snap.data() || {};
                        const stage = p.releasePlan?.[stageKey] || {};
                        if (stage.status !== 'scheduled') return;
                        const eligibleAt = stage.eligibleAt;
                        if (!eligibleAt || (eligibleAt.toMillis && eligibleAt.toMillis() > Date.now())) return;
                        tx.update(paymentRef, {
                            [`releasePlan.${stageKey}.status`]: 'processing',
                            [`releasePlan.${stageKey}.startedAt`]: FieldValue.serverTimestamp(),
                            releaseStatus: 'processing',
                            releaseStage: stageKey,
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        claimed = true;
                    });
                } catch (e) {
                    console.warn('Failed to claim payout stage', { bookingId, stageKey, error: e?.message || e });
                    continue;
                }
                if (!claimed) continue;

                try {
                    const bookingSnap = await db.collection(BOOKINGS_COLLECTION).doc(bookingId).get();
                    if (!bookingSnap.exists) {
                        await paymentRef.update({
                            [`releasePlan.${stageKey}.status`]: 'failed',
                            [`releasePlan.${stageKey}.error`]: 'booking_missing',
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        continue;
                    }
                    const booking = bookingSnap.data() || {};
                    const status = String(booking.status || '').toLowerCase();
                    if (status !== 'completed') {
                        await paymentRef.update({
                            [`releasePlan.${stageKey}.status`]: 'scheduled',
                            releaseStatus: 'scheduled',
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        continue;
                    }
                    if (booking.paidFull !== true) {
                        await paymentRef.update({
                            [`releasePlan.${stageKey}.status`]: 'failed',
                            [`releasePlan.${stageKey}.error`]: 'paid_full_required',
                            releaseStatus: 'blocked_not_fully_paid',
                            releaseError: 'paid_full_required',
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        continue;
                    }

                    const result = await releasePayoutNow({ bookingId, booking, paymentRef, paymentData, stageKey });

                    if (result?.status === 'enqueued') {
                        await paymentRef.update({
                            [`releasePlan.${stageKey}.status`]: 'enqueued',
                            [`releasePlan.${stageKey}.enqueuedAt`]: FieldValue.serverTimestamp(),
                            releaseStatus: 'enqueued',
                            releaseStage: stageKey,
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        const recipients = [booking.artistId, booking.vendorId]
                            .map((value) => String(value || '').trim())
                            .filter(Boolean);
                        const notificationType = stageKey === 'stage1' ? 'payout_stage1_enqueued' : 'payout_stage2_enqueued';
                        for (const recipientId of recipients) {
                            try {
                                await sendNotification(recipientId, notificationType, { bookingId, stage: stageKey });
                            } catch (error) {
                                console.warn('Failed to send payout stage enqueue notification', bookingId, stageKey, recipientId, error?.message || error);
                            }
                        }

                        // V1: accrue partner commissions only after final settlement stage is released/enqueued.
                        if (stageKey === 'stage2') {
                            try {
                                const platformFeeBase = Number(booking?.pricing?.platformFee ?? booking?.platformFee ?? 0);
                                const stage2EligibleAt = paymentData?.releasePlan?.stage2?.eligibleAt || booking?.payoutPlan?.stage2EligibleAt || null;
                                const items = Array.isArray(booking?.serviceItems) ? booking.serviceItems : [];
                                await accruePartnerCommissionsV1({
                                    bookingId,
                                    booking,
                                    serviceItems: items,
                                    platformFeeBase,
                                    stage2EligibleAt,
                                });
                            } catch (e) {
                                console.warn('Partner commission accrual failed (non-blocking)', bookingId, e?.message || e);
                            }
                        }
                    } else if (result?.status === 'hold') {
                        await paymentRef.update({
                            [`releasePlan.${stageKey}.status`]: 'hold',
                            [`releasePlan.${stageKey}.error`]: result?.reason || 'hold',
                            releaseStatus: 'hold',
                            releaseStage: stageKey,
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        const recipients = [booking.artistId, booking.vendorId]
                            .map((value) => String(value || '').trim())
                            .filter(Boolean);
                        for (const recipientId of recipients) {
                            await notifyPayoutHoldOnce({
                                paymentRef,
                                bookingId,
                                recipientId,
                                reason: result?.reason || 'hold',
                                stageKey,
                            });
                        }
                    } else {
                        // Blocked (KYC/payout info/etc). Keep scheduled so it retries on next scheduler tick.
                        await paymentRef.update({
                            [`releasePlan.${stageKey}.status`]: 'scheduled',
                            [`releasePlan.${stageKey}.error`]: result?.reason || 'blocked',
                            releaseStatus: 'scheduled',
                            releaseStage: stageKey,
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                        if (result?.blockedRecipientId) {
                            await notifyPayoutHoldOnce({
                                paymentRef,
                                bookingId,
                                recipientId: String(result.blockedRecipientId || '').trim(),
                                reason: result?.reason || 'blocked',
                                stageKey,
                            });
                        }
                    }
                } catch (e) {
                    console.error('Auto-release payout stage failed', { bookingId, stageKey, error: e });
                    await paymentRef.update({
                        [`releasePlan.${stageKey}.status`]: 'failed',
                        [`releasePlan.${stageKey}.error`]: e?.message || String(e),
                        releaseStatus: 'failed',
                        releaseError: e?.message || String(e),
                        releaseStage: stageKey,
                        updatedAt: FieldValue.serverTimestamp(),
                    }).catch(() => {});
                }
            }
        }

        await processStage('stage1');
        await processStage('stage2');

        return null;
    }

    async function payoutWorker(message) {
        const payload = Buffer.from(message.data, 'base64').toString('utf8');
        const jobData = JSON.parse(payload);
        await processPayoutJob(jobData);
    }

    async function testPayoutQueue(data, context) {
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Auth required');
        }
        const userSnap = await db.collection('users').doc(context.auth.uid).get();
        const roles = userSnap.data()?.roles || [];
        if (!roles.includes('admin')) {
            throw new functions.https.HttpsError('permission-denied', 'Admin only');
        }

        const { bookingId, payoutType, recipientId, amount } = data || {};
        if (!bookingId || !payoutType || !recipientId || !amount) {
            throw new functions.https.HttpsError('invalid-argument', 'bookingId, payoutType, recipientId, amount required');
        }

        const recipient = await db.collection('users').doc(recipientId).get();
        if (!recipient.exists) {
            throw new functions.https.HttpsError('not-found', 'Recipient user not found');
        }
        const bankDetails = recipient.data().payoutBankDetails;
        if (!bankDetails || !bankDetails.accountNumber) {
            throw new functions.https.HttpsError('failed-precondition', 'Recipient is missing payout bank details');
        }

        const job = {
            bookingId,
            payoutType,
            recipientId,
            amount: Number(amount),
            bankDetails,
            transferId: `test_payout_${payoutType}_${bookingId}_${Date.now()}`,
        };
        const messageId = await enqueuePayoutJob(job);
        return {
            success: true,
            messageId,
            job,
        };
    }

    async function refundBooking(data, context) {
        if (!context.auth) {
            throw new functions.https.HttpsError('permission-denied', 'Authentication required');
        }
        const callerUid = context.auth.uid;
        const callerPhone = context.auth.token?.phone_number || null;
        const callerEmail = context.auth.token?.email || null;

        const userRole = await adminApi.checkUserRole(callerUid, callerPhone, callerEmail);
        if (userRole.role !== 'admin') {
            throw new functions.https.HttpsError('permission-denied', 'Only admin can refund bookings.');
        }

        const bookingId = data?.bookingId;
        const reason = data?.reason;
        if (!bookingId) {
            throw new functions.https.HttpsError('invalid-argument', 'bookingId required');
        }

        const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'Booking not found');
        }
        if (bookingSnap.data().status !== 'confirmed') {
            throw new functions.https.HttpsError('failed-precondition', 'Only confirmed bookings can be refunded');
        }

        const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('bookingId', '==', bookingId).limit(1).get();
        if (paymentsSnap.empty) {
            throw new functions.https.HttpsError('not-found', 'Payment not found');
        }

        const paymentRef = paymentsSnap.docs[0].ref;
        const payment = paymentsSnap.docs[0].data();
        if (payment.refundStatus) {
            throw new functions.https.HttpsError('already-exists', 'Refund already initiated');
        }
        if (!payment.gatewayPaymentId) {
            throw new functions.https.HttpsError('failed-precondition', 'Payment missing gatewayPaymentId');
        }

        let refundResult;
        try {
            refundResult = await callPg(`/api/v2/payments/${payment.gatewayPaymentId}/refunds`, {
                method: 'POST',
                body: {
                    refund_amount: (payment.amountPaid || payment.amountExpected || 0).toString(),
                    refund_id: `refund_${bookingId}_${Date.now()}`,
                    refund_note: reason || 'Admin initiated refund',
                },
            });
        } catch (error) {
            console.error('Cashfree refund API failed', error.response || error);
            throw new functions.https.HttpsError('internal', 'Failed to initiate refund with Cashfree');
        }

        await paymentRef.update({
            refundStatus: 'initiated',
            refundId: refundResult.refund_id,
            refundAmount: refundResult.refund_amount,
            refundInitiatedAt: FieldValue.serverTimestamp(),
            refundReason: reason,
            refundProcessedBy: callerUid,
            updatedAt: FieldValue.serverTimestamp(),
        });

        await bookingRef.update({
            status: 'refunded',
            refundedBy: callerUid,
            refundedAt: FieldValue.serverTimestamp(),
            refundReason: reason || 'Admin initiated refund',
            updatedAt: FieldValue.serverTimestamp(),
        });

        return { success: true, refundId: refundResult.refund_id };
    }

    async function handleDisputeWebhook(req, res) {
        try {
            if (req.method === 'GET' || req.method === 'HEAD') {
                return res.status(200).send('ok');
            }
            if (req.method !== 'POST') {
                return res.status(405).send('method not allowed');
            }
            if (!verifyWebhookSignature(req)) {
                return res.status(400).send('invalid signature');
            }

            const event = req.body || {};
            const eventId = event.eventId || event.id || event.data?.dispute?.dispute_id || `dispute:${Date.now()}`;
            const { duplicate, logRef } = await recordWebhook(eventId, event, req, 'cashfree:dispute');
            if (duplicate) {
                return res.status(200).send('duplicate');
            }

            const dispute = event.data?.dispute || event.dispute || event;
            const type = event.type || dispute.type || 'unknown';
            const orderId = dispute.order_id || dispute.orderId;
            if (!orderId) {
                await markWebhookLog(logRef, 'failed', { error: 'missing_orderId' });
                return res.status(400).send('missing orderId');
            }

            const paymentsSnap = await db.collection(PAYMENTS_COLLECTION).where('gatewayOrderId', '==', orderId).limit(1).get();
            if (paymentsSnap.empty) {
                console.warn('Dispute webhook without payment record', orderId);
                await markWebhookLog(logRef, 'processed', { note: 'no payment record' });
                return res.status(200).send('no payment record');
            }

            const paymentRef = paymentsSnap.docs[0].ref;
            const paymentData = paymentsSnap.docs[0].data();

            await paymentRef.update({
                disputeStatus: type,
                disputeData: dispute,
                disputeUpdatedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });

            await db.collection(DISPUTES_COLLECTION).add({
                paymentId: paymentRef.id,
                bookingId: paymentData.bookingId,
                type,
                data: dispute,
                createdAt: FieldValue.serverTimestamp(),
            });

            const bookingSnap = await db.collection(BOOKINGS_COLLECTION).doc(paymentData.bookingId).get();
            if (bookingSnap.exists) {
                const booking = bookingSnap.data();
                await sendNotification(booking.clientId, 'dispute_created', {
                    bookingId: paymentData.bookingId,
                    disputeId: dispute.dispute_id || dispute.id || null,
                });
            }

            await notifyAdmin('dispute_created', {
                orderId,
                type,
                disputeId: dispute.dispute_id || dispute.id || null,
            });

            await markWebhookLog(logRef, 'processed', { status: type });
            return res.status(200).send('ok');
        } catch (error) {
            console.error('cashfreeDisputeWebhook error', error);
            return res.status(500).send('server error');
        }
    }

    return {
        config,
        createOrder,
        createOrderHttp,
        adminCompleteBookingHttp,
        getPayoutStatusHttp,
        seedTestBookingHttp,
        paymentsSelfTestHttp,
        fullE2ESetupHttp,
        handlePaymentWebhook,
        handlePayoutWebhook,
        releasePayout,
        payoutScheduler,
        payoutWorker,
        testPayoutQueue,
        refundBooking,
        handleDisputeWebhook,
    };
};
