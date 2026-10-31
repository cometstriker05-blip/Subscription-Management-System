# The five-minute demo

Reset before you start, so the clock is back at 31 Oct 2026:

```bash
npm run demo:reset
```

Open http://localhost:8080 at full screen. Sign in with the **Admin** button.

## The opening (30 seconds)

> "Every team here built a billing system you have to trust. We built one you can rehearse, prove and explain. It's called Keel, the backbone of a ship, because the brief asks for the digital backbone of this company."

Show **Bridge**. Point to the tide chart.

> "The left of this line is what happened. The right is what the contracts say comes next. And up here: over ten thousand subscriptions, and this badge is how fast this page loaded."

## Rehearse (60 seconds)

Click the date at top right to open the **Time machine**, choose **Next billing day**, then **Go**. It stops on 1 Nov.

On **Billing day**, click **Rehearse billing day**.

> "Thousands of invoices, computed in under a second, and nothing has been written. It's the real billing engine, running ahead of time. And it found things a person would miss: invoices that dropped by half, a discount that runs out partway through this run."

Click **Bill all invoices**, and watch the bar.

> "Now it's real. And look: rehearsed, billed, difference zero rupees, to the paisa."

Click **Confirm and number all**.

## Prove (60 seconds)

Scroll to **Try to break it**. Click **Try to bill a period twice**.

> "This skips all our code and goes straight at the database. Postgres refuses. It isn't an if-statement that someone can forget. Billing twice is impossible."

Open **Proof** in the side menu.

> "Most systems promise their books are right. Keel asks eleven questions of the live data, and each answer must be zero. The query is right there. Anyone can check."

## Explain (45 seconds)

Search for **Malabar**, open it, and open the newest invoice.

> "This is a proper GST invoice. Beside it is the X-ray. Every number traces to the rule that made it. Here's the brief's own example: Odoo adds 560. Here's the discount, here's the tax, split into CGST and SGST because they're in Kerala. This was just recomputed from stored inputs, and it matches."

## The money comes in (45 seconds)

Open **Bank matching**, click **Use a sample statement**.

> "The brief says payments get matched by scrolling through bank statements. Now you drop one in. Most lines post themselves, even the mangled references. This customer deducted 10% TDS, and Keel knew that wasn't a short payment. This one payment covers two invoices. And anything it isn't sure of, it asks about, and explains why."

## The finance lead (30 seconds)

Open **Revenue**.

> "The questions that took days are now one page, with filters. And this bridge has to add up, because every change in revenue is one row. Yearly plans count as one twelfth, which is why this company can finally say what its recurring revenue is."

## The customer (30 seconds)

Sign out, and use the **Customer** button. Open the subscription and switch on **Single Sign-On**.

> "Customers manage this themselves, and they see the cost before anything changes. No email to anyone."

## The close (15 seconds)

> "Rehearse it, prove it, explain it. That's Keel."

---

## Questions judges may ask

**Why not build on Odoo?** The brief asks for a system, and the point here is guarantees at the database level. Our concepts map directly to Odoo's: recurring plans with closable, pausable and renewable options, quotation templates, and subscription stages.

**What stops two people billing at once?** Workers claim subscriptions with `FOR UPDATE SKIP LOCKED`. Even if that failed, the exclusion constraint would refuse the second invoice.

**What if the server dies halfway through billing?** Each subscription bills in its own transaction. Run it again and only what's left gets billed. The chaos run does exactly this.

**What if billing didn't run for three months?** Keel catches up every missed period, in order. There's a test for it.

**How do you fix a wrong invoice?** Cancel it and choose to bill the period again. The number stays used, because GST numbering can't have gaps, and the next run raises a corrected invoice.

**Is the AI making financial decisions?** No. Gemini reads documents and explains things. Deterministic rules decide what gets posted, and below a confidence bar a person decides.

**Is the data real?** It's simulated, but generated through the real engine, so every invoice can be audited and replayed like a live one.

**Would it scale?** With 10 simultaneous users on 10,000 subscriptions and 90,000 invoices, the slowest page stayed under 400 ms at p95 from a cold start and around 150 ms warm. `npm run bench` reproduces it.

## Before you go on stage

Run `npm run demo:reset` and open the app once, so the first page isn't a cold start. Everything works offline. Rehearse the path at least twice, because each billing run moves the data forward and `demo:reset` takes about a minute. If the server ever stops, the demo runner restarts it by itself within a few seconds, and the books stay correct.
