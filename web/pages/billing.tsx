import { AlertTriangle, CheckCircle2, Info, OctagonX, Play, ShieldAlert, Telescope, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, post, streamPost } from '../lib/api';
import { date, money, number } from '../lib/format';
import { useMe } from '../shell';
import { Button, Empty, Status, Table, useAction, useGet, useTitle, useToast } from '../ui';

const SEVERITY = {
  blocker: { icon: OctagonX, tone: 'bad', label: 'Blocker' },
  warning: { icon: AlertTriangle, tone: 'warn', label: 'Check this' },
  info: { icon: Info, tone: 'sea', label: 'Good to know' },
} as const;

export default function Billing() {
  useTitle('Billing day');
  const { data: me } = useMe();
  const [params] = useSearchParams();
  const asOf = params.get('date') ?? me?.today ?? '';
  const isToday = asOf === me?.today;
  const [plan, setPlan] = useState<any>(null);
  const [rehearsing, setRehearsing] = useState(false);
  const [progress, setProgress] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [chaos, setChaos] = useState<any>(null);
  const [chaosRunning, setChaosRunning] = useState(false);
  const [wall, setWall] = useState<any>(null);
  const [severity, setSeverity] = useState<string>('all');
  const runs = useGet<any[]>('/billing/runs');
  const toast = useToast();

  const rehearse = async () => {
    setRehearsing(true);
    try {
      setPlan(await api(`/billing/rehearse?date=${asOf}`));
    } catch (err: any) {
      toast(err.message, 'bad');
    } finally {
      setRehearsing(false);
    }
  };

  const run = async () => {
    setResult(null);
    setProgress({ done: 0, expected: plan?.subscriptions ?? 1, invoices: 0, total: 0 });
    try {
      await streamPost('/billing/run', {}, (event, data) => {
        if (event === 'progress') setProgress(data);
        if (event === 'done') setResult(data);
      });
      runs.refetch();
    } catch (err: any) {
      toast(err.message, 'bad');
    } finally {
      setProgress(null);
    }
  };

  const confirmAll = useAction(() => post('/invoices/confirm-all', { runId: result?.runId }), {
    success: (r) => `${number(r.confirmed)} invoices confirmed and numbered`,
    onDone: () => setResult((x: any) => ({ ...x, confirmed: true })),
  });

  const unleash = async () => {
    setChaosRunning(true);
    setChaos(null);
    try {
      await streamPost('/integrity/chaos', {}, (event, data) => {
        if (event === 'done') setChaos(data);
        if (event === 'failed') toast(data.message, 'bad');
      });
      runs.refetch();
    } catch (err: any) {
      toast(err.message, 'bad');
    } finally {
      setChaosRunning(false);
    }
  };

  const tryDoubleBill = useAction(() => post('/integrity/double-bill'), { onDone: setWall });

  const findings = plan?.findings.filter((f: any) => severity === 'all' || f.severity === severity) ?? [];
  const blockers = plan?.counts.blocker ?? 0;
  const percent = progress ? Math.min(100, (progress.done / Math.max(1, progress.expected)) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Billing day, {date(asOf)}</h1>
          <p>See every invoice before it exists. The rehearsal runs the real billing engine and writes nothing, so what you see is what will be billed, to the paisa.</p>
        </div>
      </div>

      <div className="hero-band">
        <div className="row between wrap gap-20">
          <div>
            <div className="small muted">Step 1</div>
            <h2 style={{ color: '#fff', fontSize: 19 }}>Rehearse billing</h2>
            <p className="muted small" style={{ maxWidth: '52ch' }}>Finds what is due on {date(asOf)}, computes every invoice, and checks each one for problems.</p>
          </div>
          <Button variant="primary" size="big" onClick={rehearse} loading={rehearsing}><Telescope size={18} /> {rehearsing ? 'Rehearsing' : plan ? 'Rehearse again' : 'Rehearse billing day'}</Button>
        </div>

        {plan && (
          <div className="grid four mt-16" style={{ borderTop: '1px solid rgba(255,255,255,.15)', paddingTop: 14 }}>
            <div><div className="small muted">Invoices</div><div className="figure">{number(plan.invoices)}</div></div>
            <div><div className="small muted">Will be billed</div><div className="figure">{money(plan.total)}</div></div>
            <div><div className="small muted">Discounts applied</div><div className="figure">{money(plan.discount)}</div></div>
            <div><div className="small muted">Tax</div><div className="figure">{money(plan.tax)}</div></div>
          </div>
        )}
        {plan && <div className="tiny muted mt-12 mono">Rehearsed {number(plan.subscriptions)} subscriptions in {plan.ms} ms. Fingerprint {plan.fingerprint}</div>}
      </div>

      {plan && plan.invoices === 0 && (
        <div className="card mt-16"><Empty title="Nothing is due on this day">Open the time machine and jump to the next billing day.</Empty></div>
      )}

      {plan && plan.invoices > 0 && (
        <div className="grid split mt-16">
          <div className="card">
            <div className="card-head">
              <h2>What the rehearsal found</h2>
              <div className="row gap-6">
                {(['all', 'blocker', 'warning', 'info'] as const).map((s) => (
                  <button key={s} className={`btn small ${severity === s ? 'dark' : ''}`} onClick={() => setSeverity(s)}>
                    {s === 'all' ? `All ${plan.findings.length}` : `${SEVERITY[s].label} ${plan.counts[s]}`}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {findings.length === 0 && <Empty title="Nothing to flag">Every invoice in this view looks right.</Empty>}
              {findings.slice(0, 100).map((f: any, i: number) => {
                const S = SEVERITY[f.severity as keyof typeof SEVERITY];
                return (
                  <Link key={i} to={`/subscriptions/${f.subscriptionId}`} className="row top" style={{ padding: '9px 14px', borderBottom: '1px solid var(--line)' }}>
                    <S.icon size={16} color={`var(--${S.tone === 'sea' ? 'sea' : S.tone})`} style={{ marginTop: 2, flex: 'none' }} />
                    <span className="grow"><span className="strong">{f.customer}</span> <span className="muted small mono">{f.subscription}</span><br /><span className="small">{f.message}</span></span>
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>By plan</h2></div>
            <Table
              columns={[
                { label: 'Plan', render: (r: any) => r.plan },
                { label: 'Invoices', num: true, render: (r: any) => number(r.invoices) },
                { label: 'Total', num: true, render: (r: any) => money(r.total) },
              ]}
              rows={plan.byPlan}
            />
          </div>
        </div>
      )}

      {plan && plan.invoices > 0 && isToday && (
        <div className="card mt-16">
          <div className="card-head">
            <div><h2>Step 2: Run billing for real</h2><div className="small muted">Creates draft invoices. Run it as many times as you like; nothing can bill twice.</div></div>
            <Button variant="dark" onClick={run} loading={!!progress} disabled={blockers > 0}><Play size={15} /> {blockers > 0 ? `Fix ${blockers} blockers first` : `Bill ${number(plan.invoices)} invoices`}</Button>
          </div>
          {(progress || result) && (
            <div className="card-body">
              {progress && (
                <>
                  <div className="row between small"><span>{number(progress.done)} of {number(progress.expected)} subscriptions</span><span className="mono">{money(progress.total)}</span></div>
                  <div className="progress mt-4"><div style={{ width: `${percent}%` }} /></div>
                </>
              )}
              {result && (
                <div className="col">
                  <div className={`callout ${result.matchedRehearsal ? 'good' : 'warn'}`}>
                    <div className="row gap-6 strong"><CheckCircle2 size={16} /> {result.matchedRehearsal ? 'The real run matched the rehearsal exactly' : 'The run differs from the rehearsal, because something changed in between'}</div>
                    <div className="mono small mt-4">Rehearsed {money(result.rehearsal.total)} · Billed {money(result.total)} · Difference {money(result.total - result.rehearsal.total)}</div>
                    <div className="mono tiny mt-4">Fingerprint {result.rehearsal.fingerprint} = {result.fingerprint}</div>
                  </div>
                  <div className="row wrap">
                    <span>{number(result.invoices)} draft invoices raised.</span>
                    {!result.confirmed && result.invoices > 0 && <Button variant="primary" onClick={() => confirmAll.mutate()} loading={confirmAll.isPending}>Step 3: Confirm and number all {number(result.invoices)}</Button>}
                    <Link className="link" to={`/invoices?runId=${result.runId}`}>See this run's invoices</Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {plan && !isToday && <div className="callout mt-16">This is a look ahead. Billing can only run on the current business day, so use the time machine to get there.</div>}

      {me?.user?.role === 'admin' && (
        <div className="card mt-16">
          <div className="card-head">
            <div><h2 className="row gap-6"><ShieldAlert size={16} color="var(--magenta)" /> Try to break it</h2><div className="small muted">The brief says nothing may be billed twice or skipped. Don't take our word for it.</div></div>
          </div>
          <div className="card-body grid two">
            <div className="col">
              <h3>Attack the database directly</h3>
              <p className="small muted">Skips all application code and tries to insert a duplicate of the last billed period.</p>
              <div><Button onClick={() => tryDoubleBill.mutate()} loading={tryDoubleBill.isPending}>Try to bill a period twice</Button></div>
              {wall && (
                <div className="callout good small">
                  <div className="strong">Postgres refused. Nothing was written.</div>
                  <div className="mono tiny mt-4">{wall.subscription} · {wall.periodStart} to {wall.periodEnd}</div>
                  <div className="mono tiny">constraint {wall.constraint}, SQLSTATE {wall.sqlState}</div>
                </div>
              )}
            </div>
            <div className="col">
              <h3>Chaos run</h3>
              <p className="small muted">Three runs race each other over today's due invoices while 12% of workers crash mid-write. Then rogue writers attack every result.</p>
              <div><Button variant="danger" onClick={unleash} loading={chaosRunning} disabled={!isToday}><Zap size={15} /> {chaosRunning ? 'Causing chaos' : 'Unleash chaos'}</Button></div>
              {chaos && (
                <div className={`callout small ${chaos.integrityPassed && chaos.matchedRehearsal ? 'good' : 'bad'}`}>
                  <div className="strong">{number(chaos.created)} of {number(chaos.expected)} invoices, none duplicated, none lost</div>
                  <div className="mono tiny mt-4">{chaos.runs} racing runs · {chaos.faultsInjected} crashes survived · {chaos.rogueBlocked} of {chaos.rogueAttempts} rogue writes blocked</div>
                  <div className="mono tiny">{money(chaos.rehearsedTotal)} rehearsed · {money(chaos.actualTotal)} billed · all {chaos.checks.length} proofs {chaos.integrityPassed ? 'hold' : 'FAILED'}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card mt-16">
        <div className="card-head"><h2>Billing runs</h2></div>
        <Table
          columns={[
            { label: 'Run', render: (r: any) => <span className="mono">#{r.id}</span> },
            { label: 'Date', render: (r: any) => date(r.run_date) },
            { label: 'Kind', render: (r: any) => r.kind },
            { label: 'By', render: (r: any) => r.actor },
            { label: 'Status', render: (r: any) => <Status value={r.status} /> },
            { label: 'Invoices', num: true, render: (r: any) => number(r.invoices) },
            { label: 'Total', num: true, render: (r: any) => money(r.total) },
            { label: 'Matched rehearsal', render: (r: any) => (r.summary?.matchedRehearsal === undefined ? '—' : r.summary.matchedRehearsal ? 'Yes' : 'No') },
          ]}
          rows={(runs.data ?? []).filter((r: any) => r.invoices > 0 || r.kind === 'manual').slice(0, 10)}
          empty={<Empty title="No runs yet">Your first billing run appears here.</Empty>}
        />
      </div>
    </>
  );
}
