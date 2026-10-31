import { Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, post, put } from '../lib/api';
import { date, INDIAN_STATES, money, periodWord } from '../lib/format';
import { useMe } from '../shell';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Stat, Status, Table, Toggle, fieldErrors, useAction, useGet, useTitle, useToast } from '../ui';
import { InvoicePaper, Xray } from './invoices';

export default function Portal() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="plans" element={<Plans />} />
      <Route path="profile" element={<Profile />} />
      <Route path="subscriptions/:id" element={<Subscription />} />
      <Route path="invoices/:id" element={<Invoice />} />
    </Routes>
  );
}

function Overview() {
  useTitle('Your account');
  const navigate = useNavigate();
  const { data, error, isLoading } = useGet<any>('/portal/home');
  const accept = useAction((id: number) => post(`/portal/subscriptions/${id}/accept`), { success: 'Quotation accepted. Thank you' });
  const decline = useAction((id: number) => post(`/portal/subscriptions/${id}/decline`), { success: 'Quotation declined' });
  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={420} />;
  const { customer, subscriptions, invoices, totals } = data;
  const quotes = subscriptions.filter((s: any) => s.status === 'quotation');
  const live = subscriptions.filter((s: any) => s.status !== 'quotation');
  const nextBill = subscriptions.filter((s: any) => s.next_billing_date && s.status === 'active').map((s: any) => s.next_billing_date).sort()[0];

  return (
    <>
      <PageHead title={customer.name}>Your subscriptions and invoices, without having to email anyone.</PageHead>
      <div className="grid three">
        <Stat label="To pay now" value={money(totals.outstanding)} foot={totals.overdue > 0 ? `${money(totals.overdue)} is overdue` : 'Nothing overdue'} alert={totals.overdue > 0} />
        <Stat label="Active subscriptions" value={live.filter((s: any) => s.status === 'active').length} />
        <Stat label="Next bill" value={nextBill ? date(nextBill) : '—'} />
      </div>

      {quotes.map((q: any) => (
        <div className="callout mt-16 row between wrap" key={q.id}>
          <div><span className="strong">A quotation is waiting: {q.plan_name}</span><br /><span className="small">{money(q.recurring_amount)} before tax, per {periodWord[q.billing_unit]}. Valid until {date(q.quotation_valid_until)}.</span></div>
          <div className="row"><Button variant="primary" onClick={() => accept.mutate(q.id)}>Accept quotation</Button><Button onClick={() => decline.mutate(q.id)}>Decline</Button></div>
        </div>
      ))}

      <div className="card mt-16">
        <div className="card-head"><h2>Your subscriptions</h2><Link className="btn small" to="/portal/plans">Add a plan</Link></div>
        <Table
          onRow={(s: any) => navigate(`/portal/subscriptions/${s.id}`)}
          columns={[
            { label: 'Plan', render: (s: any) => <><div className="strong">{s.plan_name}</div><div className="tiny muted mono">{s.number}</div></> },
            { label: 'Status', render: (s: any) => <Status value={s.status} /> },
            { label: 'Next bill', render: (s: any) => date(s.next_billing_date) },
            { label: 'Renews or ends', render: (s: any) => date(s.expiry_date) },
            { label: 'Each period', num: true, render: (s: any) => money(s.recurring_amount) },
          ]}
          rows={live}
          empty={<Empty title="No subscriptions yet"><Link className="btn primary mt-8" to="/portal/plans">Choose a plan</Link></Empty>}
        />
      </div>

      <div className="card mt-16">
        <div className="card-head"><h2>Your invoices</h2></div>
        <Table
          onRow={(i: any) => navigate(`/portal/invoices/${i.id}`)}
          columns={[
            { label: 'Number', render: (i: any) => <span className="mono">{i.number}</span> },
            { label: 'Issued', render: (i: any) => date(i.issue_date) },
            { label: 'Due', render: (i: any) => date(i.due_date) },
            { label: 'Status', render: (i: any) => <Status value={i.overdue ? 'overdue' : i.status} /> },
            { label: 'Total', num: true, render: (i: any) => money(i.total) },
          ]}
          rows={invoices}
          empty={<Empty title="No invoices yet" />}
        />
      </div>
    </>
  );
}

function Subscription() {
  const { id } = useParams();
  const { data, error, isLoading } = useGet<any>(`/portal/subscriptions/${id}`);
  useTitle(data?.sub.plan_name ?? 'Subscription');
  const [confirming, setConfirming] = useState<any>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const toast = useToast();

  const toggle = async (productId: number, enable: boolean) => {
    try {
      const preview = await api(`/portal/subscriptions/${id}/addons/${productId}/preview?enable=${enable}`);
      setConfirming({ ...preview, productId });
    } catch (err: any) {
      toast(err.message, 'bad');
    }
  };

  const applyAddon = useAction(() => post(`/portal/subscriptions/${id}/addons`, { productId: confirming.productId, enable: confirming.enable }), { success: (r) => `${r.name} ${r.enable ? 'is on' : 'switches off at period end'}`, onDone: () => setConfirming(null) });
  const pause = useAction(() => post(`/portal/subscriptions/${id}/pause`), { success: 'Paused. You will not be billed until you resume' });
  const resume = useAction(() => post(`/portal/subscriptions/${id}/resume`), { success: 'Welcome back' });
  const renew = useAction(() => post(`/portal/subscriptions/${id}/renew`), { success: (r) => `Renewed until ${date(r.until)}` });
  const close = useAction(() => post(`/portal/subscriptions/${id}/close`, { reason: reason || 'Closed from the portal' }), { success: 'Subscription closed', onDone: () => setClosing(false) });

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={420} />;
  const { sub, lines, addons, next } = data;
  const active = sub.status === 'active';

  return (
    <>
      <PageHead
        title={sub.plan_name}
        actions={
          <>
            {active && sub.pausable && <Button onClick={() => pause.mutate()}>Pause</Button>}
            {sub.status === 'paused' && <Button variant="primary" onClick={() => resume.mutate()}>Resume</Button>}
            {['active', 'paused'].includes(sub.status) && sub.renewable && <Button onClick={() => renew.mutate()}>Renew now</Button>}
            {['active', 'paused'].includes(sub.status) && sub.closable && <Button variant="danger" onClick={() => setClosing(true)}>Close subscription</Button>}
          </>
        }
      >
        <span className="mono">{sub.number}</span> <Status value={sub.status} />
      </PageHead>

      {!sub.closable && active && <div className="callout small" style={{ marginBottom: 14 }}>This is a fixed contract until {date(sub.expiry_date)}, so it cannot be closed early.</div>}

      <div className="grid two">
        <div className="col">
          <div className="card">
            <div className="card-head"><h2>What you have</h2></div>
            <Table
              columns={[
                { label: 'Item', render: (l: any) => <>{l.description}{l.active_until && <div className="tiny muted">Ends {date(l.active_until)}</div>}</> },
                { label: 'Qty', num: true, render: (l: any) => l.quantity },
                { label: 'Amount', num: true, render: (l: any) => money(l.quantity * l.unit_price) },
              ]}
              rows={lines}
            />
          </div>
          {active && addons.length > 0 && (
            <div className="card pad">
              <h2>Add-ons</h2>
              <p className="small muted">Switch these on and off yourself. You see the cost first.</p>
              {addons.map((a: any) => (
                <div className="addon" key={a.product_id}>
                  <div className="grow">
                    <div className="strong">{a.name}</div>
                    <div className="small muted">{a.notes}</div>
                    <div className="small mono">{money(a.price)} per {periodWord[sub.billing_unit]}</div>
                  </div>
                  <Toggle checked={a.enabled} label={a.name} onChange={(enable) => toggle(a.product_id, enable)} />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="col">
          {next && (
            <div className="card">
              <div className="card-head"><h2>Your next bill</h2><span className="mono strong">{money(next.total)}</span></div>
              <div className="card-body">
                <p className="small muted" style={{ marginBottom: 8 }}>On {date(next.period.start)}, for the period to {date(next.period.end)}. Here is exactly how it adds up.</p>
                <Xray trace={next.trace} />
              </div>
            </div>
          )}
          <div className="card pad small col gap-6">
            <div className="row between"><span className="muted">Started</span><span>{date(sub.start_date)}</span></div>
            <div className="row between"><span className="muted">Contract until</span><span>{date(sub.expiry_date)}</span></div>
            <div className="row between"><span className="muted">Renews by itself</span><span>{sub.auto_renew ? 'Yes' : 'No'}</span></div>
            <div className="row between"><span className="muted">Payment terms</span><span>{sub.payment_term}</span></div>
          </div>
        </div>
      </div>

      <Dialog open={!!confirming} onClose={() => setConfirming(null)} title={confirming ? `${confirming.enable ? 'Switch on' : 'Switch off'} ${confirming.name}` : ''}
        footer={<><Button onClick={() => setConfirming(null)}>Not now</Button><Button variant="primary" onClick={() => applyAddon.mutate()} loading={applyAddon.isPending}>{confirming?.enable ? 'Switch on' : 'Switch off'}</Button></>}>
        {confirming && (
          <div className="col">
            <p>{confirming.message}</p>
            <div className="card pad small col gap-4">
              <div className="row between"><span className="muted">Each period now</span><span className="mono">{money(confirming.currentRecurring)}</span></div>
              <div className="row between strong"><span>Each period after this</span><span className="mono">{money(confirming.newRecurring)}</span></div>
              {confirming.enable && <div className="row between"><span className="muted">Added to your next invoice</span><span className="mono">{money(confirming.chargeNow)}</span></div>}
            </div>
            <p className="tiny muted">Amounts are before tax.</p>
          </div>
        )}
      </Dialog>

      <Dialog open={closing} onClose={() => setClosing(false)} title="Close this subscription"
        footer={<><Button onClick={() => setClosing(false)}>Keep it</Button><Button variant="danger" onClick={() => close.mutate()} loading={close.isPending}>Close subscription</Button></>}>
        {sub.pausable && <div className="callout small" style={{ marginBottom: 10 }}>Just taking a break? You can pause instead and come back later.</div>}
        <Field label="Would you tell us why?"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

function Invoice() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data, error, isLoading } = useGet<any>(`/portal/invoices/${id}`);
  useTitle(data?.invoice.number ?? 'Invoice');
  const [paying, setPaying] = useState(false);
  const [why, setWhy] = useState(false);
  const pay = useAction((method: string) => post(`/portal/invoices/${id}/pay`, { method }), { success: 'Payment received. Thank you', onDone: () => setPaying(false) });
  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={420} />;
  const inv = data.invoice;
  const owed = inv.total - inv.amount_paid;
  return (
    <>
      <PageHead title={inv.number}
        actions={
          <>
            {inv.status === 'confirmed' && <Button variant="primary" onClick={() => setPaying(true)}>Pay {money(owed)}</Button>}
            <Button onClick={() => setWhy(true)}>Why this amount?</Button>
            <Button onClick={() => window.print()}><Printer size={14} /> Print</Button>
          </>
        }>
        <Status value={inv.status === 'confirmed' && me && inv.due_date < me.today ? 'overdue' : inv.status} />
      </PageHead>
      <InvoicePaper detail={data} company={me?.company} />

      <Dialog open={why} onClose={() => setWhy(false)} title="How this invoice adds up">
        <Xray trace={data.trace} />
      </Dialog>
      <Dialog open={paying} onClose={() => setPaying(false)} title={`Pay ${money(owed)}`}>
        <p className="small muted">This is a simulated checkout for the demo. No real money moves.</p>
        <div className="grid two mt-12">
          <Button variant="primary" onClick={() => pay.mutate('upi')} loading={pay.isPending}>Pay by UPI</Button>
          <Button onClick={() => pay.mutate('card')} loading={pay.isPending}>Pay by card</Button>
        </div>
      </Dialog>
    </>
  );
}

function Plans() {
  useTitle('Plans');
  const navigate = useNavigate();
  const { data, isLoading } = useGet<any[]>('/portal/plans');
  const [picked, setPicked] = useState<any>(null);
  const [quantity, setQuantity] = useState(1);
  const subscribe = useAction(() => post('/portal/subscribe', { planId: picked.id, quantity }), { success: 'You are subscribed. Your first invoice is ready', onDone: () => navigate('/portal') });
  if (isLoading) return <Loading />;
  return (
    <>
      <PageHead title="Choose a plan">Pick what fits. Your first invoice is ready straight away.</PageHead>
      <div className="grid three">
        {data?.map((p) => (
          <div className="plan-card" key={p.id}>
            <h2>{p.name}</h2>
            <div className="small muted">{p.product_name}</div>
            <div><span className="mono strong" style={{ fontSize: 22 }}>{money(p.price)}</span> <span className="muted small">per seat, per {periodWord[p.billing_unit]}</span></div>
            <p className="small muted">{p.notes}</p>
            {p.min_quantity > 1 && <div className="tiny muted">Minimum {p.min_quantity} seats</div>}
            <Button variant="primary" onClick={() => { setPicked(p); setQuantity(p.min_quantity); }}>Choose {p.name}</Button>
          </div>
        ))}
      </div>
      <Dialog open={!!picked} onClose={() => setPicked(null)} title={picked ? `Subscribe to ${picked.name}` : ''}
        footer={<><Button onClick={() => setPicked(null)}>Cancel</Button><Button variant="primary" onClick={() => subscribe.mutate()} loading={subscribe.isPending}>Subscribe</Button></>}>
        {picked && (
          <div className="col">
            <Field label="Seats" hint={`Minimum ${picked.min_quantity}`}><input className="input" type="number" min={picked.min_quantity} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></Field>
            <div className="row between"><span className="muted">Before tax, per {periodWord[picked.billing_unit]}</span><span className="mono strong">{money(picked.price * quantity)}</span></div>
            <ErrorNote error={subscribe.error} />
          </div>
        )}
      </Dialog>
    </>
  );
}

function Profile() {
  useTitle('Company details');
  const { data } = useGet<any>('/portal/home');
  const [form, setForm] = useState<any>(null);
  useEffect(() => {
    if (data && !form) {
      const c = data.customer;
      setForm({ name: c.name, phone: c.phone ?? '', gstin: c.gstin ?? '', stateCode: c.state_code ?? '', city: c.city ?? '', address: c.address ?? '' });
    }
  }, [data]);
  const save = useAction(() => {
    const state = INDIAN_STATES.find(([code]) => code === form.stateCode);
    return put('/portal/profile', { ...form, stateName: state?.[1] ?? null });
  }, { success: 'Details saved' });
  const errors = fieldErrors(save.error);
  if (!form) return <Loading />;
  const set = (key: string) => (e: any) => setForm({ ...form, [key]: e.target.value });
  return (
    <>
      <PageHead title="Company details">These appear on your invoices. Your state decides how GST is charged.</PageHead>
      <div className="card pad" style={{ maxWidth: 680 }}>
        <div className="form-grid">
          <Field label="Company name" error={errors.name} className="wide"><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="GSTIN" error={errors.gstin}><input className="input" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="State">
            <select className="input" value={form.stateCode} onChange={set('stateCode')}>
              <option value="">Choose</option>
              {INDIAN_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </Field>
          <Field label="City"><input className="input" value={form.city} onChange={set('city')} /></Field>
          <Field label="Address" className="wide"><input className="input" value={form.address} onChange={set('address')} /></Field>
          <div className="wide"><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save details</Button></div>
        </div>
      </div>
    </>
  );
}
