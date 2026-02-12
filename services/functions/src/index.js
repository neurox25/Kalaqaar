// functions/src/index.js
'use strict';

const functionsV1 = require('firebase-functions/v1');
const { regional } = require('./region');
const admin = require('firebase-admin');
const { PubSub } = require('@google-cloud/pubsub');

/**
 * Safely requires a module without throwing an error if it doesn't exist.
 * @param {string} path The path to the module.
 * @returns {object|null} The module or null.
 */
const safeRequire = (path) => {
    try {
        return require(path);
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') {
            console.warn(`Could not require ${path}:`, e);
        }
        return null;
    }
};

// --- Core Services ---
const adminApi = safeRequire('./adminApi');
const wallet = safeRequire('./wallet');
const health = safeRequire('./health');
const { testSecretAccess } = safeRequire('./testSecretAccess') || {};
const comms = safeRequire('./communicationService');
const KPIS = safeRequire('./kpis');
const userRoles = safeRequire('./userRoles');
const publicApi = safeRequire('./publicApi');
const publicProfiles = safeRequire('./publicProfiles');
const artistApi = safeRequire('./artistApi');
const automation = safeRequire('./automation');

// --- Phase-1 Booking System ---
const booking = safeRequire('./booking');
const bookingRequests = safeRequire('./bookingRequests');
const vendorApplications = safeRequire('./vendorApplications');
const searchService = safeRequire('./search/searchService');
const searchIndexer = safeRequire('./search/searchIndexer');
const manualReindex = safeRequire('./search/manualReindex');
const search = { ...(searchService || {}), ...(searchIndexer || {}), ...(manualReindex || {}) };
const pricing = safeRequire('./pricing');
const config = safeRequire('./config');

// --- Registration Functions ---
const bookRequest = safeRequire('./bookRequest');

// --- Phase-1 Operational Services ---
const availabilityService = safeRequire('./availabilityService');
const reconfirmationService = safeRequire('./reconfirmationService');
const backupService = safeRequire('./backupService');
const checklistService = safeRequire('./checklistService');
const partnerService = safeRequire('./partnerService');
const partnerPortal = safeRequire('./partnerPortal');
const partnerPayouts = safeRequire('./partnerPayouts');
const alertService = safeRequire('./alertService');
const inventoryService = safeRequire('./inventoryService');

// --- AI & Automation ---
const bioGenerator = safeRequire('./bioGenerator');
const aiAdmin = safeRequire('./aiAdmin');
const portfolioAnalysis = safeRequire('./portfolioAnalysis');
const portfolioCuration = safeRequire('./portfolioCuration');
const autoVerify = safeRequire('./kyc/autoVerify');

// --- Payments & KYC ---
const cashfreeBuilder = safeRequire('./payments/cashfree');
const { applyAutoPromoSpend } = safeRequire('./lib/autoPromoSpend') || {};
const cashfreeKyc = safeRequire('./kyc/cashfree');
const secureId = safeRequire('./kyc/secureId');
const cashfreePan = safeRequire('./kyc/cashfreePan');
const cashfreeAadhaar = safeRequire('./kyc/cashfreeAadhaar');
const cashfreeWebhook = safeRequire('./kyc/cashfreeWebhook');
const cashfreeBank = safeRequire('./kyc/cashfreeBank');
const chatLifecycle = safeRequire('./chatLifecycle');
const settlementPolicy = safeRequire('./config/settlementPolicy') || {};

// --- Other Features ---
const fcm = safeRequire('./fcm');
const testHarness = safeRequire('./testHarness');
const storageOptimization = safeRequire('./storageOptimization');
const adminFeatureFlags = safeRequire('./adminFeatureFlags');
const checkin = safeRequire('./checkin');
const quoteNotifications = safeRequire('./quoteNotifications');
const bookingPolicy = safeRequire('./bookingPolicy');
const nodeFetch = safeRequire('node-fetch');
const CASHFREE_SECRETS = [
    'CASHFREE_CLIENT_ID',
    'CASHFREE_CLIENT_SECRET',
    'CASHFREE_PAYOUT_CLIENT_ID',
    'CASHFREE_PAYOUT_CLIENT_SECRET',
    'CASHFREE_WEBHOOK_SECRET',
];

/**
 * Helper to export all functions from a safely required module.
 * @param {object|null} mod The module to export functions from.
 */
const exportModule = (mod) => {
    if (mod) {
        for (const [key, value] of Object.entries(mod)) {
            if (typeof value === 'function') {
                exports[key] = value;
            }
        }
    }
};

// --- Export All Functions ---

// Core Services
exportModule(adminApi);
exportModule(health);
exportModule(wallet);
exportModule(comms);
exportModule(KPIS);
exportModule(userRoles);
exportModule(publicApi);
exportModule(publicProfiles);
exportModule(artistApi);
const isEmulatorRuntime = String(process.env.FUNCTIONS_EMULATOR || '').toLowerCase() === 'true';
if (isEmulatorRuntime && testSecretAccess) exports.testSecretAccess = testSecretAccess;

// AI & Automation
exportModule(bioGenerator);
exportModule(aiAdmin);
exportModule(automation);
exportModule(portfolioAnalysis);
exportModule(portfolioCuration);
exportModule(autoVerify);

// Search
exportModule(searchService);
exportModule(searchIndexer);
exportModule(manualReindex);

// Phase-1 Booking Requests (admin-approved flow)
exportModule(bookingRequests);

// Vendor applications (admin review)
exportModule(vendorApplications);

// Phase-1 Operational Services
exportModule(availabilityService);
exportModule(reconfirmationService);
exportModule(backupService);
exportModule(checklistService);
exportModule(partnerService);
exportModule(partnerPortal);
exportModule(partnerPayouts);
exportModule(alertService);
exportModule(inventoryService);

// Other Features
exportModule(fcm);
if (String(process.env.ENABLE_TEST_HARNESS || '').toLowerCase() === 'true') {
    exportModule(testHarness);
}
exportModule(storageOptimization);
exportModule(adminFeatureFlags);
exportModule(checkin);
exportModule(quoteNotifications);
exportModule(chatLifecycle);
exportModule(bookingPolicy);

// Payments (Cashfree) – consolidate mobile createOrder/webhooks under services/functions
if (cashfreeBuilder) {
    try {
        // Ensure admin initialized at least once
        try { admin.app(); } catch (_) { admin.initializeApp(); }
        const db = admin.firestore();
        const pubsub = new PubSub();
        const computeDistribution = (amount) => {
            const amt = Number(amount) || 0;
            const GST = 0.18;

            // V1: Flat 9.9% platform fee with tiered minimums.
            const PLATFORM_FEE_RATE = 0.099;
            const PLATFORM_FEE_MIN_SMALL = 999;
            const PLATFORM_FEE_MIN_MEDIUM = 1999;
            const PLATFORM_FEE_NO_MIN_THRESHOLD = 50000;
            const PLATFORM_FEE_SMALL_THRESHOLD = 20000;
            const computedPlatformFee = Math.round(amt * PLATFORM_FEE_RATE);
            const platformFee = amt >= PLATFORM_FEE_NO_MIN_THRESHOLD
                ? Math.max(0, computedPlatformFee)
                : Math.max(amt < PLATFORM_FEE_SMALL_THRESHOLD ? PLATFORM_FEE_MIN_SMALL : PLATFORM_FEE_MIN_MEDIUM, computedPlatformFee);

            // Phase-1: no success fee/commission deducted from provider.
            const commission = 0;

            // V1: GST on platform fee only.
            const gstOnPlatformFee = Math.round(platformFee * GST);
            const gstOnCommission = 0;
            const gstCollectedTotal = gstOnPlatformFee;

            // ECO-TCS (GST Section 52) on provider service amount.
            const ECO_TCS_RATE = Number(
                settlementPolicy.ECO_TCS_RATE ?? process.env.ECO_TCS_RATE ?? '0.005'
            ); // default 0.5%
            const ecoTcsRate = Number.isFinite(ECO_TCS_RATE) && ECO_TCS_RATE >= 0 ? ECO_TCS_RATE : 0;
            const ecoTcsAmount = Math.max(0, Math.round(amt * ecoTcsRate));
            const tcsBorneByPlatform = settlementPolicy.ECO_TCS_BORNE_BY_PLATFORM !== false;

            // Provider payout (TCS is platform-borne by default).
            const artistGross = Math.max(0, amt);
            const artistNet = tcsBorneByPlatform
                ? artistGross
                : Math.max(0, artistGross - ecoTcsAmount);

            // Admin/platform collected amount from the client
            const adminAmount = Math.max(0, platformFee + gstOnPlatformFee);
            const platformRetained = adminAmount;
            
            return { 
                artistGross,
                artistNet,
                ecoTcsRate,
                ecoTcsWithheld: tcsBorneByPlatform ? 0 : ecoTcsAmount,
                ecoTcsPlatformCost: tcsBorneByPlatform ? ecoTcsAmount : 0,
                ecoTcsPayer: tcsBorneByPlatform ? 'platform_borne' : 'supplier_withheld',
                platformFee, 
                adminAmount, 
                commission, 
                platformRetained, 
                gstCollectedTotal,
                gstOnPlatformFee,
                gstOnCommission
            };
        };
        const cashfree = cashfreeBuilder({
            admin,
            functions: functionsV1,
            fetch: (global.fetch || nodeFetch.default || nodeFetch),
            db,
            pubsub,
            adminApi,
            computeDistribution,
            applyAutoPromoSpend: applyAutoPromoSpend || (async () => ({ skipped: 'not_configured' })),
            sendNotification: comms.sendNotification.bind(comms),
            notifyAdmin: comms.notifyAdmin.bind(comms),
            KPIS,
        });
        const paymentsRegion = regional().runWith({ secrets: CASHFREE_SECRETS });
        if (cashfree && cashfree.createOrder) {
            exports.createOrder = paymentsRegion.https.onCall(cashfree.createOrder);
        }
        // Admin/testing HTTP helpers removed from production exports
        // Testing endpoints (seedTestBooking, paymentsSelfTest, fullE2ESetup) not exported in prod
        if (cashfree && cashfree.handlePaymentWebhook) {
            exports.cashfreeWebhook = paymentsRegion.https.onRequest(cashfree.handlePaymentWebhook);
        }
        if (cashfree && cashfree.handlePayoutWebhook) {
            exports.cashfreePayoutWebhook = paymentsRegion.https.onRequest(cashfree.handlePayoutWebhook);
        }
        // Optional: releasePayout trigger (depends on computeDistribution). Enable when ready.
        if (cashfree && cashfree.releasePayout) {
            exports.releasePayout = paymentsRegion.firestore
                .document('bookings/{bookingId}')
                .onUpdate(cashfree.releasePayout);
        }
        // Scheduled payout auto-release (Phase-1): runs periodically to release staged payouts (0h + 12h after completion).
        if (cashfree && cashfree.payoutScheduler) {
            exports.payoutScheduler = functionsV1
                .region(process.env.FUNCTIONS_REGION || 'asia-south1')
                .pubsub.schedule('every 5 minutes')
                .onRun(cashfree.payoutScheduler);
        }
        // Payout worker (Pub/Sub subscriber) to process enqueued payouts
        if (cashfree && cashfree.payoutWorker) {
            const topicName = 'kalaqaar-payouts';
            exports.payoutWorker = functionsV1.region(process.env.FUNCTIONS_REGION || 'asia-south1')
                .pubsub.topic(topicName)
                .onPublish(cashfree.payoutWorker);
        }
    } catch (e) {
         
        console.warn('Cashfree payments wiring failed:', e?.message || e);
    }
}

// Phase-1 Booking System exports
if (booking) {
    if (booking.createBooking) {
        exports.createBooking = booking.createBooking;
    }
    if (booking.confirmBooking) {
        exports.confirmBooking = booking.confirmBooking;
    }
}

if (search) {
    if (search.searchArtists) {
        exports.searchArtists = search.searchArtists;
    }
    if (search.searchVendors) {
        exports.searchVendors = search.searchVendors;
    }
    if (search.getPopularArtists) {
        exports.getPopularArtists = search.getPopularArtists;
    }
    if (search.getArtistSuggestions) {
        exports.getArtistSuggestions = search.getArtistSuggestions;
    }
    if (search.checkArtistsAvailability) {
        exports.checkArtistsAvailability = search.checkArtistsAvailability;
    }
}

if (pricing) {
    if (pricing.calculateDJPrice) {
        exports.calculateDJPrice = pricing.calculateDJPrice;
    }
    if (pricing.getDJPricingTiers) {
        exports.getDJPricingTiers = pricing.getDJPricingTiers;
    }
    if (pricing.validatePricingParameters) {
        exports.validatePricingParameters = pricing.validatePricingParameters;
    }
}

if (config) {
    if (config.initializeMumbaiLaunch) {
        exports.initializeMumbaiLaunch = config.initializeMumbaiLaunch;
    }
    if (config.getMumbaiLaunchStatus) {
        exports.getMumbaiLaunchStatus = config.getMumbaiLaunchStatus;
    }
    if (config.updateMumbaiMetrics) {
        exports.updateMumbaiMetrics = config.updateMumbaiMetrics;
    }
}

// KYC exports
if (cashfreeKyc && cashfreeKyc.startUpiVerification) {
    exports.startUpiVerification = cashfreeKyc.startUpiVerification;
}
if (cashfreePan && cashfreePan.startPanVerification) {
    exports.startPanVerification = cashfreePan.startPanVerification;
}
if (cashfreeAadhaar && cashfreeAadhaar.generateAadhaarOtp) {
    exports.generateAadhaarOtp = cashfreeAadhaar.generateAadhaarOtp;
}
if (cashfreeAadhaar && cashfreeAadhaar.verifyAadhaarOtp) {
    exports.verifyAadhaarOtp = cashfreeAadhaar.verifyAadhaarOtp;
}
if (cashfreeAadhaar && cashfreeAadhaar.getAadhaarPortrait) {
    exports.getAadhaarPortrait = cashfreeAadhaar.getAadhaarPortrait;
}
const cashfreeFaceMatch = safeRequire('./kyc/cashfreeFaceMatch');
if (cashfreeFaceMatch && cashfreeFaceMatch.startFaceMatch) {
    exports.startFaceMatch = cashfreeFaceMatch.startFaceMatch;
}
if (cashfreeBank && cashfreeBank.startBankVerification) {
    exports.startBankVerification = cashfreeBank.startBankVerification;
}
if (cashfreeWebhook && cashfreeWebhook.cashfreeSecureIdWebhook) {
    exports.cashfreeSecureIdWebhook = cashfreeWebhook.cashfreeSecureIdWebhook;
}

// Cashfree Secure ID session + status
if (secureId && secureId.createKycSession) {
    exports.createKycSession = secureId.createKycSession;
}
if (secureId && secureId.getKycStatus) {
    exports.getKycStatus = secureId.getKycStatus;
}

if (bookRequest && bookRequest.bookRequest) {
    exports.bookRequest = bookRequest.bookRequest;
}
