import { ArrowRight } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { TideChart } from '../charts';
import { compact, date, money, number, shortDate, weekday } from '../lib/format';
import { useMe } from '../shell';
import { ErrorNote, Loading, Stat, useGet, useTitle } from '../ui';

const SCENES = [
  ['A new customer signs up', 'Sign up, reset a password, and see that each role gets a different system', '/catalog/team'],
  ['Launching a new plan', 'Products with variants, like Odoo adding ₹560, and plan-by-plan rules', '/catalog/plans'],
  ['Turning a quote into a subscription', 'Start from a template and move Draft to Closed', '/subscriptions/board'],
  ['Billing day', 'Rehearse it, run it, and watch nothing bill twice', '/billing'],
  ['A customer asks for a better price', 'Discount rules that apply and stop on their own', '/catalog/discounts'],
  ['The money comes in', 'Drop in a bank statement instead of scrolling through it', '/reconcile'],
  ['The finance lead, at month end', 'One place for revenue, with every figure traced', '/revenue'],
  ['Proof', 'Eleven promises checked live against the books', '/integrity'],
];

export default function Home() {
  useTitle('Bridge');
  const { data: me } = useMe();
  const navigate = useNavigate();
  const { data, error, isLoading } = useGet<any>('/home');
  const proof = useGet<any>('/integrity/checks');

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={480} />;
  const { summary: s, tide, nextBillingDay, today } = data;
  const passed = proof.data?.checks.filter((c: any) => c.violations === 0).length;

  const agenda = [
    s.dueNow > 0 && { n: number(s.dueNow), title: 'subscriptions due for billing', detail: 'Rehearse first, then run', to: '/billing' },
    s.drafts.n > 0 && { n: number(s.drafts.n), title: 'draft invoices to confirm', detail: money(s.drafts.amount), to: '/invoices?status=draft' },
    s.overdue.invoices > 0 && { n: number(s.overdue.invoices), title: 'invoices overdue', detail: `${money(s.overdue.amount)} to chase`, to: '/collections' },
    s.renewals.soon > 0 && { n: number(s.renewals.soon), title: 'contracts expire in 30 days', detail: 'Most renew by themselves', to: '/renewals?days=30' },
    s.expiringQuotes > 0 && { n: number(s.expiringQuotes), title: 'quotations expire within 3 days', detail: 'Follow up now', to: '/subscriptions?status=quotation' },
  ].filter(Boolean) as { n: string; title: string; detail: string; to: string }[];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{weekday(today)}, {date(today)}</h1>
          <p>Good to see you, {me?.user?.name.split(' ')[0]}. {nextBillingDay ? `The next big billing day is ${shortDate(nextBillingDay.date)}, with ${number(nextBillingDay.count)} subscriptions due.` : ''}</p>
        </div>
        {proof.data && (
          <Link to="/integrity" className={`badge ${proof.data.passed ? 'good' : 'bad'}`} style={{ padding: '5px 12px' }}>
            {passed} of {proof.data.checks.length} proofs hold
          </Link>
        )}
      </div>

      <div className="grid five">
        <Stat label="Monthly recurring revenue" value={compact(s.mrr)} foot={money(s.mrr)} href="/revenue" />
        <Stat label="Annual run rate" value={compact(s.arr)} foot="MRR × 12" href="/revenue" />
        <Stat label="Active subscriptions" value={number(s.active)} foot={`${number(s.pipeline)} in the pipeline`} href="/subscriptions?status=active" />
        <Stat label="Collected this month" value={compact(s.collectedThisMonth)} foot={`${compact(s.collected30)} in the last 30 days`} href="/payments" />
        <Stat label="Overdue" value={compact(s.overdue.amount)} foot={`${number(s.overdue.invoices)} invoices`} alert href="/collections" />
      </div>

      <div className="card mt-16">
        <div className="card-head">
          <div><h2>Tide chart</h2><div className="small muted">30 days of what happened, 45 days of what your contracts say comes next. Click a day to rehearse it.</div></div>
        </div>
        <div className="card-body">
          <TideChart days={tide.days} today={tide.today} onPick={(d) => navigate(`/billing?date=${d}`)} />
        </div>
      </div>

      <div className="grid split mt-16">
        <div className="card">
          <div className="card-head"><h2>Needs you today</h2></div>
          <div className="agenda">
            {agenda.length === 0 && <div className="empty"><h3>All clear</h3>Nothing needs you right now.</div>}
            {agenda.map((item) => (
              <Link key={item.to} to={item.to}>
                <span className="big">{item.n}</span>
                <span><span className="strong">{item.title}</span><br /><span className="small muted">{item.detail}</span></span>
                <ArrowRight size={16} color="var(--ink-3)" />
              </Link>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>A month at Brightloop</h2></div>
          <div style={{ padding: '4px 14px' }}>
            {SCENES.map(([title, detail, to], i) => (
              <Link key={title} to={to} className="scene">
                <span className="n">{i + 1}</span>
                <span><span className="strong">{title}</span><br /><span className="small muted">{detail}</span></span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
