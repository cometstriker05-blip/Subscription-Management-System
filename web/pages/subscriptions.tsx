import { LayoutGrid, List, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { del, post } from '../lib/api';
import { date, money, moneyWhole, number, paiseToRupees, periodWord, rupeesToPaise } from '../lib/format';
import { useMe } from '../shell';
import {
  Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pager, SearchBox, Status, Stepper, Table, Toggle,
  fieldErrors, useAction, useGet, useListParams, useTitle,
} from '../ui';
import { Xray } from './invoices';

const FLOW = ['draft', 'quotation', 'confirmed', 'active', 'closed'];

export default function Subscriptions() {
  return (
    <Routes>
      <Route index element={<ListView />} />
      <Route path="board" element={<BoardView />} />
      <Route path="new" element={<NewSubscription />} />
      <Route path=":id" element={<Detail />} />
    </Routes>
  );
}

function ViewTabs() {
  return (
    <div className="row gap-6">
      <NavLink to="/subscriptions" end className={({ isActive }) => `btn small ${isActive ? 'dark' : ''}`}><List size={14} /> List</NavLink>
      <NavLink to="/subscriptions/board" className={({ isActive }) => `btn small ${isActive ? 'dark' : ''}`}><LayoutGrid size={14} /> Board</NavLink>
      <Link to="/subscriptions/new" className="btn primary small"><Plus size={14} /> New subscription</Link>
    </div>
  );
}

function ListView() {
  useTitle('Subscriptions');
  const list = useListParams();
  const navigate = useNavigate();
  const plans = useGet<any[]>('/plans');
  const { data, error, isLoading } = useGet<any>(`/subscriptions${list.query}`, { keepPrevious: true });
  return (
    <>
      <PageHead title="Subscriptions" actions={<ViewTabs />}>Every contract in one place, instead of a spreadsheet.</PageHead>
      <div className="filters">
        <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Search number or customer" />
        <select className="input" style={{ width: 160 }} value={list.get('status')} onChange={(e) => list.set('status', e.target.value)} aria-label="Status">
          <option value="">Every status</option>
          {['draft', 'quotation', 'confirmed', 'active', 'paused', 'closed'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select className="input" style={{ width: 190 }} value={list.get('planId')} onChange={(e) => list.set('planId', e.target.value)} aria-label="Plan">
          <option value="">Every plan</option>
          {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              onRow={(r: any) => navigate(`/subscriptions/${r.id}`)}
              columns={[
                { label: 'Number', render: (r: any) => <span className="mono">{r.number}</span> },
                { label: 'Customer', render: (r: any) => r.customer_name },
                { label: 'Plan', render: (r: any) => r.plan_name },
                { label: 'Status', render: (r: any) => <Status value={r.status} /> },
                { label: 'Next bill', render: (r: any) => date(r.next_billing_date) },
                { label: 'Expires', render: (r: any) => date(r.expiry_date) },
                { label: 'Each period', num: true, render: (r: any) => money(r.recurring_amount) },
                { label: 'MRR', num: true, render: (r: any) => money(r.mrr) },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="No subscriptions match">Try a wider filter, or create a new subscription.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
    </>
  );
}

function BoardView() {
  useTitle('Subscription board');
  const { data, isLoading } = useGet<any>('/subscriptions/board');
  if (isLoading || !data) return <Loading height={400} />;
  const count = (s: string) => data.counts.find((c: any) => c.status === s);
  return (
    <>
      <PageHead title="Where everything stands" actions={<ViewTabs />}>Anyone on the team can see every subscription's stage at a glance.</PageHead>
      <div className="board">
        {FLOW.map((status) => (
          <div className="lane" key={status}>
            <div className="lane-head"><span>{status[0].toUpperCase() + status.slice(1)}</span><span className="mono muted">{number(count(status)?.n ?? 0)}</span></div>
            {data.cards.filter((c: any) => c.status === status).slice(0, 8).map((c: any) => (
              <Link key={c.id} to={`/subscriptions/${c.id}`} className="ticket">
                <div className="strong truncate">{c.customer_name}</div>
                <div className="row between small muted"><span className="mono">{c.number}</span><span className="mono">{moneyWhole(c.recurring_amount)}</span></div>
                <div className="tiny muted truncate">{c.plan_name}{c.quotation_valid_until ? `, valid to ${date(c.quotation_valid_until)}` : ''}</div>
              </Link>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

interface LineForm { productId: number; variantId: number | null; quantity: number; unitPrice: string }

function LinesEditor({ lines, setLines, products, plan }: { lines: LineForm[]; setLines: (l: LineForm[]) => void; products: any[]; plan?: any }) {
  const update = (i: number, patch: Partial<LineForm>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const priceOf = (l: LineForm) => {
    const product = products.find((p) => p.id === l.productId);
    const variant = product?.variants.find((v: any) => v.id === l.variantId);
    const addon = plan?.addons.find((a: any) => a.product_id === l.productId);
    const base = plan?.product_id === l.productId ? plan.price : addon?.price ?? product?.sales_price ?? 0;
    return base + (variant?.price_extra ?? 0);
  };
  return (
    <div className="card">
      <Table
        columns={[
          { label: 'Product', render: (l: LineForm & { i: number }) => (
            <select className="input" value={l.productId} aria-label="Product" onChange={(e) => update(l.i, { productId: Number(e.target.value), variantId: null, unitPrice: '' })}>
              {products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) },
          { label: 'Variant', render: (l: LineForm & { i: number }) => {
            const variants = products.find((p) => p.id === l.productId)?.variants ?? [];
            if (!variants.length) return <span className="muted">—</span>;
            return (
              <select className="input" value={l.variantId ?? ''} aria-label="Variant" onChange={(e) => update(l.i, { variantId: e.target.value ? Number(e.target.value) : null, unitPrice: '' })}>
                <option value="">None</option>
                {variants.map((v: any) => <option key={v.id} value={v.id}>{v.value} (+{moneyWhole(v.price_extra)})</option>)}
              </select>
            );
          } },
          { label: 'Quantity', render: (l: LineForm & { i: number }) => <input className="input" style={{ width: 80 }} type="number" min={1} value={l.quantity} aria-label="Quantity" onChange={(e) => update(l.i, { quantity: Number(e.target.value) })} /> },
          { label: 'Unit price (₹)', render: (l: LineForm & { i: number }) => <input className="input" style={{ width: 120 }} type="number" min={0} value={l.unitPrice} placeholder={paiseToRupees(priceOf(l))} aria-label="Unit price" onChange={(e) => update(l.i, { unitPrice: e.target.value })} /> },
          { label: 'Amount', num: true, render: (l: LineForm & { i: number }) => money(l.quantity * (l.unitPrice ? rupeesToPaise(l.unitPrice) : priceOf(l))) },
          { label: '', render: (l: LineForm & { i: number }) => <button className="btn ghost small" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== l.i))}><Trash2 size={14} /></button> },
        ]}
        rows={lines.map((l, i) => ({ ...l, i }))}
      />
      <div style={{ padding: 10 }}>
        <Button size="small" onClick={() => setLines([...lines, { productId: products[0].id, variantId: null, quantity: 1, unitPrice: '' }])}><Plus size={14} /> Add a line</Button>
      </div>
    </div>
  );
}

function NewSubscription() {
  useTitle('New subscription');
  const { data: me } = useMe();
  const navigate = useNavigate();
  const templates = useGet<any[]>('/quote-templates');
  const plans = useGet<any[]>('/plans');
  const products = useGet<any[]>('/products');
  const terms = useGet<any[]>('/payment-terms');
  const [customerText, setCustomerText] = useState('');
  const customers = useGet<any>(customerText.length >= 2 ? `/customers?q=${encodeURIComponent(customerText)}&pageSize=6` : null);
  const [form, setForm] = useState<any>({ customer: null, templateId: '', planId: '', startDate: '', paymentTermId: '' });
  const [lines, setLines] = useState<LineForm[]>([]);
  const plan = useMemo(() => plans.data?.find((p) => p.id === Number(form.planId)), [plans.data, form.planId]);

  useEffect(() => {
    if (me && !form.startDate) setForm((f: any) => ({ ...f, startDate: me.today }));
  }, [me]);

  const useTemplate = (id: string) => {
    const t = templates.data?.find((x) => x.id === Number(id));
    setForm((f: any) => ({ ...f, templateId: id, planId: t?.plan_id ?? f.planId }));
    if (t) setLines(t.lines.map((l: any) => ({ productId: l.product_id, variantId: l.variant_id, quantity: l.quantity, unitPrice: l.unit_price ? paiseToRupees(l.unit_price) : '' })));
  };

  const usePlan = (id: string) => {
    const p = plans.data?.find((x) => x.id === Number(id));
    setForm((f: any) => ({ ...f, planId: id, templateId: '' }));
    if (p?.product_id) setLines([{ productId: p.product_id, variantId: null, quantity: p.min_quantity, unitPrice: '' }]);
  };

  const create = useAction(
    () => post('/subscriptions', {
      customerId: form.customer?.id, planId: Number(form.planId), templateId: form.templateId ? Number(form.templateId) : null,
      startDate: form.startDate, paymentTermId: form.paymentTermId ? Number(form.paymentTermId) : null,
      lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice ? rupeesToPaise(l.unitPrice) : null })),
    }),
    { success: (r) => `${r.number} created as a draft`, onDone: (r) => navigate(`/subscriptions/${r.id}`) },
  );
  const errors = fieldErrors(create.error);

  return (
    <>
      <PageHead title="New subscription">Start from a quotation template, or build one line by line.</PageHead>
      <div className="grid split">
        <div className="col">
          <div className="card pad">
            <h2>Start from a template</h2>
            <div className="grid three mt-8" style={{ gap: 8 }}>
              {templates.data?.map((t) => (
                <button key={t.id} className={`card pad ${String(t.id) === form.templateId ? 'water' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', padding: 10, borderColor: String(t.id) === form.templateId ? 'var(--magenta)' : undefined }} onClick={() => useTemplate(String(t.id))}>
                  <div className="strong">{t.name}</div>
                  <div className="tiny muted">{t.plan_name}, valid {t.validity_days} days</div>
                </button>
              ))}
            </div>
          </div>
          <div className="card pad">
            <div className="form-grid">
              <div className="field wide">
                <span className="field-label">Customer</span>
                {form.customer ? (
                  <div className="row"><span className="badge sea plain">{form.customer.name}</span><Button size="small" variant="ghost" onClick={() => setForm({ ...form, customer: null })}>Change</Button></div>
                ) : (
                  <>
                    <input className="input" value={customerText} onChange={(e) => setCustomerText(e.target.value)} placeholder="Type a company name" aria-label="Search customers" />
                    {customers.data?.rows.map((c: any) => (
                      <button key={c.id} className="btn ghost small" style={{ justifyContent: 'flex-start' }} onClick={() => setForm({ ...form, customer: c, paymentTermId: '' })}>{c.name} <span className="muted">{c.city}</span></button>
                    ))}
                  </>
                )}
              </div>
              <Field label="Plan" error={errors.planId}>
                <select className="input" value={form.planId} onChange={(e) => usePlan(e.target.value)}>
                  <option value="">Choose a plan</option>
                  {plans.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Start date" error={errors.startDate}><input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field label="Payment terms">
                <select className="input" value={form.paymentTermId} onChange={(e) => setForm({ ...form, paymentTermId: e.target.value })}>
                  <option value="">Customer default</option>
                  {terms.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              {plan && <div className="callout small" style={{ alignSelf: 'end' }}>{plan.name}: {money(plan.price)} per {periodWord[plan.billing_unit]}, minimum {plan.min_quantity}</div>}
            </div>
          </div>
          {products.data && lines.length > 0 && <LinesEditor lines={lines} setLines={setLines} products={products.data} plan={plan} />}
          <ErrorNote error={create.error} />
          <div><Button variant="primary" disabled={!form.customer || !form.planId} loading={create.isPending} onClick={() => create.mutate()}>Create draft</Button></div>
        </div>
      </div>
    </>
  );
}

function Detail() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data, error, isLoading } = useGet<any>(`/subscriptions/${id}`);
  useTitle(data?.sub.number ?? 'Subscription');
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');

  const move = useAction((to: string) => post(`/subscriptions/${id}/transition`, { to, reason }), { success: 'Status updated', onDone: () => setClosing(false) });
  const pause = useAction(() => post(`/subscriptions/${id}/pause`), { success: 'Paused. Billing has stopped' });
  const resume = useAction(() => post(`/subscriptions/${id}/resume`), { success: 'Back on. Billing has restarted' });
  const renew = useAction(() => post(`/subscriptions/${id}/renew`), { success: (r) => `Renewed until ${date(r.until)}` });
  const addDiscount = useAction(() => post(`/subscriptions/${id}/discounts`, { code }), { success: 'Discount added. It appears on the next invoice by itself', onDone: () => setCode('') });
  const removeDiscount = useAction((discountId: number) => del(`/subscriptions/${id}/discounts/${discountId}`), { success: 'Discount removed' });
  const addon = useAction((v: { productId: number; enable: boolean }) => post(`/subscriptions/${id}/addons`, v), { success: (r) => r.message });

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={480} />;
  const { sub, lines, events, invoices, discounts, addons, next } = data;

  const live = ['active', 'paused'].includes(sub.status);
  const nextMove = { draft: ['quotation', 'Send quotation'], quotation: ['confirmed', 'Mark as accepted'], confirmed: ['active', 'Activate now'] }[sub.status as string];
  const canForceClose = me?.user?.role === 'admin';
  const canClose = live ? sub.closable || canForceClose : sub.status !== 'closed';

  return (
    <>
      <PageHead
        title={`${sub.number}, ${sub.customer_name}`}
        actions={
          <>
            {nextMove && <Button variant="primary" onClick={() => move.mutate(nextMove[0])} loading={move.isPending}>{nextMove[1]}</Button>}
            {sub.status === 'active' && sub.pausable && <Button onClick={() => pause.mutate()}>Pause</Button>}
            {sub.status === 'paused' && <Button variant="primary" onClick={() => resume.mutate()}>Resume</Button>}
            {live && sub.renewable && <Button onClick={() => renew.mutate()}>Renew now</Button>}
            {canClose && <Button variant="danger" onClick={() => setClosing(true)}>Close</Button>}
          </>
        }
      >
        <Link className="link" to={`/customers/${sub.customer_id}`}>{sub.customer_name}</Link>, {sub.plan_name}
      </PageHead>

      <div className="card pad row between wrap">
        <Stepper steps={FLOW} current={sub.status === 'paused' ? 'active' : sub.status} />
        {sub.status === 'paused' && <span className="badge warn">Paused since {date(sub.paused_on)}</span>}
      </div>

      <div className="grid split mt-16">
        <div className="col">
          <div className="card">
            <div className="card-head"><h2>Lines</h2></div>
            <Table
              columns={[
                { label: 'Product', render: (l: any) => <>{l.description}{l.active_until && <div className="tiny muted">Ends {date(l.active_until)}</div>}</> },
                { label: 'Qty', num: true, render: (l: any) => l.quantity },
                { label: 'Unit price', num: true, render: (l: any) => money(l.unit_price) },
                { label: 'Amount', num: true, render: (l: any) => money(l.quantity * l.unit_price) },
              ]}
              rows={lines}
            />
            {next && (
              <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
                <div className="row between"><span className="strong">Next invoice, {date(next.period.start)}</span><span className="mono strong">{money(next.total)}</span></div>
                <div className="small muted">Subtotal {money(next.subtotal)}, discount {money(next.discount)}, tax {money(next.tax)}</div>
              </div>
            )}
          </div>

          {next && (
            <div className="card">
              <div className="card-head"><h2>How the next invoice adds up</h2></div>
              <div className="card-body"><Xray trace={next.trace} /></div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><h2>Invoices</h2></div>
            <Table
              columns={[
                { label: 'Number', render: (i: any) => <Link className="link mono" to={`/invoices/${i.id}`}>{i.number ?? 'Draft'}</Link> },
                { label: 'Period', render: (i: any) => `${date(i.period_start)} to ${date(i.period_end)}` },
                { label: 'Status', render: (i: any) => <Status value={i.status} /> },
                { label: 'Total', num: true, render: (i: any) => money(i.total) },
              ]}
              rows={invoices}
              empty={<Empty title="Nothing billed yet">The first invoice appears on the next billing run.</Empty>}
            />
          </div>
        </div>

        <div className="col">
          <div className="card pad">
            <dl className="col gap-6" style={{ margin: 0 }}>
              {[
                ['Start', date(sub.start_date)],
                ['Expiry', date(sub.expiry_date)],
                ['Next bill', date(sub.next_billing_date)],
                ['Payment terms', sub.payment_term],
                ['Billed', `Every ${periodWord[sub.billing_unit]}`],
                ['Each period', money(sub.recurring_amount)],
                ['MRR', money(sub.mrr)],
                ['Renews by itself', sub.auto_renew ? 'Yes' : 'No'],
                ['Owner', sub.owner_name ?? '—'],
                ...(sub.template_name ? [['Template', sub.template_name]] : []),
                ...(sub.quotation_valid_until ? [['Quote valid to', date(sub.quotation_valid_until)]] : []),
                ...(sub.close_reason ? [['Closed because', sub.close_reason]] : []),
              ].map(([k, v]) => <div className="row between small" key={k as string}><dt className="muted">{k}</dt><dd style={{ margin: 0 }} className="strong">{v}</dd></div>)}
            </dl>
            <div className="row wrap gap-4 mt-12">
              {sub.closable ? <span className="badge plain">Closable</span> : <span className="badge plain warn">Cannot close early</span>}
              {sub.pausable && <span className="badge plain">Pausable</span>}
              {sub.renewable && <span className="badge plain">Renewable</span>}
              {sub.auto_close && <span className="badge plain">Closes on its own</span>}
            </div>
          </div>

          {sub.status === 'active' && addons.length > 0 && (
            <div className="card pad">
              <h2>Add-ons</h2>
              {addons.map((a: any) => (
                <div className="addon" key={a.product_id}>
                  <div className="grow"><div className="strong">{a.name}</div><div className="small muted mono">{money(a.price)}</div></div>
                  <Toggle checked={a.enabled} label={a.name} onChange={(enable) => addon.mutate({ productId: a.product_id, enable })} />
                </div>
              ))}
            </div>
          )}

          <div className="card pad">
            <h2>Discounts</h2>
            {discounts.map((d: any) => (
              <div className="row between small mt-8" key={d.id}>
                <span><span className="badge magenta plain">{d.code}</span> {d.valid_until ? `until ${date(d.valid_until)}` : ''}</span>
                {sub.status !== 'closed' && <Button size="small" variant="ghost" onClick={() => removeDiscount.mutate(d.id)}>Remove</Button>}
              </div>
            ))}
            {discounts.length === 0 && <p className="small muted mt-4">None yet.</p>}
            {sub.status !== 'closed' && (
              <form className="row mt-8" onSubmit={(e) => { e.preventDefault(); addDiscount.mutate(); }}>
                <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Discount code" aria-label="Discount code" />
                <Button type="submit" disabled={!code}>Add</Button>
              </form>
            )}
          </div>

          <div className="card pad">
            <h2>History</h2>
            <div className="timeline mt-8">
              {events.map((e: any) => (
                <div className="ev" key={e.id}>
                  <div>
                    <div className="small strong">{eventText(e)}</div>
                    <div className="tiny muted">{date(e.on_date)}, {e.actor}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={closing} onClose={() => setClosing(false)} title={`Close ${sub.number}`}
        footer={<><Button onClick={() => setClosing(false)}>Keep it open</Button><Button variant="danger" onClick={() => move.mutate('closed')} loading={move.isPending}>Close subscription</Button></>}>
        {live && !sub.closable && <div className="callout warn small" style={{ marginBottom: 10 }}>{sub.plan_name} is contracted and cannot be closed early. As admin, you can override that.</div>}
        <Field label="Why is it closing?"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Moved to a competitor" /></Field>
      </Dialog>
    </>
  );
}

function eventText(e: any) {
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'created': return `Created${d.template ? ` from ${d.template}` : ''}`;
    case 'status': return `Moved to ${e.to_status}`;
    case 'activated': return 'Went live';
    case 'closed': return `Closed${d.reason ? `: ${d.reason}` : ''}`;
    case 'paused': return 'Paused';
    case 'resumed': return 'Resumed';
    case 'renewed': return `Renewed until ${date(d.until)}`;
    case 'addon_on': return `${d.addon} switched on`;
    case 'addon_off': return `${d.addon} switched off`;
    case 'discount_added': return `Discount ${d.code} added`;
    case 'discount_removed': return 'Discount removed';
    case 'lines_updated': return 'Lines changed';
    default: return e.kind;
  }
}
