# Keel

**A subscription system you can rehearse, prove and explain.**

Keel is one platform for running Brightloop Software: products, plans, quotes, subscriptions, recurring billing, payments and revenue. The keel is the backbone of a ship, and the brief asks for "the digital backbone" of a company that earns its money every month.

Most billing systems ask you to trust them. Keel is built so you don't have to:

| | The promise | How it works |
|---|---|---|
| **Rehearse** | See billing day before it happens | The billing engine is a pure function, so the same code that bills also previews, and writes nothing |
| **Prove** | Nothing billed twice or skipped | A Postgres exclusion constraint refuses overlapping periods, and 11 live checks prove the books |
| **Explain** | Every rupee has a reason | Each invoice stores its exact inputs, so any figure can be traced and replayed forever |

## Run it

Needs Node 22 or later. No Docker, no database install and no internet: Keel downloads and runs a real PostgreSQL 17 by itself.

```bash
npm install
```

```bash
npm run demo:reset
```

The first start takes about three minutes while it builds the app and loads the demo company. Then open http://localhost:8080 and use a role button on the sign-in page. `npm run demo` starts without resetting the data. `npm run dev` runs with hot reload on http://localhost:5173.

Optional settings are in [.env.example](.env.example). Gemini and SMTP are off by default, and every feature has a path that works without them.

## The brief, line by line

| The brief says | In Keel |
|---|---|
| One email, one account | Case-insensitive unique constraint on the column itself |
| Password of **more than** eight characters, with upper, lower and special | Enforced on server and form. Exactly 8 is rejected, and a test proves it |
| Reset link by email | Hashed, single-use, 30 minutes. The reply never reveals whether an email exists |
| Admin, staff and customer see different things | Checked on the server on every route. The portal is scoped to the signed-in customer, so guessing an id returns 404 |
| Only the admin adds staff | Public signup can only create customers |
| Product: name, type, sales price, cost price, notes, variants | Catalog. Brand: Odoo adds ₹560 and the invoice shows it |
| Plan: price, daily/weekly/monthly/yearly, minimum quantity, dates | Catalog, enforced when a subscription is created |
| Close on their own, or close early, pause, renew, plan by plan | Four switches per plan, followed by staff, customers and the daily run |
| Quotation template with validity days | Templates fill the plan and lines, and quotes expire on their own |
| Subscription number, customer, plan, dates, terms, lines | Subscription page, with tax shown line by line through the X-ray |
| Draft → Quotation → Confirmed → Active → Closed, visible to the team | Enforced state machine, a board, and a full history on each subscription |
| Hundreds of invoices on billing day | Parallel workers with `FOR UPDATE SKIP LOCKED`. 2,739 invoices in under 10 seconds |
| Taxes from admin rules | Tax rules with CGST + SGST, IGST or zero-rated export. The place of supply comes from the customer's state |
| Confirm, cancel, send, print; Draft → Confirmed → Paid | All on the invoice. Cancelling asks whether to bill the period again or write it off |
| Nothing billed twice or skipped | Exclusion constraint, catch-up after downtime, and the Proof page |
| Discounts: fixed or percent, minimums, dates, usage limit, products or whole subscription | Admin only, enforced on the server. The limit also holds as a database constraint |
| Appears on the next invoice by itself, and stops when it expires or runs out | The engine decides per invoice. A cancelled invoice gives the use back |
| Payments: method, amount, date, note, against the right invoice | Part payments on different days, and overpayment is refused by the database |
| See paid and outstanding, chase overdue | Collections, sorted by money at risk. Reminders go at 1, 7, 15 and 30 days |
| Active subs, revenue, payments, overdue, with filters | Revenue page, with date, plan, size and state filters and CSV export |
| Under two seconds with thousands of subscriptions | 10,242 subscriptions and 91,668 invoices, with 10 simultaneous users on the production build: slowest page p95 about 400 ms from cold and about 150 ms warm. Run `npm run bench` to reproduce it |

The brief's list of today's pains gets its own answers too:

| Today | In Keel |
|---|---|
| Renewals remembered by whoever notices | Renewals page and automatic renewal. Contracts that need a person are called out with their MRR at risk |
| Matching payments by scrolling bank statements | **Bank matching.** Drop in a statement and Keel posts what it is sure of, including TDS deductions and one payment covering two invoices, and explains the rest |
| "Nobody can say how much recurring revenue we have" | MRR with yearly plans counted as one twelfth, and a bridge of new, expansion, reactivation, contraction and churn that must add up |
| Add-ons customers switch on and off | Self-service in the portal, showing the prorated cost before it changes anything |

## What makes it different

**Billing rehearsal.** Keel computes every invoice for a day without writing anything, then flags real problems: a missing tax rule, an amount that jumped, a discount about to run out. The real run follows the same plan and reports the difference, which is ₹0.00.

**Time machine.** The business clock moves one day at a time, running the same code production runs. A month of activations, renewals, billing, reminders and simulated customer payments can be watched in a minute.

**Try to break it.** One button attacks the database with a duplicate period. Another races three billing runs against each other while 12% of workers crash, then sends rogue writes at every result. None gets through.

**Invoice X-ray.** Every number on an invoice traces to the rule that made it. The trace is recomputed from stored inputs, so what you see is what the engine really did. Customers get it too, as "Why this amount?"

**Proof page.** Eleven questions asked of the live data, each of which must answer zero. The SQL is on screen.

**Tide chart.** Thirty days of what happened beside forty-five days of what your contracts say comes next. Click any future day to rehearse it.

**Built for India.** GST split by place of supply, gapless invoice numbers per financial year as Rule 46 requires, TDS recognised in bank matching, and rupees grouped in lakhs and crores.

**AI that handles reading, not money.** Gemini reads PDF and photo statements, explains uncertain matches and answers plain-language questions through read-only tools, so it never writes SQL. Deterministic code alone decides what gets posted. Without a key, Keel falls back to rules, so a bad connection cannot break a demo.

## How it is built

```
server/engine/     Pure logic, no database and no clock: dates, money, invoices, matching
server/db/         Schema, migrations, and a seed that goes through the real engine
server/services/   Billing, subscriptions, daily run, reports, proof, bank matching, AI
server/routes/     HTTP, with validation and role checks
web/               React app and customer portal
tests/             41 engine tests, 45 integration tests against real Postgres
```

**The guarantees live in the database**, so a bug in application code still cannot break them:

- `never_billed_twice`: an exclusion constraint on subscription and date range
- Triggers make confirmed invoices immutable, even to direct SQL
- Paid status comes from allocations through a trigger, so the two cannot disagree
- `CHECK` constraints stop overpayment, overspent discounts and totals that do not add up
- A hash-chained, append-only audit log

**Money is integer paise.** Floats never touch an amount. Allocation uses largest remainder, so no paisa is lost or invented.

**Dates are calendar dates**, computed from a fixed anchor, so a 31 January subscription bills on 28 February and then 31 March instead of drifting to the 28th forever.

## Tests

```bash
npm test
```

```bash
npm run test:integration
```

```bash
npm run bench -- http://localhost:8080 10
```

The integration suite runs on a real Postgres and attacks the system on purpose: bad filters, impossible dates, oversized values, guessed ids, 8-character passwords, racing runs, crashing workers, rogue writers, overpayment by direct SQL, a tampered audit log, and a scheduler that died three months ago.

## Deploying to Google Cloud

```bash
export PROJECT_ID=your-project
```

```bash
bash deploy/gcp.sh
```

This sets up Cloud Run, Cloud SQL for PostgreSQL 17 and Secret Manager, then seeds the data. Afterwards, stop the database to save credit:

```bash
gcloud sql instances patch keel-db --activation-policy=NEVER
```

## Honest limits

- `deploy/gcp.sh` and the Dockerfile have not been run yet. Local testing used the production bundle directly.
- The automated tests run AI features through the rules fallback, so they stay fast and need no key. Gemini was checked by hand with a live key.
- Customer checkout in the portal is simulated. A real gateway would plug into `recordPayment`.
- Sending real email needs `SMTP_URL`. Until then, every message is in the Outbox page, and reset links for `.demo` addresses appear on the reset screen.
- Credit notes are out of scope. Cancellation with re-billing covers corrections.
- GST e-invoicing through the IRP is not integrated. The SAC codes in the demo data are illustrative and need an accountant's review before real use.
- MRR is measured at list price, before discounts.
- The report cache assumes one server instance, which is how the deployment is configured.
