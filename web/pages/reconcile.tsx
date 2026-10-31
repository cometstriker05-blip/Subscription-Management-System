import { FileUp, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, post, upload } from '../lib/api';
import { date, money } from '../lib/format';
import { useMe } from '../shell';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Stat, Status, Table, useAction, useGet, useTitle, useToast } from '../ui';

export default function Reconcile() {
  return (
    <Routes>
      <Route index element={<Start />} />
      <Route path=":id" element={<Statement />} />
    </Routes>
  );
}

function Start() {
  useTitle('Bank matching');
  const { data: me } = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const statements = useGet<any[]>('/reconcile/statements');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const ingest = async (file: File) => {
    setBusy(true);
    try {
      const result = await upload('/reconcile/upload', file);
      if (result.duplicates === result.lines) toast('This statement was uploaded before, so nothing was posted twice', 'bad');
      navigate(`/reconcile/${result.statementId}`);
    } catch (err: any) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const useSample = async () => {
    setBusy(true);
    try {
      const sample = await api('/reconcile/sample');
      await ingest(new File([sample.csv], sample.filename, { type: 'text/csv' }));
    } catch (err: any) {
      toast(err.message, 'bad');
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Bank matching">Stop matching payments by scrolling through bank statements. Drop one in, and Keel posts what it is sure of and asks about the rest.</PageHead>
      <div className="grid split">
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          role="button" tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) ingest(f); }}
        >
          <FileUp size={28} color="var(--magenta)" />
          <h2 className="mt-8">{busy ? 'Reading and matching' : 'Drop a bank statement here'}</h2>
          <p className="muted small mt-4">CSV from any Indian bank. {me?.ai.enabled ? 'PDFs and photos work too, read by Gemini.' : 'PDFs and photos work once Gemini is connected.'}</p>
          <input ref={input} type="file" hidden accept=".csv,.txt,.pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) ingest(f); e.target.value = ''; }} />
        </div>
        <div className="card pad col">
          <h2>No statement to hand?</h2>
          <p className="small muted">Keel can write one from the invoices open right now, with the mess real statements have: quoted references, mangled numbers, TDS deductions, one payment covering two invoices, and credits nobody can explain.</p>
          <div><Button variant="primary" onClick={useSample} loading={busy}>Use a sample statement</Button></div>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-head"><h2>Statements</h2></div>
        <Table
          onRow={(s: any) => navigate(`/reconcile/${s.id}`)}
          columns={[
            { label: 'File', render: (s: any) => <span className="mono small">{s.filename}</span> },
            { label: 'Read by', render: (s: any) => (s.source === 'gemini' ? 'Gemini' : 'CSV parser') },
            { label: 'Uploaded by', render: (s: any) => s.uploaded_by },
            { label: 'Lines', num: true, render: (s: any) => s.line_count },
            { label: 'Posted', num: true, render: (s: any) => s.posted },
            { label: 'Need a look', num: true, render: (s: any) => s.suggested },
            { label: 'No match', num: true, render: (s: any) => s.unmatched },
          ]}
          rows={statements.data ?? []}
          empty={<Empty title="No statements yet">Your first upload appears here.</Empty>}
        />
      </div>
    </>
  );
}

function Statement() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data, error, isLoading } = useGet<any>(`/reconcile/statements/${id}`);
  useTitle(data?.statement.filename ?? 'Statement');
  const [assigning, setAssigning] = useState<any>(null);
  const [invoiceText, setInvoiceText] = useState('');
  const results = useGet<any>(invoiceText.length >= 3 ? `/invoices?q=${encodeURIComponent(invoiceText)}&status=confirmed&pageSize=6` : null);

  const confirm = useAction((v: { id: number; candidate: number }) => post(`/reconcile/lines/${v.id}/confirm`, { candidate: v.candidate }), {
    success: (r) => (r.learned ? `Posted. Keel will recognise “${r.learned}” next time` : 'Posted'),
  });
  const ignore = useAction((lineId: number) => post(`/reconcile/lines/${lineId}/ignore`), { success: 'Ignored' });
  const assign = useAction((invoiceId: number) => post(`/reconcile/lines/${assigning.id}/assign`, { invoiceId }), {
    success: (r) => (r.learned ? `Posted. Keel will recognise “${r.learned}” next time` : 'Posted'),
    onDone: () => { setAssigning(null); setInvoiceText(''); },
  });
  const explain = useAction((lineId: number) => post(`/reconcile/lines/${lineId}/explain`));

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading height={480} />;
  const { statement, lines } = data;
  const posted = lines.filter((l: any) => ['auto_posted', 'confirmed'].includes(l.status));
  const automatic = lines.filter((l: any) => l.status === 'auto_posted');
  const pending = lines.filter((l: any) => ['suggested', 'unmatched'].includes(l.status));
  const value = posted.reduce((sum: number, l: any) => sum + l.amount, 0);
  const rate = lines.length ? Math.round((automatic.length / lines.length) * 100) : 0;
  const order = { suggested: 0, unmatched: 1, confirmed: 2, auto_posted: 3, ignored: 4 } as Record<string, number>;
  const sorted = [...lines].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <>
      <PageHead title="Statement matched" actions={<Link className="btn" to="/reconcile">All statements</Link>}>
        <span className="mono small">{statement.filename}</span>
      </PageHead>
      <div className="grid four" style={{ marginBottom: 14 }}>
        <Stat label="Posted automatically" value={`${automatic.length} of ${lines.length}`} foot={`${rate}% without a person`} />
        <Stat label="Money posted" value={money(value)} foot={`${posted.length} lines`} />
        <Stat label="Need a look" value={pending.length} foot="Keel explains its guess" alert={pending.length > 0} />
        <Stat label="Time saved" value={`${lines.length * 3} min`} foot="At three minutes a line by hand" />
      </div>

      <div className="card">
        {sorted.map((l: any) => {
          const top = l.candidates[0];
          const open = ['suggested', 'unmatched'].includes(l.status);
          return (
            <div className="bank-line" key={l.id}>
              <div className="small">{date(l.txn_date)}</div>
              <div><div className="mono small">{l.description}</div><div className="mono strong">{money(l.amount)}</div></div>
              <div>
                <Status value={l.status} />
                {l.confidence != null && <div className="confidence" title={`${Math.round(l.confidence * 100)}% confident`}><div style={{ width: `${l.confidence * 100}%` }} /></div>}
              </div>
              <div className="small">
                {top && <div className="strong">{top.customerName}</div>}
                <div className="muted">{l.reason}</div>
                {top && open && (
                  <div className="tiny mono mt-4">
                    {top.allocations.map((a: any) => `${a.invoiceNumber}: ${money(a.amount)}`).join(' · ')}
                    {top.tdsAmount > 0 ? ` · TDS ${money(top.tdsAmount)}` : ''}
                  </div>
                )}
                {l.ai_note && <div className="callout mt-8 small"><Sparkles size={12} color="var(--magenta)" /> {l.ai_note}</div>}
                {l.payment_number && <div className="tiny mono mt-4">{l.payment_number}</div>}
              </div>
              <div className="col gap-4 no-print" style={{ minWidth: 110 }}>
                {l.status === 'suggested' && <Button size="small" variant="primary" onClick={() => confirm.mutate({ id: l.id, candidate: 0 })}>Accept</Button>}
                {open && <Button size="small" onClick={() => setAssigning(l)}>Match by hand</Button>}
                {l.status === 'suggested' && me?.ai.enabled && !l.ai_note && <Button size="small" variant="ghost" onClick={() => explain.mutate(l.id)} loading={explain.isPending}>Ask Gemini</Button>}
                {open && <Button size="small" variant="ghost" onClick={() => ignore.mutate(l.id)}>Ignore</Button>}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!assigning} onClose={() => setAssigning(null)} title={assigning ? `Match ${money(assigning.amount)}` : ''}>
        <p className="mono small">{assigning?.description}</p>
        <Field label="Find the invoice"><input className="input" value={invoiceText} onChange={(e) => setInvoiceText(e.target.value)} placeholder="Invoice number or customer" /></Field>
        <div className="col gap-4 mt-8">
          {results.data?.rows.map((r: any) => (
            <button key={r.id} className="btn" style={{ justifyContent: 'space-between' }} onClick={() => assign.mutate(r.id)}>
              <span className="truncate">{r.number}, {r.customer_name}</span><span className="mono">{money(r.total - r.amount_paid)}</span>
            </button>
          ))}
        </div>
        <p className="small muted mt-8">Keel remembers this payer's name, so next time it matches by itself.</p>
      </Dialog>
    </>
  );
}
