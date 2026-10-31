import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { post, put } from '../lib/api';
import { date, INDIAN_STATES, METHOD_LABEL, money, number } from '../lib/format';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pager, SearchBox, Stat, Status, Table, fieldErrors, useAction, useGet, useListParams, useTitle } from '../ui';

export default function Customers() {
  return (
    <Routes>
      <Route index element={<ListView />} />
      <Route path=":id" element={<Detail />} />
    </Routes>
  );
}

function CustomerForm({ initial, onClose }: { initial: any; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(initial);
  const terms = useGet<any[]>('/payment-terms');
  const set = (key: string) => (e: any) => setForm({ ...form, [key]: e.target.value });
  const save = useAction(() => {
    const state = INDIAN_STATES.find(([code]) => code === form.stateCode);
    const payload = { ...form, stateName: state?.[1] ?? null, paymentTermId: form.paymentTermId ? Number(form.paymentTermId) : null };
    return form.id ? put(`/customers/${form.id}`, payload) : post('/customers', payload);
  }, { success: 'Customer saved', onDone: (r) => { onClose(); if (r.id) navigate(`/customers/${r.id}`); } });
  const errors = fieldErrors(save.error);
  return (
    <Dialog open wide onClose={onClose} title={form.id ? `Edit ${form.name}` : 'New customer'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save customer</Button></>}>
      <div className="form-grid">
        <Field label="Company name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} /></Field>
        <Field label="Billing email" error={errors.email}><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Phone"><input className="input" value={form.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="GSTIN" error={errors.gstin}><input className="input" value={form.gstin ?? ''} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></Field>
        <Field label="State" hint="Decides CGST and SGST, or IGST">
          <select className="input" value={form.stateCode ?? ''} onChange={set('stateCode')}>
            <option value="">Outside India, or unknown</option>
            {INDIAN_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </Field>
        <Field label="City"><input className="input" value={form.city ?? ''} onChange={set('city')} /></Field>
        <Field label="Size">
          <select className="input" value={form.segment} onChange={set('segment')}><option value="small">Small</option><option value="mid">Mid</option><option value="enterprise">Enterprise</option></select>
        </Field>
        <Field label="Payment terms">
          <select className="input" value={form.paymentTermId ?? ''} onChange={set('paymentTermId')}>
            <option value="">Default</option>
            {terms.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Address" className="wide"><input className="input" value={form.address ?? ''} onChange={set('address')} /></Field>
        <div className="wide"><ErrorNote error={save.error && !Object.keys(errors).length ? save.error : null} /></div>
      </div>
    </Dialog>
  );
}

function ListView() {
  useTitle('Customers');
  const list = useListParams();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data, error, isLoading } = useGet<any>(`/customers${list.query}`, { keepPrevious: true });
  return (
    <>
      <PageHead title="Customers" actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={14} /> New customer</Button>}>Small shops on monthly plans to large companies on yearly contracts.</PageHead>
      <div className="filters">
        <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Search name, email or code" />
        <select className="input" style={{ width: 150 }} value={list.get('segment')} onChange={(e) => list.set('segment', e.target.value)} aria-label="Size">
          <option value="">Every size</option><option value="small">Small</option><option value="mid">Mid</option><option value="enterprise">Enterprise</option>
        </select>
        <select className="input" style={{ width: 160 }} value={list.get('stateCode')} onChange={(e) => list.set('stateCode', e.target.value)} aria-label="State">
          <option value="">Every state</option>
          {INDIAN_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {isLoading ? <Loading /> : (
          <>
            <Table
              onRow={(r: any) => navigate(`/customers/${r.id}`)}
              columns={[
                { label: 'Customer', render: (r: any) => <><div className="strong">{r.name}</div><div className="tiny muted">{r.code}, {r.email}</div></> },
                { label: 'Place', render: (r: any) => [r.city, r.state_name].filter(Boolean).join(', ') },
                { label: 'Size', render: (r: any) => <span className="badge plain">{r.segment}</span> },
                { label: 'Active subs', num: true, render: (r: any) => r.active_subscriptions },
                { label: 'MRR', num: true, render: (r: any) => money(r.mrr) },
                { label: 'Owed', num: true, render: (r: any) => money(r.outstanding) },
              ]}
              rows={data?.rows ?? []}
              empty={<Empty title="No customers match">Try another search.</Empty>}
            />
            {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => list.set('page', String(p))} />}
          </>
        )}
      </div>
      {adding && <CustomerForm initial={{ name: '', email: '', segment: 'small', country: 'IN', stateCode: '32' }} onClose={() => setAdding(false)} />}
    </>
  );
}

function Detail() {
  const { id } = useParams();
  const { data, error, isLoading } = useGet<any>(`/customers/${id}`);
  useTitle(data?.customer.name ?? 'Customer');
  const [editing, setEditing] = useState(false);
  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={480} />;
  const { customer: c, subscriptions, invoices, payments, totals } = data;
  const mrr = subscriptions.reduce((sum: number, s: any) => sum + (s.status === 'active' ? s.mrr : 0), 0);
  return (
    <>
      <PageHead title={c.name} actions={<><Link className="btn primary" to="/subscriptions/new">New subscription</Link><Button onClick={() => setEditing(true)}>Edit</Button></>}>
        {c.code}, {[c.city, c.state_name].filter(Boolean).join(', ')}{c.gstin ? `, GSTIN ${c.gstin}` : ''}
      </PageHead>
      <div className="grid four">
        <Stat label="MRR" value={money(mrr)} foot={`${number(subscriptions.filter((s: any) => s.status === 'active').length)} active subscriptions`} />
        <Stat label="Paid so far" value={money(totals.lifetime)} />
        <Stat label="Still owed" value={money(totals.outstanding)} foot={c.payment_term ?? ''} />
        <Stat label="Overdue" value={money(totals.overdue)} alert={totals.overdue > 0} />
      </div>
      <div className="grid two mt-16">
        <div className="card">
          <div className="card-head"><h2>Subscriptions</h2></div>
          <Table
            columns={[
              { label: 'Number', render: (s: any) => <Link className="link mono" to={`/subscriptions/${s.id}`}>{s.number}</Link> },
              { label: 'Plan', render: (s: any) => s.plan_name },
              { label: 'Status', render: (s: any) => <Status value={s.status} /> },
              { label: 'Each period', num: true, render: (s: any) => money(s.recurring_amount) },
            ]}
            rows={subscriptions}
            empty={<Empty title="No subscriptions yet" />}
          />
        </div>
        <div className="card">
          <div className="card-head"><h2>Recent invoices</h2></div>
          <Table
            columns={[
              { label: 'Number', render: (i: any) => <Link className="link mono small" to={`/invoices/${i.id}`}>{i.number ?? 'Draft'}</Link> },
              { label: 'Due', render: (i: any) => date(i.due_date) },
              { label: 'Status', render: (i: any) => <Status value={i.status} /> },
              { label: 'Total', num: true, render: (i: any) => money(i.total) },
            ]}
            rows={invoices}
            empty={<Empty title="Nothing billed yet" />}
          />
        </div>
        <div className="card">
          <div className="card-head"><h2>Recent payments</h2></div>
          <Table
            columns={[
              { label: 'Date', render: (p: any) => date(p.paid_on) },
              { label: 'Method', render: (p: any) => METHOD_LABEL[p.method] },
              { label: 'Amount', num: true, render: (p: any) => money(p.amount) },
            ]}
            rows={payments}
            empty={<Empty title="No payments yet" />}
          />
        </div>
        <div className="card pad small">
          <h3>Details</h3>
          <div className="col gap-4 mt-8">
            <div className="row between"><span className="muted">Email</span><span>{c.email}</span></div>
            <div className="row between"><span className="muted">Phone</span><span>{c.phone ?? '—'}</span></div>
            <div className="row between"><span className="muted">Address</span><span>{c.address ?? '—'}</span></div>
            <div className="row between"><span className="muted">Size</span><span>{c.segment}</span></div>
          </div>
        </div>
      </div>
      {editing && (
        <CustomerForm
          onClose={() => setEditing(false)}
          initial={{ id: c.id, name: c.name, email: c.email, phone: c.phone, gstin: c.gstin, stateCode: c.state_code, city: c.city, address: c.address, country: c.country, segment: c.segment, paymentTermId: c.payment_term_id }}
        />
      )}
    </>
  );
}
