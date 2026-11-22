# Student External Defence Portal — Payment Reliability Upgrade

A mobile-friendly HTML/CSS/vanilla-JS frontend with a Node.js/Express backend, MongoDB persistence, Flutterwave hosted checkout (Standard), signature-verified webhooks, transaction verification, retry-safe webhook processing, idempotent payment initialization, order-status lookup, automatic reconciliation, and protected admin endpoints.

> **Authorisation and identity:** This is a demonstration/starter project, not an official Bayero University Kano (BUK) website or approved payment channel. Do not publish it as BUK-authorised, use an official university logo, or collect money under the university's name unless you have written permission. The 30 candidate aliases are placeholders, not verified eligibility records. Confirm the project scope, prices, fund recipient, domain/hosting ownership, refund policy, privacy notice, and university authorisation before accepting money.

## Pricing implemented

All prices are plain Naira (NGN). There is no currency conversion.

| Item | NGN |
|---|---:|
| Hosting | ₦308,000.00 |
| Premium database | ₦77,000.00 |
| .com domain | ₦92,400.00 |
| .ng domain | ₦77,000.00 |
| Total with .com | ₦477,400.00 |
| Total with .ng | ₦462,000.00 |

Only one domain is included in a package. The server calculates all prices; it does not trust an amount sent by the browser. Flutterwave receives the amount in **naira** (major units, e.g. `477400`), not kobo.

## Requirements and setup

- Node.js 18 or later (native `fetch`, `AbortSignal.timeout`, and `node:test` are used).
- MongoDB Atlas or another **replica-set-enabled** MongoDB deployment. The application uses multi-document transactions.
- Flutterwave account and API keys. Start with test keys.

```bash
npm install
cp .env.example .env
# Edit .env with your own MongoDB URI, Flutterwave TEST keys, and admin token.
npm run dev
```

Open `http://localhost:3000`. Run the unit tests with:

```bash
npm test
```

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port supplied by the host; defaults to 3000. |
| `BASE_URL` | Public base URL used for Flutterwave's browser redirect. Use your HTTPS Render URL in production. |
| `MONGODB_URI` | MongoDB connection string. Use a replica-set-enabled cluster (MongoDB Atlas is suitable). |
| `FLW_SECRET_KEY` | Private server-side Flutterwave key (`FLWSECK_TEST-...` in test mode) for creating checkouts and verifying transactions. |
| `FLW_SECRET_HASH` | A long random string **you choose**. Paste the same value into Flutterwave's webhook settings; it is how we know a webhook really came from Flutterwave. |
| `ADMIN_API_TOKEN` | Long random secret protecting read-only order monitoring, manual reconciliation, and refund-recording endpoints. |
| `SUPPORT_EMAIL` | Optional contact email. |

Do not commit `.env`, publish credentials, or place `FLW_SECRET_KEY` / `FLW_SECRET_HASH` / `ADMIN_API_TOKEN` in frontend files.

## Render and Flutterwave deployment

1. Deploy this project as a Render **Web Service**.
2. Set the environment variables in Render's Environment page. Set `BASE_URL` to `https://YOUR-SERVICE.onrender.com`.
3. Set `MONGODB_URI` to the Atlas connection string and ensure Atlas network access permits the Render service.
4. Add your Flutterwave TEST secret key to `FLW_SECRET_KEY` and choose a random `FLW_SECRET_HASH`.
5. In Flutterwave Dashboard > Settings > Webhooks, set the URL to `https://YOUR-SERVICE.onrender.com/api/flutterwave/webhook`, paste the same secret hash, and enable webhooks.
6. Test all payment scenarios below with test mode before switching both dashboard and server to live keys.

The customer redirect URL is `https://YOUR-SERVICE.onrender.com/payment/callback` (Flutterwave appends `status`, `tx_ref` and `transaction_id`; the server ignores `status` and re-verifies with Flutterwave). It is different from the webhook URL.

## Project structure (MVC)

```text
server.js              boot only: connect DB, listen, start jobs, graceful shutdown
app.js                 builds the Express app (importable by tests)
config/                env + tunable numbers, DB connection
constants/             order statuses, webhook states
models/                Order, WebhookReceipt, AdminAudit            (Model)
public/                HTML/CSS/JS                                  (View)
routes/                URL -> middleware -> controller
controllers/           req/res only                                 (Controller)
services/              business logic: order, flutterwave, webhook, reconciliation, admin
middleware/            requireAdmin, rateLimit, requireDatabase, errorHandler
validators/            input checking
helpers/               pure domain logic (prices, HMAC, state transitions, backoff)
utils/                 generic tools (logger, AppError, concurrency, rate counter)
jobs/                  background reconciliation and webhook sweep
test/                  unit tests + HTTP smoke tests
```

New to MVC? Read **`docs/MVC_GUIDE.md`**, which also lists every bottleneck fixed in this version.

## Payment design and consistency model

There is no distributed database transaction that can atomically commit a Flutterwave operation and a MongoDB write at the same instant. This application therefore uses a **saga/reconciliation approach**: persist the order first, call Flutterwave with a stable `tx_ref`, verify gateway state server-to-server, and reconcile durable local state until it agrees with Flutterwave. MongoDB transactions make the local order update and webhook receipt completion atomic with each other.

### 1. Idempotent initialization

- The browser creates an `Idempotency-Key` for one form attempt and keeps it in `sessionStorage` across refreshes/redirects.
- MongoDB enforces a unique index on that key.
- The server binds the key to a hash of the customer's name, email, and domain. Reusing it with different details is rejected.
- A retry uses the same saved order and Flutterwave `tx_ref`. It does not create a second order for a repeated network request.
- The server refuses a second concurrent initialization while the first is being prepared.
- A unique active-checkout email field prevents a second active order for the same email across tabs or refreshes; terminal outcomes release that lock.
- A new key is only appropriate for a genuinely new payment attempt after checking the previous order state.

### 2. Webhook inbox, retries, and duplicates

The webhook route is registered before `express.json()` so the webhook signature can be checked against Flutterwave's original raw request bytes.

Each distinct raw event is stored in `webhookreceipts` with a processing state:

`received → processing → processed`

The webhook handler saves the receipt, answers `200` immediately, and verifies with Flutterwave in a background queue. A temporary failure moves the receipt to `retryable` (with backoff; after 10 attempts it becomes `dead` for manual attention), and a one-minute sweep retries unfinished receipts. A processing lease lets another delivery recover an event if the server crashed while processing it. A repeated event already marked `processed` is acknowledged without applying the payment twice. A repeated event that is still unfinished is simply re-queued; the lease prevents double processing.

Flutterwave sends `charge.completed` for both successful and failed charges. The server asks Flutterwave to verify the `tx_ref`. It does not trust the event's status or amount alone. A stale failed notification cannot downgrade a verified successful payment.

### 3. Atomic local payment commit

After Flutterwave verification, a MongoDB transaction:

- Checks the saved order's reference, status, currency, and exact naira amount.
- Moves a matching successful order to `paid` only once.
- Moves mismatched data to `review_required`.
- Records failed results without overwriting `paid` or `refunded`.
- Marks the corresponding webhook receipt `processed` in the same transaction.

If the transaction fails, neither the order update nor receipt completion is committed. Flutterwave can retry the webhook, or the scheduled reconciler can retry the order.

### 4. Failure, abandonment, and expiry

- `failed`: Flutterwave verification reports a failed transaction.
- `verification_pending`: Flutterwave has not yet returned a final result.
- `expired`: the local 24-hour checkout window elapsed without a confirmed successful payment.
- `review_required`: verified transaction details do not match the stored order.

A pending order is not declared failed just because the browser closes. An expired or failed order can still be reconciled to `paid` if Flutterwave later verifies a successful charge. If a student reports a debit while the order is not paid, support must reconcile the reference before asking them to pay again.

### 5. Browser refresh and revisiting

`/order?reference=...` is a persistent order-status page. It reads the saved order from MongoDB, displays its current state, and can be refreshed safely. Visiting the page never marks an order paid. Only server-side Flutterwave verification can do that.

The status endpoint exposes only a limited set of order fields. The reference contains random entropy and should still be treated as private; do not post it publicly.

### 6. Scheduled reconciliation

Every five minutes the server picks orders that are **due** (`nextReconcileAt`), oldest due-time first, and verifies them with Flutterwave five at a time. After each check the order is rescheduled with exponential backoff and jitter: live orders every 2 to 30 minutes, closed ones (`failed`/`abandoned`/`expired`) every 30 minutes to 6 hours for 7 days, then they are left alone (an admin can still reconcile manually at any time). Temporary network errors leave the order unchanged. Orders older than 24 hours with no confirmed success are expired only after a verification attempt. Stuck `initializing` orders whose reference Flutterwave has never seen are closed and their email lock released.

Each order is claimed with a short compare-and-set lease, so running more than one instance is safe: two instances never verify the same order. Jobs wait for the previous run to finish and never overlap.

## Admin monitoring API

The admin API is disabled unless `ADMIN_API_TOKEN` is configured. Send it in the `x-admin-token` header. Do not expose this token in a browser page or give it to students.

List recent orders:

```bash
curl -H 'x-admin-token: YOUR_ADMIN_TOKEN' \
  'https://YOUR-SERVICE.onrender.com/api/admin/orders?limit=50'
```

Filter by status:

```bash
curl -H 'x-admin-token: YOUR_ADMIN_TOKEN' \
  'https://YOUR-SERVICE.onrender.com/api/admin/orders?status=review_required'
```

Manually reconcile an order against Flutterwave:

```bash
curl -X POST -H 'x-admin-token: YOUR_ADMIN_TOKEN' \
  'https://YOUR-SERVICE.onrender.com/api/admin/orders/ORDER_REFERENCE/reconcile'
```

Record a refund **after an authorised account owner has actually initiated/confirmed it in Flutterwave**:

```bash
curl -X POST -H 'x-admin-token: YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"refundReference":"FLUTTERWAVE_REFUND_ID","reason":"Duplicate payment confirmed in Flutterwave"}' \
  'https://YOUR-SERVICE.onrender.com/api/admin/orders/ORDER_REFERENCE/refund-record'
```

The refund-record endpoint does not initiate a refund and must not be used as proof by itself. The administrator must first confirm the refund in Flutterwave. Admin actions are written to the `adminaudits` collection. For a larger operation, replace the shared token with individual admin accounts, role-based permissions, MFA, and a proper audit viewer.

## MongoDB collections

- `orders`: one payment attempt per idempotency key; stores the exact server-calculated amount and current state.
- `webhookreceipts`: durable webhook inbox, retry state, lease, attempt count, and processing outcome.
- `adminaudits`: manual reconciliation and refund-recording audit entries.

## Status lifecycle (simplified)

```text
pending / initializing / initialization_unknown
                 |
          Flutterwave verification
       /          |             \\
    paid        failed       abandoned
      |             
      +----> review_required (only when verified details mismatch)

pending / verification_pending -- after 24h with no verified success --> expired
```

A later verified successful transaction is allowed to reconcile a prior failed/abandoned/expired local status to `paid`; the gateway's verified record is authoritative. `paid` and `refunded` are never downgraded by a late failure event.

## How to read the code (learning path)

1. **`docs/MVC_GUIDE.md`**: the pattern, one request traced end to end, and the bottleneck list.
2. **`docs/LEARNING_GUIDE.md`**: payment concepts (idempotency, webhooks, atomicity).
3. **`helpers/payments.js`** and **`helpers/orderTransitions.js`**: pure functions; start with the tests in `test/`.
4. **`models/Order.js`**, **`models/WebhookReceipt.js`**: schemas, states, indexes.
5. **`routes/` then `controllers/payment.controller.js`**: how a URL reaches code.
6. **`services/order.service.js`**: validation result in, idempotent order out; save before calling Flutterwave.
7. **`services/webhook.service.js`**: inbox, lease, background processing, sweep.
8. **`services/reconciliation.service.js`**: `commitVerifiedResult()` (the atomic boundary) and `sweepOrders()`.
9. **`public/order.js`**: a frontend that reads saved state rather than deciding anything.

Useful concepts to study: idempotency, state machines, HMAC signatures, timing-safe comparison, database transactions, leases, retry/backoff, eventual consistency, and the saga pattern.

## Test checklist before real payments

Use Flutterwave test mode and verify each scenario deliberately:

1. Successful payment: exactly one order becomes `paid` with the correct transaction ID.
2. Failed payment: order becomes `failed`, unless Flutterwave verification shows a success.
3. Abandoned checkout: remains accurately classified; a browser close alone does not mark it failed.
4. Duplicate webhook: replay the same signed body several times; only one payment state transition occurs.
5. Temporary Flutterwave verification outage: receipt becomes `retryable` and the webhook sweep completes it later.
6. Server restart during webhook processing: the processing lease expires and a later delivery can recover it.
7. Browser refresh/close: reopening the order status page shows the saved database state.
8. Multiple rapid clicks/network retries: same idempotency key produces one order/reference.
9. Different form details with the same key: server rejects the request.
10. Wrong amount/currency/reference: order becomes `review_required`, never `paid`.
11. Late success after local expiry: successful Flutterwave verification reconciles the order to `paid`.
12. Stale `charge.failed` after success: the order remains `paid`.
13. Refund: verify the refund in Flutterwave first, then record its reference in the admin audit trail.
14. MongoDB unavailable: payment initialization is unavailable and no false success is shown.

## Important operational limitations

- No code can guarantee perfect payment atomicity across Flutterwave and MongoDB because they are separate services. This project uses durable local transactions plus gateway verification and reconciliation to converge safely.
- MongoDB multi-document transactions require a replica set or sharded cluster. A standalone local MongoDB server will not support this transaction path.
- The scheduler runs inside the web process. Order checks are lease-protected, so extra instances are safe, but a dedicated worker is still cleaner at larger scale.
- Rate limits are in memory per instance. Use a shared store (e.g. Redis) if you scale out.
- Old indexes from the previous version (`status_1`, `expiresAt_1`) stay in an existing database; they are harmless and can be dropped manually.
- The admin API uses a shared bearer token, not a full identity system. Protect it carefully and rotate it if exposed.
- Refunds are not automatically initiated. Only an authorised Flutterwave account owner should issue them; this app records a confirmed refund reference.
- The generated candidate aliases are sample content. Do not present them as real student eligibility information.
- This code has unit tests for pure payment utilities, but it has not been deployed against your Render service or exercised against your Flutterwave account. Complete the checklist above in test mode first.
