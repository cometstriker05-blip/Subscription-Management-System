import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeIndianRupee, CalendarClock, FileText, Handshake, Landmark, LayoutDashboard, LogOut,
  Mail, Package, Receipt, Repeat2, Search, ShieldCheck, Ship, Sparkles, Users, Waves,
} from 'lucide-react';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, latency, post, streamPost } from './lib/api';
import { addDays, compact, date, shortDate } from './lib/format';
import { Button, Dialog, Field, Loading, useGet, useToast } from './ui';

export interface Me {
  user: { id: number; name: string; role: 'admin' | 'staff' | 'customer'; customerId: number | null; email: string } | null;
  today: string;
  clockMode: 'simulated' | 'live';
  autoConfirm: boolean;
  company: any;
  ai: { enabled: boolean; model: string };
}

export const useMe = () => useQuery<Me>({ queryKey: ['me'], queryFn: () => api('/auth/me') });

export const KeelMark = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="7" fill="#b4127a" />
    <path d="M6 12h20l-4 9a4 4 0 0 1-3.6 2.4h-4.8A4 4 0 0 1 10 21z" fill="#fff" />
    <path d="M16 5v7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

const NAV = [
  { group: 'Today', items: [['/', 'Bridge', LayoutDashboard], ['/billing', 'Billing day', Waves]] },
  { group: 'Sell', items: [['/subscriptions', 'Subscriptions', Repeat2], ['/customers', 'Customers', Users], ['/renewals', 'Renewals', CalendarClock]] },
  { group: 'Bill and collect', items: [['/invoices', 'Invoices', FileText], ['/payments', 'Payments', Receipt], ['/reconcile', 'Bank matching', Landmark], ['/collections', 'Collections', Handshake]] },
  { group: 'Know', items: [['/revenue', 'Revenue', BadgeIndianRupee], ['/integrity', 'Proof', ShieldCheck], ['/outbox', 'Outbox', Mail]] },
  { group: 'Set up', items: [['/catalog', 'Catalog', Package]] },
] as const;

function Speed() {
  const ms = useSyncExternalStore(latency.subscribe, latency.get);
  if (ms === null) return null;
  return <span className={`speed ${ms > 2000 ? 'slow' : ''}`} title="How long the last page's data took to arrive"><i />{ms} ms</span>;
}

function GlobalSearch() {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 180);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const results = useGet<{ results: any[] }>(term.length >= 2 ? `/search?q=${encodeURIComponent(term)}` : null);
  return (
    <div className="search" ref={box}>
      <Search size={15} />
      <input value={text} placeholder="Find a customer, subscription or invoice" aria-label="Search"
        onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && term.length >= 2 && results.data && (
        <div className="search-results">
          {results.data.results.length === 0 && <div className="muted small" style={{ padding: 12 }}>Nothing matches “{term}”</div>}
          {results.data.results.map((r) => (
            <a key={`${r.kind}${r.id}`} href={r.href} onClick={(e) => { e.preventDefault(); setOpen(false); setText(''); navigate(r.href); }}>
              <span className="truncate"><span className="strong">{r.label}</span> <span className="muted small">{r.detail}</span></span>
              <span className="badge plain">{r.kind}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const FEED_LABEL: Record<string, string> = { billing: 'Billed', renewal: 'Renewal', closed: 'Closed', activated: 'Live', quote: 'Quote', dunning: 'Reminder', payment: 'Cash in', held: 'Waiting' };

/** Moves the business clock. Each day crossed runs the same code production would run. */
function TimeMachine({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: me } = useMe();
  const clock = useGet<any>(open ? '/clock' : null);
  const [target, setTarget] = useState('');
  const [hold, setHold] = useState(true);
  const [running, setRunning] = useState(false);
  const [day, setDay] = useState('');
  const [feed, setFeed] = useState<any[]>([]);
  const [billed, setBilled] = useState(0);
  const [cash, setCash] = useState(0);
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (open && clock.data?.nextBillingDay) setTarget(clock.data.nextBillingDay.date);
  }, [open, clock.data]);

  const run = async (to: string, holdBilling: boolean) => {
    setRunning(true);
    setFeed([]);
    setBilled(0);
    setCash(0);
    try {
      await streamPost('/clock/advance', { to, holdBilling }, (event, data) => {
        if (event === 'feed') {
          if (data.kind === 'day') setDay(data.date);
          else {
            setFeed((list) => [data, ...list].slice(0, 200));
            if (data.kind === 'billing') setBilled((b) => b + (data.amount ?? 0));
            if (data.kind === 'payment') setCash((c) => c + (data.amount ?? 0));
          }
        }
        if (event === 'failed') toast(data.message, 'bad');
      });
      await client.invalidateQueries();
      if (holdBilling) {
        onClose();
        navigate('/billing');
      }
    } catch (err: any) {
      toast(err.message, 'bad');
    } finally {
      setRunning(false);
    }
  };

  const today = me?.today ?? '';
  const quick = [
    ['Tomorrow', addDays(today, 1)],
    ['1 week', addDays(today, 7)],
    ['1 month', addDays(today, 30)],
    ['3 months', addDays(today, 91)],
  ];

  return (
    <Dialog open={open} onClose={() => !running && onClose()} title="Time machine" wide
      footer={<Button variant="primary" loading={running} disabled={!target || target <= today} onClick={() => run(target, hold)}>{running ? `Running ${day ? shortDate(day) : ''}` : `Go to ${target ? date(target) : '…'}`}</Button>}>
      <p className="muted">Move Brightloop through time. Every day you cross runs real activations, renewals, billing, reminders and simulated customer payments. No day is ever skipped.</p>
      <div className="row wrap mt-12">
        {clock.data?.nextBillingDay && (
          <Button variant="dark" disabled={running} onClick={() => { setTarget(clock.data.nextBillingDay.date); setHold(true); }}>
            <Waves size={15} /> Next billing day, {shortDate(clock.data.nextBillingDay.date)} ({clock.data.nextBillingDay.count.toLocaleString('en-IN')} due)
          </Button>
        )}
        {quick.map(([label, value]) => <Button key={label} disabled={running} onClick={() => { setTarget(value); setHold(false); }}>{label}</Button>)}
      </div>
      <div className="form-grid mt-12">
        <Field label="Go to date"><input className="input" type="date" value={target} min={addDays(today, 1)} onChange={(e) => setTarget(e.target.value)} disabled={running} /></Field>
        <label className="check" style={{ alignSelf: 'end', paddingBottom: 6 }}>
          <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} disabled={running} />
          <span>Stop before billing on the last day<small>So you can rehearse it first</small></span>
        </label>
      </div>
      {(running || feed.length > 0) && (
        <>
          <div className="grid three mt-12">
            <div className="stat"><div className="label">Date</div><div className="value">{day ? shortDate(day) : '…'}</div></div>
            <div className="stat"><div className="label">Billed</div><div className="value">{compact(billed)}</div></div>
            <div className="stat"><div className="label">Cash in</div><div className="value">{compact(cash)}</div></div>
          </div>
          <div className="card mt-12" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {feed.map((f, i) => (
              <div key={i} className="row small" style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)' }}>
                <span className="mono muted" style={{ width: 60 }}>{shortDate(f.date)}</span>
                <span className="badge plain">{FEED_LABEL[f.kind] ?? f.kind}</span>
                <span>{f.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}

const QUESTIONS = ['How much recurring revenue do we have?', 'Who owes us the most?', 'What came in this month?', 'Which renewals are coming up?', 'Which plan earns the most?'];

function AskKeel({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setText('');
    setBusy(true);
    setLog((l) => [...l, { role: 'user', text: question }]);
    try {
      const reply = await post('/ask', { question });
      setLog((l) => [...l, { role: 'keel', ...reply }]);
    } catch (err: any) {
      setLog((l) => [...l, { role: 'keel', answer: err.message, receipts: [] }]);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };

  return (
    <aside className="drawer" aria-label="Ask Keel">
      <div className="drawer-head">
        <h2 className="row gap-6"><Sparkles size={16} color="var(--magenta)" /> Ask Keel</h2>
        <Button variant="ghost" size="small" onClick={onClose}>Close</Button>
      </div>
      <div className="drawer-body">
        {log.length === 0 && (
          <>
            <p className="muted">Ask in plain words. Every answer comes from Keel's own books, and every figure links to the records behind it.</p>
            <div className="col gap-6 mt-12">
              {QUESTIONS.map((q) => <Button key={q} className="block" onClick={() => ask(q)} style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}>{q}</Button>)}
            </div>
          </>
        )}
        {log.map((m, i) => m.role === 'user' ? (
          <div key={i} className="strong mt-12">{m.text}</div>
        ) : (
          <div key={i} className="card water pad mt-8">
            <div>{m.answer}</div>
            {m.receipts?.length > 0 && (
              <div className="col gap-4 mt-8">
                {m.receipts.map((r: any, j: number) => (
                  <a key={j} href={r.href} className="row between small" onClick={(e) => { e.preventDefault(); navigate(r.href); }}>
                    <span className="link" style={{ color: 'var(--sea)' }}>{r.label}</span><span className="mono">{r.value}</span>
                  </a>
                ))}
              </div>
            )}
            <div className="tiny muted mt-8">{m.mode === 'gemini' ? 'Answered by Gemini from Keel’s tools' : 'Answered from Keel’s rules, no AI needed'}</div>
          </div>
        ))}
        {busy && <div className="skeleton mt-12" style={{ height: 64 }} />}
      </div>
      <form onSubmit={submit} className="row" style={{ padding: 12, borderTop: '1px solid var(--line)' }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your numbers" aria-label="Your question" />
        <Button variant="primary" type="submit" disabled={busy}>Ask</Button>
      </form>
    </aside>
  );
}

const useLogout = () => {
  const client = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await post('/auth/logout');
    client.clear();
    navigate('/login');
  };
};

export function AppShell() {
  const { data: me } = useMe();
  const [machine, setMachine] = useState(false);
  const [ask, setAsk] = useState(false);
  const logout = useLogout();
  if (!me?.user) return null;
  const simulated = me.clockMode === 'simulated';
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <Link to="/" className="brand"><KeelMark /><div><strong>Keel</strong><small>for {me.company.name}</small></div></Link>
        {NAV.map((section) => (
          <div key={section.group}>
            <div className="rail-group">{section.group}</div>
            {section.items.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `item ${isActive ? 'active' : ''}`}>
                <Icon size={16} /> {label}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="rail-foot">
          <div className="row between">
            <div><div className="who">{me.user.name}</div><div className="role">{me.user.role}</div></div>
            <button className="btn ghost small" style={{ color: '#cfe0e9' }} onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={15} /></button>
          </div>
        </div>
      </nav>
      <div style={{ minWidth: 0 }}>
        <header className="topbar no-print">
          <GlobalSearch />
          <div className="grow" />
          <Speed />
          <Button size="small" onClick={() => setAsk(true)}><Sparkles size={14} color="var(--magenta)" /> Ask Keel</Button>
          {me.user.role === 'admin' && simulated ? (
            <button className="clock" onClick={() => setMachine(true)} title="Open the time machine">
              <Ship size={14} color="var(--magenta)" /> {date(me.today)} <span className="tag">Time machine</span>
            </button>
          ) : (
            <span className="clock" style={{ cursor: 'default' }}>{date(me.today)}</span>
          )}
        </header>
        <main className="main">
          <Suspense fallback={<Loading height={320} />}><Outlet /></Suspense>
        </main>
      </div>
      {me.user.role === 'admin' && <TimeMachine open={machine} onClose={() => setMachine(false)} />}
      {ask && <AskKeel onClose={() => setAsk(false)} />}
    </div>
  );
}

export function PortalShell() {
  const { data: me } = useMe();
  const logout = useLogout();
  if (!me?.user) return null;
  return (
    <div>
      <header className="portal-top no-print">
        <Link to="/portal" className="row"><KeelMark size={24} /><strong>{me.company.name}</strong><span className="muted small" style={{ color: '#9dbccb' }}>Customer portal</span></Link>
        <nav aria-label="Portal">
          <NavLink to="/portal" end>Overview</NavLink>
          <NavLink to="/portal/plans">Plans</NavLink>
          <NavLink to="/portal/profile">Company details</NavLink>
        </nav>
        <div className="row small">
          <span>{me.user.name}</span>
          <button className="btn ghost small" style={{ color: '#cfe0e9' }} onClick={logout}>Sign out</button>
        </div>
      </header>
      <main className="portal-main">
        <Suspense fallback={<Loading height={320} />}><Outlet /></Suspense>
      </main>
    </div>
  );
}
