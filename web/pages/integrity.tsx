import { CheckCircle2, ChevronDown, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { number } from '../lib/format';
import { Button, Empty, Loading, PageHead, Pager, SearchBox, Stat, Table, useGet, useListParams, useTitle, useToast } from '../ui';

export default function Integrity() {
  useTitle('Proof');
  const checks = useGet<any>('/integrity/checks');
  const perf = useGet<any>('/integrity/performance');
  const list = useListParams();
  const audit = useGet<any>(`/integrity/audit${list.query}`, { keepPrevious: true });
  const [open, setOpen] = useState<string | null>(null);
  const [replay, setReplay] = useState<any>(null);
  const [replaying, setReplaying] = useState(false);
  const toast = useToast();

  const runReplay = async () => {
    setReplaying(true);
    try {
      setReplay(await api('/integrity/replay?limit=500000'));
    } catch (err: any) {
      toast(err.message, 'bad');
    } finally {
      setReplaying(false);
    }
  };

  const slowest = perf.data ? Math.max(...perf.data.results.map((r: any) => r.ms)) : 0;

  return (
    <>
      <PageHead title="Proof" actions={<><Button onClick={() => { checks.refetch(); perf.refetch(); }} loading={checks.isFetching}>Check again</Button><Link className="btn" to="/billing">Try to break it</Link></>}>
        Most systems promise their books are right. Keel asks the live data each question below, and the answer must be zero.
      </PageHead>

      {checks.data ? (
        <div className={`callout ${checks.data.passed ? 'good' : 'bad'}`} style={{ marginBottom: 14 }}>
          <span className="strong">{checks.data.checks.filter((c: any) => c.violations === 0).length} of {checks.data.checks.length} proofs hold</span>, checked across every record in {checks.data.ms} ms.
        </div>
      ) : <Loading height={44} />}

      <div className="grid split">
        <div className="card">
          <div className="card-head"><h2>Eleven promises</h2></div>
          {checks.data?.checks.map((c: any) => (
            <div className="proof" key={c.id}>
              {c.violations === 0 ? <CheckCircle2 size={18} color="var(--good)" /> : <XCircle size={18} color="var(--bad)" />}
              <div style={{ minWidth: 0 }}>
                <div className="strong">{c.title}</div>
                <div className="small muted">{c.promise}</div>
                {open === c.id && <pre>{c.sql}</pre>}
              </div>
              <div className="row gap-6">
                <span className="mono small">{number(c.violations)}</span>
                <button className="btn ghost small" aria-label={`Show the query for ${c.title}`} onClick={() => setOpen(open === c.id ? null : c.id)}><ChevronDown size={14} /></button>
              </div>
            </div>
          ))}
        </div>

        <div className="col">
          <div className="card pad col">
            <h2>Replay every invoice</h2>
            <p className="small muted">Each invoice keeps the exact inputs that made it. Replay recomputes them with the live engine and compares, to the paisa.</p>
            <div><Button variant="primary" onClick={runReplay} loading={replaying}>Replay all invoices</Button></div>
            {replay && (
              <div className={`callout small ${replay.mismatchCount === 0 ? 'good' : 'bad'}`}>
                <span className="strong">{number(replay.replayed)} invoices replayed in {replay.ms} ms.</span> {replay.mismatchCount === 0 ? 'All match.' : `${replay.mismatchCount} differ.`}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div><h2>Speed</h2><div className="small muted">The brief asks for under two seconds. Measured now, on this data.</div></div></div>
            {perf.data ? (
              <>
                <div className="grid two" style={{ padding: 12, gap: 8 }}>
                  <Stat label="Subscriptions" value={number(perf.data.volume.subscriptions)} />
                  <Stat label="Invoices" value={number(perf.data.volume.invoices)} />
                </div>
                <Table
                  columns={[
                    { label: 'Query', render: (r: any) => r.name },
                    { label: 'Time', num: true, render: (r: any) => `${r.ms} ms` },
                  ]}
                  rows={perf.data.results}
                />
                <div className="small muted" style={{ padding: '8px 14px' }}>Slowest: {slowest} ms, which is {Math.round(2000 / Math.max(slowest, 1))}× faster than the limit.</div>
              </>
            ) : <Loading />}
          </div>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-head">
          <div><h2>Audit trail</h2><div className="small muted">Append-only. Each row's hash covers the one before it, so editing history breaks the chain.</div></div>
          <SearchBox value={list.get('q')} onChange={(v) => list.set('q', v)} placeholder="Filter by action" />
        </div>
        <Table
          columns={[
            { label: 'When', render: (r: any) => <span className="small nowrap">{new Date(r.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span> },
            { label: 'Who', render: (r: any) => r.actor },
            { label: 'Action', render: (r: any) => <span className="mono small">{r.action}</span> },
            { label: 'Record', render: (r: any) => <span className="small">{r.entity} {r.entity_id ?? ''}</span> },
            { label: 'Hash', render: (r: any) => <span className="mono tiny muted">{r.hash.slice(0, 12)}</span> },
          ]}
          rows={audit.data?.rows ?? []}
          empty={<Empty title="Nothing recorded yet" />}
        />
        {audit.data && <Pager page={audit.data.page} pageSize={audit.data.pageSize} total={audit.data.total} onPage={(p) => list.set('page', String(p))} />}
      </div>
    </>
  );
}
