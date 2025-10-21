Quick backend flows (where to look)

- Booking / payments: `services/functions/src/payments` and `services/functions/src/cashfree` — key functions: `createOrder`, `handleCashfreeWebhook`, `confirmPayment`.
- Payouts / ledger: `services/functions/src/payouts` — look for `enqueuePayoutJob`, `releasePayout`, and `platformLedger` writes. These use Pub/Sub topic `kalaqaar-payouts`.
- Artist onboarding: `services/functions/src/onboarding` — handlers like `registerArtistLead`, `txReserveOrUpgradePhone`, and `adminTasks` enqueueing.
- Media moderation: `services/functions/src/media` — Storage triggers that call FFmpeg + moderation (look for `mediaWatermark` and `moderateMedia`).

Quick QA checklist (local validation)

1. Load config for the env you will test:

```bash
node config.js load staging
node config.js validate $FIREBASE_PROJECT_ID $FIREBASE_WEB_API_KEY
```

2. Start emulators (recommended for work touching Functions or Firestore):

```bash
firebase emulators:start --only functions,firestore,hosting --project <local-project-id>
```

3. Run Functions unit tests and a small integration against emulators:

```bash
cd services/functions
npm install
npm run config:load
npm run lint
npm run test:functions
```

4. If you modify payout or ledger logic, run a dry E2E flow in emulators: createOrder → emulate webhook → assert `walletTransactions` / `platformLedger` writes and Pub/Sub enqueue.

5. Before creating PR: list changed feature flags and secrets you touched (names only). Verify alerts and `auditLogs` entries if applicable.

Files to mention in PRs

- `config.js` — env loader
- `services/functions/src/**` — functions you changed
- `featureFlags.js` — any new runtime flags
- Firestore rules / indexes if the change requires them

Act as Kalaqaar’s reviewer: prefer small, test-backed changes and include which config/env was used to validate.
