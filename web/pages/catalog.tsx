import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { post, put } from '../lib/api';
import { bp, date, money, moneyWhole, number, paiseToRupees, periodWord, rupeesToPaise } from '../lib/format';
import { useMe } from '../shell';
import { Button, Dialog, ErrorNote, Field, Loading, PageHead, Status, Table, Toggle, fieldErrors, useAction, useGet, useTitle } from '../ui';

const TABS = [['products', 'Products'], ['plans', 'Plans'], ['discounts', 'Discounts'], ['taxes', 'Tax rules'], ['templates', 'Quotation templates'], ['team', 'Team']];

export default function Catalog() {
  useTitle('Catalog');
  return (
    <>
      <PageHead title="Catalog and setup">What Brightloop sells, and the rules it sells by. Only the admin can change these.</PageHead>
      <div className="tabs">
        {TABS.map(([to, label]) => <NavLink key={to} to={`/catalog/${to}`} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
      </div>
      <Routes>
        <Route index element={<Navigate to="products" replace />} />
        <Route path="products" element={<Products />} />
        <Route path="plans" element={<Plans />} />
        <Route path="discounts" element={<Discounts />} />
        <Route path="taxes" element={<Taxes />} />
        <Route path="templates" element={<Templates />} />
        <Route path="team" element={<Team />} />
      </Routes>
    </>
  );
}

const useIsAdmin = () => useMe().data?.user?.role === 'admin';

function Products() {
  const admin = useIsAdmin();
  const { data, isLoading } = useGet<any[]>('/products');
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', type: 'software', salesPrice: '', costPrice: '', notes: '', taxCategory: 'software', sac: '997331', active: true, variants: [] };
  const open = (p?: any) => setEdit(p ? {
    id: p.id, name: p.name, type: p.type, salesPrice: paiseToRupees(p.sales_price), costPrice: paiseToRupees(p.cost_price), notes: p.notes ?? '',
    taxCategory: p.tax_category, sac: p.sac ?? '', active: p.active,
    variants: p.variants.map((v: any) => ({ attribute: v.attribute, value: v.value, priceExtra: paiseToRupees(v.price_extra) })),
  } : blank);
  const save = useAction(() => {
    const payload = { ...edit, salesPrice: rupeesToPaise(edit.salesPrice), costPrice: rupeesToPaise(edit.costPrice), variants: edit.variants.map((v: any) => ({ ...v, priceExtra: rupeesToPaise(v.priceExtra) })) };
    return edit.id ? put(`/products/${edit.id}`, payload) : post('/products', payload);
  }, { success: 'Product saved', onDone: () => setEdit(null) });
  const errors = fieldErrors(save.error);
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">{data?.length} products</span>
        {admin && <Button variant="primary" onClick={() => open()}><Plus size={14} /> New product</Button>}
      </div>
      <div className="card">
        <Table
          onRow={admin ? open : undefined}
          columns={[
            { label: 'Name', render: (p: any) => <><div className="strong">{p.name}</div><div className="tiny muted truncate" style={{ maxWidth: 340 }}>{p.notes}</div></> },
            { label: 'Type', render: (p: any) => <span className="badge plain">{p.type}</span> },
            { label: 'Variants', render: (p: any) => p.variants.length ? <div className="row wrap gap-4">{p.variants.map((v: any) => <span key={v.id} className="badge sea plain">{v.value} +{moneyWhole(v.price_extra)}</span>)}</div> : <span className="muted">—</span> },
            { label: 'Sales price', num: true, render: (p: any) => money(p.sales_price) },
            { label: 'Cost price', num: true, render: (p: any) => money(p.cost_price) },
            { label: 'Margin', num: true, render: (p: any) => (p.sales_price ? `${Math.round((1 - p.cost_price / p.sales_price) * 100)}%` : '—') },
            { label: 'On live subs', num: true, render: (p: any) => number(p.in_use) },
          ]}
          rows={data ?? []}
        />
      </div>
      <Dialog open={!!edit} wide onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New product'}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save product</Button></>}>
        {edit && (
          <div className="form-grid">
            <Field label="Name" error={errors.name}><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Type">
              <select className="input" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                {['software', 'service', 'addon', 'goods'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Sales price (₹)" error={errors.salesPrice}><input className="input" type="number" value={edit.salesPrice} onChange={(e) => setEdit({ ...edit, salesPrice: e.target.value })} /></Field>
            <Field label="Cost price (₹)" error={errors.costPrice}><input className="input" type="number" value={edit.costPrice} onChange={(e) => setEdit({ ...edit, costPrice: e.target.value })} /></Field>
            <Field label="Tax category" hint="Tax rules match on this"><input className="input" value={edit.taxCategory} onChange={(e) => setEdit({ ...edit, taxCategory: e.target.value })} /></Field>
            <Field label="SAC code"><input className="input" value={edit.sac} onChange={(e) => setEdit({ ...edit, sac: e.target.value })} /></Field>
            <Field label="Notes" className="wide"><textarea className="input" rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
            <div className="wide">
              <div className="row between"><h3>Variants</h3><Button size="small" onClick={() => setEdit({ ...edit, variants: [...edit.variants, { attribute: 'Brand', value: '', priceExtra: '' }] })}><Plus size={13} /> Add variant</Button></div>
              {edit.variants.length === 0 && <p className="small muted mt-4">For example, Brand: Odoo adds ₹560 to the price.</p>}
              {edit.variants.map((v: any, i: number) => {
                const update = (patch: any) => setEdit({ ...edit, variants: edit.variants.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div className="row mt-8" key={i}>
                    <input className="input" value={v.attribute} placeholder="Attribute" aria-label="Attribute" onChange={(e) => update({ attribute: e.target.value })} />
                    <input className="input" value={v.value} placeholder="Value" aria-label="Value" onChange={(e) => update({ value: e.target.value })} />
                    <input className="input" type="number" value={v.priceExtra} placeholder="Adds ₹" aria-label="Price extra" onChange={(e) => update({ priceExtra: e.target.value })} />
                    <button className="btn ghost small" aria-label="Remove variant" onClick={() => setEdit({ ...edit, variants: edit.variants.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
            <div className="wide"><ErrorNote error={save.error} /></div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Plans() {
  const admin = useIsAdmin();
  const { data, isLoading } = useGet<any[]>('/plans');
  const products = useGet<any[]>('/products');
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', productId: '', price: '', billingUnit: 'monthly', billingInterval: 1, minQuantity: 1, availableFrom: '', availableUntil: '', autoClose: false, closable: true, pausable: true, renewable: true, termMonths: 12, notes: '', active: true, addons: [] };
  const open = (p?: any) => setEdit(p ? {
    id: p.id, name: p.name, productId: p.product_id ?? '', price: paiseToRupees(p.price), billingUnit: p.billing_unit, billingInterval: p.billing_interval, minQuantity: p.min_quantity,
    availableFrom: p.available_from ?? '', availableUntil: p.available_until ?? '', autoClose: p.auto_close, closable: p.closable, pausable: p.pausable, renewable: p.renewable,
    termMonths: p.term_months, notes: p.notes ?? '', active: p.active, addons: p.addons.map((a: any) => ({ productId: a.product_id, price: a.price })),
  } : blank);
  const save = useAction(() => {
    const payload = { ...edit, productId: edit.productId ? Number(edit.productId) : null, price: rupeesToPaise(edit.price), availableFrom: edit.availableFrom || null, availableUntil: edit.availableUntil || null, minQuantity: Number(edit.minQuantity), termMonths: Number(edit.termMonths), billingInterval: Number(edit.billingInterval) };
    return edit.id ? put(`/plans/${edit.id}`, payload) : post('/plans', payload);
  }, { success: 'Plan saved', onDone: () => setEdit(null) });
  const errors = fieldErrors(save.error);
  const flag = (key: string, label: string, hint: string) => (
    <label className="check"><input type="checkbox" checked={edit[key]} onChange={(e) => setEdit({ ...edit, [key]: e.target.checked })} /><span>{label}<small>{hint}</small></span></label>
  );
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">Each plan sets its own rules for closing, pausing and renewing</span>
        {admin && <Button variant="primary" onClick={() => open()}><Plus size={14} /> New plan</Button>}
      </div>
      <div className="card">
        <Table
          onRow={admin ? open : undefined}
          columns={[
            { label: 'Plan', render: (p: any) => <><div className="strong">{p.name}</div><div className="tiny muted">{p.product_name}</div></> },
            { label: 'Price', num: true, render: (p: any) => <>{money(p.price)}<span className="muted small"> / {periodWord[p.billing_unit]}</span></> },
            { label: 'Min qty', num: true, render: (p: any) => p.min_quantity },
            { label: 'Available', render: (p: any) => (p.available_from || p.available_until ? <span className="small">{date(p.available_from)} to {date(p.available_until)}</span> : <span className="muted small">Always</span>) },
            { label: 'Rules', render: (p: any) => (
              <div className="row wrap gap-4">
                {p.auto_close && <span className="badge plain warn">Closes on its own</span>}
                {p.closable ? <span className="badge plain">Closable</span> : <span className="badge plain bad">No early close</span>}
                {p.pausable && <span className="badge plain">Pausable</span>}
                {p.renewable && <span className="badge plain">Renewable</span>}
              </div>
            ) },
            { label: 'Active', num: true, render: (p: any) => number(p.active_subscriptions) },
          ]}
          rows={data ?? []}
        />
      </div>
      <Dialog open={!!edit} wide onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New plan'}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save plan</Button></>}>
        {edit && (
          <div className="form-grid">
            <Field label="Name" error={errors.name}><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Main product">
              <select className="input" value={edit.productId} onChange={(e) => setEdit({ ...edit, productId: e.target.value })}>
                <option value="">Choose a product</option>
                {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Price (₹)" error={errors.price}><input className="input" type="number" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></Field>
            <Field label="Bills every">
              <select className="input" value={edit.billingUnit} onChange={(e) => setEdit({ ...edit, billingUnit: e.target.value })}>
                {['daily', 'weekly', 'monthly', 'yearly'].map((u) => <option key={u} value={u}>{periodWord[u]}</option>)}
              </select>
            </Field>
            <Field label="Minimum quantity" error={errors.minQuantity}><input className="input" type="number" min={1} value={edit.minQuantity} onChange={(e) => setEdit({ ...edit, minQuantity: e.target.value })} /></Field>
            <Field label="Contract length (months)"><input className="input" type="number" min={1} value={edit.termMonths} onChange={(e) => setEdit({ ...edit, termMonths: e.target.value })} /></Field>
            <Field label="Available from"><input className="input" type="date" value={edit.availableFrom} onChange={(e) => setEdit({ ...edit, availableFrom: e.target.value })} /></Field>
            <Field label="Available until" error={errors.availableUntil}><input className="input" type="date" value={edit.availableUntil} onChange={(e) => setEdit({ ...edit, availableUntil: e.target.value })} /></Field>
            <div className="wide grid two" style={{ gap: 10 }}>
              {flag('autoClose', 'Closes on its own', 'Ends by itself at the end of the contract')}
              {flag('closable', 'Can be closed early', 'Customers can close it before the end')}
              {flag('pausable', 'Can be paused', 'Billing stops until it resumes')}
              {flag('renewable', 'Can be renewed', 'The contract can extend')}
            </div>
            <div className="wide"><ErrorNote error={save.error} /></div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Discounts() {
  const admin = useIsAdmin();
  const { data, isLoading } = useGet<any[]>('/discounts');
  const products = useGet<any[]>('/products');
  const [edit, setEdit] = useState<any>(null);
  const blank = { code: '', name: '', kind: 'percent', value: '', minPurchase: '', minQuantity: '', validFrom: '', validUntil: '', usageLimit: '', scope: 'subscription', productIds: [], autoApply: false, active: true };
  const open = (d?: any) => setEdit(d ? {
    id: d.id, code: d.code, name: d.name, kind: d.kind, value: d.kind === 'percent' ? d.value / 100 : d.value / 100, minPurchase: paiseToRupees(d.min_purchase), minQuantity: d.min_quantity,
    validFrom: d.valid_from ?? '', validUntil: d.valid_until ?? '', usageLimit: d.usage_limit ?? '', scope: d.scope, productIds: d.product_ids, autoApply: d.auto_apply, active: d.active,
  } : blank);
  const save = useAction(() => {
    const payload = {
      ...edit, value: Math.round(Number(edit.value) * 100), minPurchase: rupeesToPaise(edit.minPurchase || 0), minQuantity: Number(edit.minQuantity || 0),
      validFrom: edit.validFrom || null, validUntil: edit.validUntil || null, usageLimit: edit.usageLimit ? Number(edit.usageLimit) : null,
    };
    return edit.id ? put(`/discounts/${edit.id}`, payload) : post('/discounts', payload);
  }, { success: 'Discount saved', onDone: () => setEdit(null) });
  const errors = fieldErrors(save.error);
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">Once attached, a discount appears on the next invoice by itself and stops when it expires or runs out</span>
        {admin && <Button variant="primary" onClick={() => open()}><Plus size={14} /> New discount</Button>}
      </div>
      <div className="card">
        <Table
          onRow={admin ? open : undefined}
          columns={[
            { label: 'Code', render: (d: any) => <><span className="badge magenta plain">{d.code}</span><div className="tiny muted mt-4">{d.name}</div></> },
            { label: 'Value', render: (d: any) => <span className="mono">{d.kind === 'percent' ? bp(d.value) : money(d.value)}</span> },
            { label: 'Applies to', render: (d: any) => (d.scope === 'products' ? 'Specific products' : 'Whole subscription') },
            { label: 'Needs', render: (d: any) => <span className="small">{[d.min_quantity ? `${d.min_quantity}+ units` : '', d.min_purchase ? `${moneyWhole(d.min_purchase)}+` : ''].filter(Boolean).join(', ') || 'Nothing'}</span> },
            { label: 'Valid', render: (d: any) => <span className="small">{date(d.valid_from)} to {date(d.valid_until)}</span> },
            { label: 'Used', num: true, render: (d: any) => `${number(d.times_used)}${d.usage_limit ? ` of ${number(d.usage_limit)}` : ''}` },
            { label: 'Given', num: true, render: (d: any) => money(d.total_given) },
          ]}
          rows={data ?? []}
        />
      </div>
      <Dialog open={!!edit} wide onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.code}` : 'New discount'}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save discount</Button></>}>
        {edit && (
          <div className="form-grid">
            <Field label="Code" error={errors.code}><input className="input" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name" error={errors.name}><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Kind">
              <select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}><option value="percent">Percentage</option><option value="fixed">Fixed amount</option></select>
            </Field>
            <Field label={edit.kind === 'percent' ? 'Percent off' : 'Amount off (₹)'} error={errors.value}><input className="input" type="number" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
            <Field label="Minimum purchase (₹)"><input className="input" type="number" value={edit.minPurchase} onChange={(e) => setEdit({ ...edit, minPurchase: e.target.value })} /></Field>
            <Field label="Minimum quantity"><input className="input" type="number" value={edit.minQuantity} onChange={(e) => setEdit({ ...edit, minQuantity: e.target.value })} /></Field>
            <Field label="Start date"><input className="input" type="date" value={edit.validFrom} onChange={(e) => setEdit({ ...edit, validFrom: e.target.value })} /></Field>
            <Field label="End date"><input className="input" type="date" value={edit.validUntil} onChange={(e) => setEdit({ ...edit, validUntil: e.target.value })} /></Field>
            <Field label="Usage limit" hint="Leave empty for no limit"><input className="input" type="number" value={edit.usageLimit} onChange={(e) => setEdit({ ...edit, usageLimit: e.target.value })} /></Field>
            <Field label="Applies to">
              <select className="input" value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value })}><option value="subscription">Whole subscription</option><option value="products">Specific products</option></select>
            </Field>
            {edit.scope === 'products' && (
              <div className="wide field">
                <span className="field-label">Products</span>
                <div className="row wrap">
                  {products.data?.map((p) => (
                    <label className="check" key={p.id}>
                      <input type="checkbox" checked={edit.productIds.includes(p.id)} onChange={(e) => setEdit({ ...edit, productIds: e.target.checked ? [...edit.productIds, p.id] : edit.productIds.filter((x: number) => x !== p.id) })} />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </div>
                {errors.productIds && <span className="error">{errors.productIds}</span>}
              </div>
            )}
            <label className="check wide"><input type="checkbox" checked={edit.autoApply} onChange={(e) => setEdit({ ...edit, autoApply: e.target.checked })} /><span>Apply to every eligible subscription<small>Otherwise staff attach it subscription by subscription</small></span></label>
            <div className="wide"><ErrorNote error={save.error} /></div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Taxes() {
  const admin = useIsAdmin();
  const { data, isLoading } = useGet<any[]>('/tax-rules');
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', taxCategory: '', supply: '', components: [{ label: 'GST', rate: '18' }], validFrom: '', validUntil: '', priority: 0, active: true };
  const open = (t?: any) => setEdit(t ? {
    id: t.id, name: t.name, taxCategory: t.tax_category ?? '', supply: t.supply ?? '', components: t.components.map((c: any) => ({ label: c.label, rate: String(c.rate / 100) })),
    validFrom: t.valid_from ?? '', validUntil: t.valid_until ?? '', priority: t.priority, active: t.active,
  } : blank);
  const save = useAction(() => {
    const payload = { ...edit, supply: edit.supply || null, validFrom: edit.validFrom || null, validUntil: edit.validUntil || null, priority: Number(edit.priority), components: edit.components.map((c: any) => ({ label: c.label, rate: Math.round(Number(c.rate) * 100) })) };
    return edit.id ? put(`/tax-rules/${edit.id}`, payload) : post('/tax-rules', payload);
  }, { success: 'Tax rule saved', onDone: () => setEdit(null) });
  const SUPPLY: Record<string, string> = { intra: 'Same state', inter: 'Across states', export: 'Export' };
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">The most specific matching rule wins. If nothing matches, the rehearsal stops the invoice instead of billing zero tax</span>
        {admin && <Button variant="primary" onClick={() => open()}><Plus size={14} /> New rule</Button>}
      </div>
      <div className="card">
        <Table
          onRow={admin ? open : undefined}
          columns={[
            { label: 'Rule', render: (t: any) => <span className="strong">{t.name}</span> },
            { label: 'Supply', render: (t: any) => SUPPLY[t.supply] ?? 'Any' },
            { label: 'Category', render: (t: any) => t.tax_category ?? 'Any' },
            { label: 'Charges', render: (t: any) => <div className="row wrap gap-4">{t.components.map((c: any) => <span key={c.label} className="badge plain mono">{c.label} {bp(c.rate)}</span>)}</div> },
            { label: 'Valid', render: (t: any) => <span className="small">{t.valid_from || t.valid_until ? `${date(t.valid_from)} to ${date(t.valid_until)}` : 'Always'}</span> },
          ]}
          rows={data ?? []}
        />
      </div>
      <Dialog open={!!edit} wide onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New tax rule'}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save rule</Button></>}>
        {edit && (
          <div className="form-grid">
            <Field label="Name" className="wide"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Applies to supply">
              <select className="input" value={edit.supply} onChange={(e) => setEdit({ ...edit, supply: e.target.value })}>
                <option value="">Any</option><option value="intra">Same state</option><option value="inter">Across states</option><option value="export">Export</option>
              </select>
            </Field>
            <Field label="Tax category" hint="Leave empty for all products"><input className="input" value={edit.taxCategory} onChange={(e) => setEdit({ ...edit, taxCategory: e.target.value })} /></Field>
            <Field label="Valid from"><input className="input" type="date" value={edit.validFrom} onChange={(e) => setEdit({ ...edit, validFrom: e.target.value })} /></Field>
            <Field label="Valid until"><input className="input" type="date" value={edit.validUntil} onChange={(e) => setEdit({ ...edit, validUntil: e.target.value })} /></Field>
            <div className="wide">
              <div className="row between"><h3>Components</h3><Button size="small" onClick={() => setEdit({ ...edit, components: [...edit.components, { label: '', rate: '' }] })}><Plus size={13} /> Add</Button></div>
              {edit.components.map((c: any, i: number) => {
                const update = (patch: any) => setEdit({ ...edit, components: edit.components.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div className="row mt-8" key={i}>
                    <input className="input" value={c.label} placeholder="CGST" aria-label="Label" onChange={(e) => update({ label: e.target.value })} />
                    <input className="input" type="number" value={c.rate} placeholder="9" aria-label="Rate percent" onChange={(e) => update({ rate: e.target.value })} />
                    <button className="btn ghost small" aria-label="Remove component" onClick={() => setEdit({ ...edit, components: edit.components.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
            <div className="wide"><ErrorNote error={save.error} /></div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Templates() {
  const admin = useIsAdmin();
  const { data, isLoading } = useGet<any[]>('/quote-templates');
  const plans = useGet<any[]>('/plans');
  const products = useGet<any[]>('/products');
  const [edit, setEdit] = useState<any>(null);
  const save = useAction(() => post('/quote-templates', {
    name: edit.name, planId: Number(edit.planId), validityDays: Number(edit.validityDays), notes: edit.notes || null,
    lines: edit.lines.map((l: any) => ({ productId: Number(l.productId), quantity: Number(l.quantity), unitPrice: l.unitPrice ? rupeesToPaise(l.unitPrice) : null })),
  }), { success: 'Template saved', onDone: () => setEdit(null) });
  const errors = fieldErrors(save.error);
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">Reps start offers from these instead of building them from scratch</span>
        {admin && <Button variant="primary" onClick={() => setEdit({ name: '', planId: '', validityDays: 30, notes: '', lines: [{ productId: products.data?.[0]?.id ?? '', quantity: 1, unitPrice: '' }] })}><Plus size={14} /> New template</Button>}
      </div>
      <div className="grid three">
        {data?.map((t) => (
          <div className="card pad" key={t.id}>
            <h2>{t.name}</h2>
            <div className="small muted">{t.plan_name}, valid {t.validity_days} days</div>
            <div className="col gap-4 mt-8">
              {t.lines.map((l: any, i: number) => (
                <div className="row between small" key={i}><span>{l.quantity} × {l.product_name}</span><span className="mono">{l.unit_price ? money(l.unit_price) : 'List price'}</span></div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title="New quotation template"
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save template</Button></>}>
        {edit && (
          <div className="form-grid">
            <Field label="Name" error={errors.name} className="wide"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Plan" error={errors.planId}>
              <select className="input" value={edit.planId} onChange={(e) => setEdit({ ...edit, planId: e.target.value })}>
                <option value="">Choose</option>
                {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Valid for (days)"><input className="input" type="number" value={edit.validityDays} onChange={(e) => setEdit({ ...edit, validityDays: e.target.value })} /></Field>
            <div className="wide">
              <div className="row between"><h3>Lines</h3><Button size="small" onClick={() => setEdit({ ...edit, lines: [...edit.lines, { productId: products.data?.[0]?.id, quantity: 1, unitPrice: '' }] })}><Plus size={13} /> Add</Button></div>
              {edit.lines.map((l: any, i: number) => {
                const update = (patch: any) => setEdit({ ...edit, lines: edit.lines.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div className="row mt-8" key={i}>
                    <select className="input" value={l.productId} aria-label="Product" onChange={(e) => update({ productId: e.target.value })}>
                      {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <input className="input" style={{ width: 80 }} type="number" value={l.quantity} aria-label="Quantity" onChange={(e) => update({ quantity: e.target.value })} />
                    <input className="input" style={{ width: 120 }} type="number" value={l.unitPrice} placeholder="List price" aria-label="Unit price" onChange={(e) => update({ unitPrice: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Team() {
  const admin = useIsAdmin();
  const { data, isLoading, error } = useGet<any[]>(admin ? '/team' : null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [adding, setAdding] = useState(false);
  const add = useAction(() => post('/team', form), { success: 'Staff member added', onDone: () => { setAdding(false); setForm({ name: '', email: '', password: '' }); } });
  const setActive = useAction((v: { id: number; active: boolean }) => post(`/team/${v.id}/active`, { active: v.active }), { success: 'Updated' });
  const errors = fieldErrors(add.error);
  if (!admin) return <div className="callout">Only the admin can add or manage staff.</div>;
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="grid three" style={{ marginBottom: 14 }}>
        <div className="card pad"><h3>Admin</h3><p className="small muted mt-4">Controls the whole system: products, plans, tax, discounts, team and the clock.</p></div>
        <div className="card pad"><h3>Staff</h3><p className="small muted mt-4">Handles customers, quotes, invoices and payments. Cannot change rules or add people.</p></div>
        <div className="card pad"><h3>Customer</h3><p className="small muted mt-4">Sees only their own subscriptions and invoices, through the portal.</p></div>
      </div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">New people can only join as staff through here. Public signup creates customers only.</span>
        <Button variant="primary" onClick={() => setAdding(true)}><Plus size={14} /> Add staff</Button>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        <Table
          columns={[
            { label: 'Name', render: (u: any) => <span className="strong">{u.name}</span> },
            { label: 'Email', render: (u: any) => u.email },
            { label: 'Role', render: (u: any) => <Status value={u.role === 'admin' ? 'active' : 'open'} /> },
            { label: 'Last sign-in', render: (u: any) => (u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-IN') : 'Never') },
            { label: 'Can sign in', render: (u: any) => (u.role === 'staff' ? <Toggle checked={u.active} label={`${u.name} can sign in`} onChange={(active) => setActive.mutate({ id: u.id, active })} /> : '—') },
          ]}
          rows={data ?? []}
        />
      </div>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a staff member"
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" onClick={() => add.mutate()} loading={add.isPending}>Add staff member</Button></>}>
        <div className="col">
          <Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email" error={errors.email}><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" error={errors.password} hint="More than 8 characters, with upper, lower and special"><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <ErrorNote error={add.error && !Object.keys(errors).length ? add.error : null} />
        </div>
      </Dialog>
    </>
  );
}
