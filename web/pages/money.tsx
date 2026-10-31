import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HBars } from '../charts';
import { post } from '../lib/api';
import { compact, date, METHOD_LABEL, money, number } from '../lib/format';
import { Button, Dialog, Empty, ErrorNote, Loading, PageHead, Pager, SearchBox, Stat, Status, Table, useAction, useGet, useListParams, useTitle } from '../ui';

export default function Money({ view }: { view: 'payments' | 'collections' | 'renewals' | 'outbox' }) {
  if (view === 'payments') return <Payments />;
  if (view === 'collections') return <Collections />;
  if (view === 'renewals') return <Renewals />;
  return <Outbox />;
}

function Payments() {
  useTitle('Payments');
  const list = useListParams();
  const { data, error, isLoading } = useGet<any>(`/payments${list.query}`, { keepPrevious: true });
  return (
    <>
      <PageHead title="Payments" actions={<Link className="btn primary" to="/reconcile">Match a bank statement</Link>}>Every rupee received, with its method, date and invoice.</PageHead>
      <div className="filters">
        <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Search customer or reference" />
        <select className="input" style={{ width: 170 }} value={list.get('method')} onChange={(e) => list.set('method', e.target.value)} aria-label="Method">
          <option value="">Every method</option>
          {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" style={{ width: 150 }} type="date" value={list.get('from')} onChange={(e) => list.set('from', e.target.value)} aria-label="From date" />
        <input className="input" style={{ width: 150 }} type="date" value={list.get('to')} onChange={(e) => list.set('to', e.target.value)} aria-label="To date" />
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              columns={[
                { label: 'Number', render: (r: any) => <span className="mono">{r.number}</span> },
                { label: 'Date', render: (r: any) => date(r.paid_on) },
                { label: 'Customer', render: (r: any) => <Link className="link" to={`/customers/${r.customer_id}`}>{r.customer_name}</Link> },
                { label: 'Method', render: (r: any) => METHOD_LABEL[r.method] },
                { label: 'Invoices', render: (r: any) => <span className="mono small">{r.invoices}</span> },
                { label: 'Note', render: (r: any) => <span className="small truncate" style={{ display: 'block', maxWidth: 260 }}>{r.note ?? '—'}</span> },
                { label: 'Amount', num: true, render: (r: any) => money(r.amount) },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="No payments match">Clear a filter to see more.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
    </>
  );
}

const BUCKETS: [string, string][] = [['', 'All overdue'], ['d1_30', '1 to 30 days'], ['d31_60', '31 to 60 days'], ['d61_90', '61 to 90 days'], ['d90_plus', 'Over 90 days']];

function Collections() {
  useTitle('Collections');
  const list = useListParams();
  const navigate = useNavigate();
  const { data, error, isLoading } = useGet<any>(`/collections${list.query}`, { keepPrevious: true });
  const report = useGet<any>('/reports/revenue');
  const remind = useAction((id: number) => post(`/collections/${id}/remind`), { success: (r) => `Reminder ${r.step} sent` });
  const aging = report.data?.summary.aging ?? [];
  const label = (b: string) => ({ current: 'Not yet due', d1_30: '1 to 30 days', d31_60: '31 to 60 days', d61_90: '61 to 90 days', d90_plus: 'Over 90 days' }[b] ?? b);
  return (
    <>
      <PageHead title="Collections">Sorted by money at risk, so the first call is the one that matters most. Reminders go out on their own at 1, 7, 15 and 30 days.</PageHead>
      {report.data && (
        <div className="grid split-rev" style={{ marginBottom: 14 }}>
          <Stat label="Overdue now" value={money(report.data.summary.overdue)} foot={`${number(report.data.summary.overdueCount)} invoices`} alert />
          <div className="card pad"><HBars format={compact} rows={aging.map((a: any) => ({ label: label(a.bucket), value: a.amount, tone: a.bucket === 'current' ? undefined : a.bucket === 'd1_30' ? '#c98a1b' : '#c2571a' }))} /></div>
        </div>
      )}
      <div className="tabs">
        {BUCKETS.map(([value, text]) => <button key={text} className={list.get('bucket') === value ? 'active' : ''} onClick={() => list.set('bucket', value)}>{text}</button>)}
      </div>
      <div className="filters">
        <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Search customer or invoice" />
        <select className="input" style={{ width: 170 }} value={list.get('segment')} onChange={(e) => list.set('segment', e.target.value)} aria-label="Segment">
          <option value="">Every segment</option><option value="small">Small</option><option value="mid">Mid</option><option value="enterprise">Enterprise</option>
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              onRow={(r: any) => navigate(`/invoices/${r.id}`)}
              columns={[
                { label: 'Customer', render: (r: any) => <><div className="strong">{r.customer_name}</div><div className="tiny muted">{r.segment}</div></> },
                { label: 'Invoice', render: (r: any) => <span className="mono small">{r.number}</span> },
                { label: 'Days late', num: true, render: (r: any) => r.days_overdue },
                { label: 'Owed', num: true, render: (r: any) => money(r.owed) },
                { label: 'Last reminder', render: (r: any) => (r.last_reminder ? `${date(r.last_reminder)} (step ${r.last_step})` : 'None yet') },
                { label: '', render: (r: any) => <Button size="small" onClick={(e) => { e.stopPropagation(); remind.mutate(r.id); }}>Send reminder</Button> },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="Nothing overdue here">Every invoice in this view is on time.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
    </>
  );
}

function Renewals() {
  useTitle('Renewals');
  const list = useListParams({ days: '90' });
  const navigate = useNavigate();
  const { data, error, isLoading } = useGet<any>(`/renewals${list.query}`, { keepPrevious: true });
  const renew = useAction((id: number) => post(`/subscriptions/${id}/renew`), { success: (r) => `Renewed until ${date(r.until)}` });
  return (
    <>
      <PageHead title="Renewals">No more "remembered by whoever notices first". Every contract nearing its end, with what's at stake.</PageHead>
      {data && (
        <div className="grid three" style={{ marginBottom: 14 }}>
          <Stat label={`Expiring in ${list.get('days')} days`} value={number(data.totals.n)} foot={`${money(data.totals.mrr)} MRR`} />
          <Stat label="Renew by themselves" value={number(data.totals.n - data.totals.manual)} foot="Keel handles these" />
          <Stat label="Need a person" value={number(data.totals.manual)} foot={`${money(data.totals.manual_mrr)} MRR at risk`} alert={data.totals.manual > 0} />
        </div>
      )}
      <div className="filters">
        <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Search customer" />
        <select className="input" style={{ width: 150 }} value={list.get('days')} onChange={(e) => list.set('days', e.target.value)} aria-label="Window">
          {['30', '60', '90', '180'].map((d) => <option key={d} value={d}>Next {d} days</option>)}
        </select>
        <select className="input" style={{ width: 190 }} value={list.get('mode')} onChange={(e) => list.set('mode', e.target.value)} aria-label="Type">
          <option value="">All</option><option value="manual">Needs a person</option><option value="auto">Renews by itself</option>
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              onRow={(r: any) => navigate(`/subscriptions/${r.id}`)}
              columns={[
                { label: 'Expires', render: (r: any) => <><div className="strong">{date(r.expiry_date)}</div><div className="tiny muted">{r.days_left <= 0 ? 'Expired' : `in ${r.days_left} days`}</div></> },
                { label: 'Customer', render: (r: any) => r.customer_name },
                { label: 'Subscription', render: (r: any) => <span className="mono small">{r.number}</span> },
                { label: 'Plan', render: (r: any) => r.plan_name },
                { label: 'MRR', num: true, render: (r: any) => money(r.mrr) },
                { label: 'What happens', render: (r: any) => (r.auto_renew && r.renewable ? <span className="badge good">Renews by itself</span> : r.auto_close ? <span className="badge plain">Closes on its own</span> : <span className="badge warn">Needs a decision</span>) },
                { label: '', render: (r: any) => (r.renewable ? <Button size="small" onClick={(e) => { e.stopPropagation(); renew.mutate(r.id); }}>Renew</Button> : null) },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="Nothing expiring">No contracts end in this window.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
    </>
  );
}

function Outbox() {
  useTitle('Outbox');
  const list = useListParams();
  const { data, isLoading } = useGet<any>(`/outbox${list.query}`, { keepPrevious: true });
  const [open, setOpen] = useState<any>(null);
  return (
    <>
      <PageHead title="Outbox">Everything Keel has sent: invoices, quotations, reminders and reset links.</PageHead>
      <div className="filters">
        <select className="input" style={{ width: 200 }} value={list.get('kind')} onChange={(e) => list.set('kind', e.target.value)} aria-label="Kind">
          <option value="">Every kind</option>
          {['invoice', 'quotation', 'dunning', 'renewal_reminder', 'password_reset'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
        </select>
      </div>
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              onRow={setOpen}
              columns={[
                { label: 'Date', render: (r: any) => date(r.on_date) },
                { label: 'To', render: (r: any) => <span className="small">{r.to_email}</span> },
                { label: 'Subject', render: (r: any) => r.subject },
                { label: 'Kind', render: (r: any) => <span className="badge plain">{r.kind.replace('_', ' ')}</span> },
                { label: 'Status', render: (r: any) => <Status value={r.status} /> },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="Nothing sent yet">Messages appear here as Keel sends them.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.subject ?? ''}>
        <div className="small muted">To {open?.to_email}</div>
        <pre className="mt-8" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font)', margin: '8px 0 0' }}>{open?.body}</pre>
      </Dialog>
    </>
  );
}
