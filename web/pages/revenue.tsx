import { Download, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bridge, HBars, MrrLine, PairedBars } from '../charts';
import { queryString } from '../lib/api';
import { compact, INDIAN_STATES, money, number, percent } from '../lib/format';
import { useMe } from '../shell';
import { Button, ErrorNote, Loading, PageHead, Stat, Table, useGet, useListParams, useTitle } from '../ui';

export default function Revenue() {
  useTitle('Revenue');
  const { data: me } = useMe();
  const list = useListParams({ preset: 'month' });
  const plans = useGet<any[]>('/plans');
  const { data, error, isLoading } = useGet<any>(`/reports/revenue${list.query}`, { keepPrevious: true });
  const [wantAi, setWantAi] = useState(false);
  const ruleBrief = useGet<any>('/brief');
  const aiBrief = useGet<any>(wantAi ? '/brief?ai=1' : null);
  const brief = aiBrief.data ?? ruleBrief.data;
  const exportHref = `/api/reports/export${queryString({ preset: list.get('preset'), from: list.get('from'), to: list.get('to') })}`;

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={560} />;
  const { summary: s, series, plans: planRows, overdue } = data;

  return (
    <>
      <PageHead title="Revenue" actions={<a className="btn" href={exportHref}><Download size={14} /> Export invoices</a>}>
        The month-end answers, live. These figures read the same tables invoicing writes, so they cannot disagree with the books.
      </PageHead>

      <div className="filters">
        <div className="row gap-4">
          {[['month', 'This month'], ['quarter', 'Last 3 months'], ['year', 'Last 12 months']].map(([value, label]) => (
            <Button key={value} size="small" variant={list.get('preset') === value && !list.get('from') ? 'dark' : ''} onClick={() => { list.set('from', ''); list.set('to', ''); list.set('preset', value); }}>{label}</Button>
          ))}
        </div>
        <input className="input" style={{ width: 145 }} type="date" value={list.get('from')} onChange={(e) => list.set('from', e.target.value)} aria-label="From date" />
        <input className="input" style={{ width: 145 }} type="date" value={list.get('to')} onChange={(e) => list.set('to', e.target.value)} aria-label="To date" />
        <select className="input" style={{ width: 170 }} value={list.get('planId')} onChange={(e) => list.set('planId', e.target.value)} aria-label="Plan">
          <option value="">Every plan</option>
          {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input" style={{ width: 140 }} value={list.get('segment')} onChange={(e) => list.set('segment', e.target.value)} aria-label="Segment">
          <option value="">Every size</option><option value="small">Small</option><option value="mid">Mid</option><option value="enterprise">Enterprise</option>
        </select>
        <select className="input" style={{ width: 150 }} value={list.get('stateCode')} onChange={(e) => list.set('stateCode', e.target.value)} aria-label="State">
          <option value="">Every state</option>
          {INDIAN_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </div>

      <div className="grid four">
        <Stat label="Active subscriptions" value={number(s.activeSubscriptions)} foot={`${number(s.activeCustomers)} customers`} href="/subscriptions?status=active" />
        <Stat label="MRR" value={compact(s.mrr)} foot={`ARR ${compact(s.arr)}`} />
        <Stat label="Revenue, before tax" value={compact(s.revenue)} foot={`${number(s.invoiceCount)} invoices`} href={`/invoices?from=${s.period.from}&to=${s.period.to}`} />
        <Stat label="Tax collected for GST" value={compact(s.tax)} foot={`${compact(s.discounts)} in discounts given`} />
        <Stat label="Money in" value={compact(s.collected)} foot={`${number(s.paymentCount)} payments, ${percent(s.collectionRate)} of billed`} href={`/payments?from=${s.period.from}&to=${s.period.to}`} />
        <Stat label="Still owed" value={compact(s.outstanding)} foot="All open invoices" href="/invoices?status=confirmed" />
        <Stat label="Overdue" value={compact(s.overdue)} foot={`${number(s.overdueCount)} invoices`} alert href="/collections" />
        <Stat label="Average per customer" value={compact(s.arpa)} foot="MRR per active customer" />
      </div>

      <div className="card mt-16 pad water">
        <div className="row between wrap">
          <div className="row gap-6 strong"><Sparkles size={15} color="var(--magenta)" /> Month-end note</div>
          {me?.ai.enabled && !aiBrief.data && <Button size="small" onClick={() => setWantAi(true)} loading={aiBrief.isFetching}>{aiBrief.isFetching ? 'Gemini is writing' : 'Rewrite with Gemini'}</Button>}
        </div>
        {brief ? <p className="mt-4" style={{ maxWidth: '100ch' }}>{brief.text}</p> : <div className="skeleton mt-8" style={{ height: 40 }} />}
        {brief && <div className="tiny muted mt-4">{brief.mode === 'gemini' ? `Written by Gemini from Keel's figures` : 'Written from Keel’s figures, no AI needed'}</div>}
      </div>

      <div className="grid two mt-16">
        <div className="card">
          <div className="card-head"><div><h2>Why MRR moved</h2><div className="small muted">{money(s.bridge.opening)} + {money(s.bridge.net)} = {money(s.bridge.closing)}</div></div></div>
          <div className="card-body"><Bridge opening={s.bridge.opening} moves={s.bridge.moves} closing={s.bridge.closing} /></div>
        </div>
        <div className="card">
          <div className="card-head"><div><h2>MRR over 12 months</h2><div className="small muted">Yearly plans count as one twelfth, never the full amount</div></div></div>
          <div className="card-body"><MrrLine series={series} /></div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Invoiced and collected</h2></div>
          <div className="card-body"><PairedBars series={series} /></div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Open invoices by age</h2></div>
          <div className="card-body">
            <HBars format={compact} rows={s.aging.map((a: any) => ({
              label: { current: 'Not yet due', d1_30: '1 to 30 days late', d31_60: '31 to 60 days late', d61_90: '61 to 90 days late', d90_plus: 'Over 90 days late' }[a.bucket as string]!,
              value: a.amount,
              tone: a.bucket === 'current' ? undefined : a.bucket === 'd1_30' ? '#c98a1b' : '#c2571a',
            }))} />
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Plans</h2></div>
          <Table
            columns={[
              { label: 'Plan', render: (p: any) => <Link className="link" to={`/subscriptions?planId=${p.id}&status=active`}>{p.name}</Link> },
              { label: 'Active', num: true, render: (p: any) => number(p.subscriptions) },
              { label: 'MRR', num: true, render: (p: any) => money(p.mrr) },
            ]}
            rows={planRows}
          />
        </div>
        <div className="card">
          <div className="card-head"><h2>Who owes the most</h2><Link className="link small" to="/collections">Collections</Link></div>
          <Table
            columns={[
              { label: 'Customer', render: (r: any) => <Link className="link" to={`/customers/${r.id}`}>{r.name}</Link> },
              { label: 'Oldest', num: true, render: (r: any) => `${r.oldest_days}d` },
              { label: 'Overdue', num: true, render: (r: any) => money(r.overdue) },
            ]}
            rows={overdue}
          />
        </div>
      </div>
    </>
  );
}
