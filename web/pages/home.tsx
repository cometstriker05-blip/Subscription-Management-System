import { ArrowRight, Waves } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { TideChart } from '../charts';
import { compact, date, money, number, shortDate, weekday } from '../lib/format';
import { useMe } from '../shell';
import { ErrorNote, Loading, useGet, useTitle } from '../ui';

const SCENES = [
  ['A new customer signs up', 'One account per email, and a different view for each role', '/catalog/team'],
  ['Launching a new plan', 'Variants like Odoo adding ₹560, and rules plan by plan', '/catalog/plans'],
  ['Quote to subscription', 'Start from a template, then Draft through to Closed', '/subscriptions/board'],
  ['Billing day', 'Rehearse it, run it, and watch nothing bill twice', '/billing'],
  ['A better price', 'Discounts that apply and stop by themselves', '/catalog/discounts'],
  ['The money comes in', 'Drop in a bank statement instead of scrolling through it', '/reconcile'],
  ['Month end', 'One place for revenue, with every figure traced', '/revenue'],
  ['Proof', 'Eleven promises checked live against the books', '/integrity'],
];

// Painted on the bow of a ship to show how deep it sits. Purely decorative here.
const DRAFT_MARKS = ['14', '12', '10', '8', '6', '4'];

export default function Home() {
  useTitle('Bridge');
  const { data: me } = useMe();
  const navigate = useNavigate();
  const { data, error, isLoading } = useGet<any>('/home');
  const proof = useGet<any>('/integrity/checks');

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <div style={{ paddingTop: 24 }}><Loading height={480} /></div>;
  const { summary: s, tide, nextBillingDay, today } = data;
  const passed = proof.data?.checks.filter((c: any) => c.violations === 0).length;

  const orders = [
    s.dueNow > 0 && { n: number(s.dueNow), title: 'subscriptions due for billing', detail: 'Rehearse first, then run', to: '/billing' },
    s.drafts.n > 0 && { n: number(s.drafts.n), title: 'draft invoices to confirm', detail: money(s.drafts.amount), to: '/invoices?status=draft' },
    s.overdue.invoices > 0 && { n: number(s.overdue.invoices), title: 'invoices overdue', detail: `${money(s.overdue.amount)} to chase`, to: '/collections' },
    s.renewals.soon > 0 && { n: number(s.renewals.soon), title: 'contracts expire in 30 days', detail: 'Most renew by themselves', to: '/renewals?days=30' },
    s.expiringQuotes > 0 && { n: number(s.expiringQuotes), title: 'quotations expire within 3 days', detail: 'Follow up now', to: '/subscriptions?status=quotation' },
  ].filter(Boolean) as { n: string; title: string; detail: string; to: string }[];

  return (
    <>
      <section className="hull">
        <div>
          <div className="hull-eyebrow">{weekday(today)}, {date(today)}. Good to see you, {me?.user?.name.split(' ')[0]}.</div>
          <div className="hull-figure">{compact(s.mrr)}</div>
          <div className="hull-label">Monthly recurring revenue <span>{compact(s.arr)} a year</span></div>
          <div className="hull-actions">
            {nextBillingDay && (
              <Link to="/billing" className="btn primary"><Waves size={17} /> Next billing day, {shortDate(nextBillingDay.date)}: {number(nextBillingDay.count)} due</Link>
            )}
            {proof.data && <Link to="/integrity" className="btn">{passed} of {proof.data.checks.length} proofs hold</Link>}
          </div>
        </div>
        <div className="hull-side">
          <Link to="/subscriptions?status=active"><span>Active subscriptions</span><strong>{number(s.active)}</strong></Link>
          <Link to="/subscriptions/board"><span>In the pipeline</span><strong>{number(s.pipeline)}</strong></Link>
          <Link to="/renewals?days=30"><span>Renewing in 30 days</span><strong>{number(s.renewals.soon)}</strong></Link>
        </div>
        <div className="draft" aria-hidden="true">{DRAFT_MARKS.map((mark) => <span key={mark}>{mark}</span>)}</div>
      </section>
      <div className="boot-line" />
      <section className="bilge">
        <Link to="/collections"><div className="bilge-figure">{compact(s.overdue.amount)}</div><div className="bilge-label">Overdue, across {number(s.overdue.invoices)} invoices</div></Link>
        <Link to="/payments"><div className="bilge-figure">{compact(s.collectedThisMonth)}</div><div className="bilge-label">Collected this month</div></Link>
        <Link to="/billing"><div className="bilge-figure">{number(nextBillingDay?.count ?? 0)}</div><div className="bilge-label">Due on {nextBillingDay ? shortDate(nextBillingDay.date) : 'the next billing day'}</div></Link>
      </section>

      <div className="card">
        <div className="card-head">
          <div><h2>Tide chart</h2><div className="small muted">What happened, then what your contracts say comes next. Click a day to rehearse it.</div></div>
        </div>
        <div className="card-body">
          <TideChart days={tide.days} today={tide.today} onPick={(d) => navigate(`/billing?date=${d}`)} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 4 }}>
        <div className="card-head"><h2>Orders of the day</h2></div>
        <div className="agenda">
          {orders.length === 0 && <div className="empty"><h3>All clear</h3>Nothing needs you right now.</div>}
          {orders.map((item) => (
            <Link key={item.to} to={item.to}>
              <span className="big">{item.n}</span>
              <span><span className="strong">{item.title}</span><br /><span className="small muted">{item.detail}</span></span>
              <ArrowRight size={18} color="var(--ink)" />
            </Link>
          ))}
        </div>
      </div>

      <nav className="course" aria-label="A month at Brightloop">
        {SCENES.map(([title, detail, to], i) => (
          <Link key={title} to={to} className="scene">
            <span className="n">{String(i + 1).padStart(2, '0')}</span>
            <span className="scene-title">{title}</span>
            <span className="scene-note">{detail}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
