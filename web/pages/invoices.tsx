import { CheckCircle2, Printer, Send, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { post } from '../lib/api';
import { bp, date, METHOD_LABEL, money, rupeesToPaise } from '../lib/format';
import { useMe } from '../shell';
import {
  Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pager, SearchBox, Status, Stepper, Table,
  fieldErrors, useAction, useGet, useListParams, useTitle,
} from '../ui';

export default function Invoices() {
  return (
    <Routes>
      <Route index element={<ListView />} />
      <Route path=":id" element={<Detail />} />
    </Routes>
  );
}

function ListView() {
  useTitle('Invoices');
  const list = useListParams();
  const navigate = useNavigate();
  const { data, error, isLoading } = useGet<any>(`/invoices${list.query}`, { keepPrevious: true });
  const confirmAll = useAction(() => post('/invoices/confirm-all'), { success: (r) => `${r.confirmed} invoices confirmed and numbered` });
  return (
    <>
      <PageHead title="Invoices" actions={list.get('status') === 'draft' && data?.total > 0 ? <Button variant="primary" onClick={() => confirmAll.mutate()} loading={confirmAll.isPending}>Confirm all drafts</Button> : undefined}>
        Created from subscriptions, never typed by hand.
      </PageHead>
      <div className="tabs">
        {[['', 'All'], ['draft', 'Draft'], ['confirmed', 'Confirmed'], ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([value, label]) => (
          <button key={label} className={list.get('status') === value && !list.get('overdue') ? 'active' : ''} onClick={() => { list.set('status', value); }}>{label}</button>
        ))}
        <button className={list.get('overdue') ? 'active' : ''} onClick={() => list.set('overdue', list.get('overdue') ? '' : '1')}>Overdue</button>
      </div>
      <div className="filters">
        <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Search number or customer" />
        <input className="input" style={{ width: 150 }} type="date" value={list.get('from')} onChange={(e) => list.set('from', e.target.value)} aria-label="From date" />
        <input className="input" style={{ width: 150 }} type="date" value={list.get('to')} onChange={(e) => list.set('to', e.target.value)} aria-label="To date" />
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              onRow={(r: any) => navigate(`/invoices/${r.id}`)}
              columns={[
                { label: 'Number', render: (r: any) => <span className="mono">{r.number ?? 'Draft'}</span> },
                { label: 'Customer', render: (r: any) => r.customer_name },
                { label: 'Subscription', render: (r: any) => <span className="mono small">{r.subscription_number}</span> },
                { label: 'Issued', render: (r: any) => date(r.issue_date) },
                { label: 'Due', render: (r: any) => date(r.due_date) },
                { label: 'Status', render: (r: any) => <Status value={r.overdue ? 'overdue' : r.status} /> },
                { label: 'Total', num: true, render: (r: any) => money(r.total) },
                { label: 'Still owed', num: true, render: (r: any) => (['confirmed', 'draft'].includes(r.status) ? money(r.total - r.amount_paid) : '—') },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="No invoices match">Clear a filter to see more.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
    </>
  );
}

const KIND_MARK: Record<string, string> = { base: '×', variant: '+', proration: '÷', discount: '−', tax: '%', total: '=', skipped: '·' };

/** Invoice X-ray: every number on an invoice, traced to the rule that produced it. */
export function Xray({ trace, linkRules = false }: { trace: any[]; linkRules?: boolean }) {
  return (
    <div className="xray">
      {trace.map((step, i) => (
        <div key={i} className={`step-row ${step.kind}`}>
          <span className="step-kind" aria-hidden="true">{KIND_MARK[step.kind]}</span>
          <div>
            <div className="strong small">
              {linkRules && step.source?.type === 'discount' ? <Link className="link" to="/catalog/discounts">{step.label}</Link>
                : linkRules && step.source?.type === 'tax_rule' ? <Link className="link" to="/catalog/taxes">{step.label}</Link>
                : step.label}
            </div>
            <div className="tiny muted">{step.detail}</div>
          </div>
          <span className="mono small strong">{step.kind === 'skipped' ? '' : money(step.amount)}</span>
        </div>
      ))}
    </div>
  );
}

export function InvoicePaper({ detail, company }: { detail: any; company: any }) {
  const { invoice: inv, lines } = detail;
  const c = inv.customer_snapshot;
  return (
    <article className="invoice-paper">
      <div className="row between top wrap">
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{company.legalName}</div>
          <div className="small muted">{company.address}</div>
          <div className="small muted">GSTIN {company.gstin}, {company.stateName} ({company.stateCode})</div>
        </div>
        <div className="right">
          <div className="small strong">Tax invoice</div>
          <div className="mono strong" style={{ fontSize: 16 }}>{inv.number ?? 'DRAFT'}</div>
          <div className="small muted">Issued {date(inv.issue_date)}</div>
          <div className="small muted">Due {date(inv.due_date)}</div>
        </div>
      </div>
      <div className="row between top wrap mt-16">
        <div>
          <div className="tiny muted">Billed to</div>
          <div className="strong">{c.name}</div>
          <div className="small">{c.address}{c.city ? `, ${c.city}` : ''}</div>
          {c.gstin && <div className="small">GSTIN {c.gstin}</div>}
          <div className="small">Place of supply: {c.state_name ?? c.country}{c.state_code ? ` (${c.state_code})` : ''}</div>
        </div>
        <div className="right">
          <div className="tiny muted">For the period</div>
          <div className="small strong">{date(inv.period_start)} to {date(inv.period_end)}</div>
          <div className="small">{inv.subscription_number}, {inv.plan_name}</div>
        </div>
      </div>
      <table className="mt-16">
        <thead>
          <tr>
            <th>Item</th><th>SAC</th><th className="right">Qty</th><th className="right">Unit price</th><th className="right">Discount</th><th className="right">Taxable</th><th className="right">Tax</th><th className="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l: any) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="mono">{l.sac ?? '—'}</td>
              <td className="right mono">{l.quantity}</td>
              <td className="right mono">{money(l.unit_price)}</td>
              <td className="right mono">{l.discount ? money(l.discount) : '—'}</td>
              <td className="right mono">{money(l.taxable)}</td>
              <td className="right mono">{money(l.tax)}</td>
              <td className="right mono">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="totals">
        <div><span>Subtotal</span><span className="mono">{money(inv.subtotal)}</span></div>
        {inv.discount > 0 && <div><span>Discount</span><span className="mono">−{money(inv.discount)}</span></div>}
        {inv.tax_summary.map((t: any) => <div key={`${t.label}${t.rate}`}><span>{t.label} {bp(t.rate)}</span><span className="mono">{money(t.amount)}</span></div>)}
        <div className="grand"><span>Total</span><span className="mono">{money(inv.total)}</span></div>
        {inv.amount_paid > 0 && <div><span>Paid</span><span className="mono">{money(inv.amount_paid)}</span></div>}
        {inv.amount_paid > 0 && inv.status !== 'paid' && <div className="strong"><span>Still owed</span><span className="mono">{money(inv.total - inv.amount_paid)}</span></div>}
      </div>
    </article>
  );
}

function Detail() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data, error, isLoading } = useGet<any>(`/invoices/${id}`);
  useTitle(data?.invoice.number ?? 'Invoice');
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'bank_transfer', paidOn: '', note: '', reference: '' });
  const [cancel, setCancel] = useState({ mode: 'rebill', reason: '' });

  const confirm = useAction(() => post(`/invoices/${id}/confirm`), { success: 'Confirmed and numbered' });
  const send = useAction(() => post(`/invoices/${id}/send`), { success: 'Sent to the customer' });
  const record = useAction(() => post('/payments', {
    invoiceId: Number(id), amount: rupeesToPaise(pay.amount), method: pay.method, paidOn: pay.paidOn || me?.today, note: pay.note || null, reference: pay.reference || null,
  }), { success: (r) => (r.remaining > 0 ? `${r.number} recorded. ${money(r.remaining)} is still owed` : `${r.number} recorded. Invoice paid in full`), onDone: () => setPaying(false) });
  const doCancel = useAction(() => post(`/invoices/${id}/cancel`, cancel), { success: cancel.mode === 'rebill' ? 'Cancelled. The next run bills this period again' : 'Cancelled and written off', onDone: () => setCancelling(false) });

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={480} />;
  const { invoice: inv, payments, trace, verified, period, reminders, redemptions } = data;
  const owed = inv.total - inv.amount_paid;
  const overdue = inv.status === 'confirmed' && me && inv.due_date < me.today;
  const errors = fieldErrors(record.error);

  return (
    <>
      <PageHead
        title={inv.number ?? 'Draft invoice'}
        actions={
          <>
            {inv.status === 'draft' && <Button variant="primary" onClick={() => confirm.mutate()} loading={confirm.isPending}>Confirm</Button>}
            {inv.status === 'confirmed' && <Button variant="primary" onClick={() => { setPay({ ...pay, amount: String(owed / 100), paidOn: me?.today ?? '' }); setPaying(true); }}>Record payment</Button>}
            {['confirmed', 'paid'].includes(inv.status) && <Button onClick={() => send.mutate()} loading={send.isPending}><Send size={14} /> Send</Button>}
            <Button onClick={() => window.print()}><Printer size={14} /> Print</Button>
            {['draft', 'confirmed'].includes(inv.status) && inv.amount_paid === 0 && <Button variant="danger" onClick={() => setCancelling(true)}>Cancel</Button>}
          </>
        }
      >
        <Link className="link" to={`/customers/${inv.customer_id}`}>{inv.customer_name}</Link>, <Link className="link" to={`/subscriptions/${inv.subscription_id}`}>{inv.subscription_number}</Link>
      </PageHead>

      <div className="card pad row between wrap no-print">
        {inv.status === 'cancelled'
          ? <span className="badge bad">Cancelled {date(inv.cancelled_on)}: {inv.cancel_reason}</span>
          : <Stepper steps={['draft', 'confirmed', 'paid']} current={inv.status} />}
        <div className="row">
          {overdue && <span className="badge bad">Overdue</span>}
          {inv.sent_at && <span className="badge plain">Sent</span>}
        </div>
      </div>

      <div className="grid split mt-16">
        <InvoicePaper detail={data} company={me?.company} />
        <div className="col no-print">
          <div className="card">
            <div className="card-head">
              <h2>Invoice X-ray</h2>
              {verified
                ? <span className="badge good"><CheckCircle2 size={12} /> Replay matches</span>
                : <span className="badge bad"><XCircle size={12} /> Replay differs</span>}
            </div>
            <div className="card-body">
              <p className="small muted" style={{ marginBottom: 8 }}>Every figure, traced to the rule that made it. Keel just recomputed this from the stored inputs.</p>
              <Xray trace={trace} linkRules />
            </div>
          </div>

          {payments.length > 0 && (
            <div className="card">
              <div className="card-head"><h2>Payments</h2></div>
              <Table
                columns={[
                  { label: 'Date', render: (p: any) => date(p.paid_on) },
                  { label: 'Method', render: (p: any) => METHOD_LABEL[p.method] },
                  { label: 'Note', render: (p: any) => <span className="small">{p.note ?? '—'}</span> },
                  { label: 'Amount', num: true, render: (p: any) => money(p.amount) },
                ]}
                rows={payments}
              />
            </div>
          )}

          <div className="card pad small">
            <h3>Billing record</h3>
            <div className="col gap-4 mt-8">
              {period && <div className="row between"><span className="muted">Period row</span><span className="mono">#{period.id}, {period.state}</span></div>}
              {period?.run_id && <div className="row between"><span className="muted">Billing run</span><Link className="link mono" to={`/invoices?runId=${period.run_id}`}>#{period.run_id}</Link></div>}
              {redemptions.map((r: any) => <div className="row between" key={r.code}><span className="muted">{r.code}</span><span className="mono">{r.released_on ? 'Released' : money(r.amount)}</span></div>)}
              {reminders.map((r: any) => <div className="row between" key={r.step}><span className="muted">Reminder {r.step}</span><span>{date(r.on_date)}, {r.actor}</span></div>)}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={paying} onClose={() => setPaying(false)} title={`Record a payment against ${inv.number}`}
        footer={<><Button onClick={() => setPaying(false)}>Cancel</Button><Button variant="primary" onClick={() => record.mutate()} loading={record.isPending}>Record payment</Button></>}>
        <div className="form-grid">
          <Field label="Amount (₹)" error={errors.amount} hint={`${money(owed)} is owed. A smaller amount is a part payment`}><input className="input" type="number" step="0.01" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
          <Field label="Method">
            <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
              {Object.entries(METHOD_LABEL).filter(([k]) => k !== 'gateway').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Date" error={errors.paidOn}><input className="input" type="date" value={pay.paidOn} max={me?.today} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></Field>
          <Field label="Reference"><input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="UTR or cheque number" /></Field>
          <Field label="Note" className="wide"><input className="input" value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></Field>
        </div>
      </Dialog>

      <Dialog open={cancelling} onClose={() => setCancelling(false)} title={`Cancel ${inv.number ?? 'this draft'}`}
        footer={<><Button onClick={() => setCancelling(false)}>Keep it</Button><Button variant="danger" disabled={cancel.reason.length < 3} onClick={() => doCancel.mutate()} loading={doCancel.isPending}>Cancel invoice</Button></>}>
        <div className="col">
          <label className="check"><input type="radio" name="mode" checked={cancel.mode === 'rebill'} onChange={() => setCancel({ ...cancel, mode: 'rebill' })} /><span>Bill this period again<small>The invoice was wrong. The next run raises a corrected one, so the period is not skipped.</small></span></label>
          <label className="check"><input type="radio" name="mode" checked={cancel.mode === 'waive'} onChange={() => setCancel({ ...cancel, mode: 'waive' })} /><span>Write it off<small>The customer should not pay for this period.</small></span></label>
          <Field label="Why?"><input className="input" value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} placeholder="Wrong seat count" /></Field>
          {inv.number && <p className="small muted">The number {inv.number} stays used and appears as cancelled, because GST numbering cannot have gaps.</p>}
        </div>
      </Dialog>
    </>
  );
}
