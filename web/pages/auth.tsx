import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, post } from '../lib/api';
import { INDIAN_STATES } from '../lib/format';
import { useMe } from '../shell';
import { Button, Field, useTitle } from '../ui';

const RULES: [string, (p: string) => boolean][] = [
  ['More than 8 characters', (p) => p.length > 8],
  ['An uppercase letter', (p) => /[A-Z]/.test(p)],
  ['A lowercase letter', (p) => /[a-z]/.test(p)],
  ['A special character', (p) => /[^A-Za-z0-9]/.test(p)],
];

function PasswordRules({ value }: { value: string }) {
  return (
    <ul className="small" style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
      {RULES.map(([label, test]) => (
        <li key={label} className="row gap-4" style={{ color: test(value) ? 'var(--good)' : 'var(--ink-3)' }}>
          <Check size={13} strokeWidth={test(value) ? 3 : 1.5} /> {label}
        </li>
      ))}
    </ul>
  );
}

const DEMO = [
  { label: 'Admin', detail: 'Meera, runs everything', email: 'admin@keel.demo', password: 'Keel@Admin2026' },
  { label: 'Staff', detail: 'Asha, day-to-day work', email: 'asha@keel.demo', password: 'Keel@Staff2026' },
  { label: 'Customer', detail: 'Rahul, Malabar Spices', email: 'owner@malabarspices.demo', password: 'Keel@Portal2026' },
];

export default function Auth({ mode }: { mode: 'login' | 'signup' | 'forgot' | 'reset' }) {
  useTitle({ login: 'Sign in', signup: 'Create your account', forgot: 'Forgot password', reset: 'Choose a new password' }[mode]);
  const { token } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useMe();
  const [form, setForm] = useState({ name: '', company: '', email: '', password: '', stateCode: '32' });
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState('');
  const [done, setDone] = useState(false);
  const set = (key: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  useEffect(() => {
    if (me?.user && (mode === 'login' || mode === 'signup')) navigate(me.user.role === 'customer' ? '/portal' : '/', { replace: true });
  }, [me, mode, navigate]);

  const inbox = useQuery({
    queryKey: ['inbox', sent],
    queryFn: () => api(`/auth/demo-inbox?email=${encodeURIComponent(sent)}`),
    enabled: !!sent && sent.endsWith('.demo'),
  });

  const signInAs = async (email: string, password: string) => {
    setBusy(true);
    setError('');
    try {
      await post('/auth/login', { email, password });
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFields({});
    try {
      if (mode === 'login') {
        await post('/auth/login', { email: form.email, password: form.password });
        await client.invalidateQueries({ queryKey: ['me'] });
      } else if (mode === 'signup') {
        const state = INDIAN_STATES.find(([code]) => code === form.stateCode);
        await post('/auth/signup', { ...form, stateName: state?.[1] });
        await client.invalidateQueries({ queryKey: ['me'] });
      } else if (mode === 'forgot') {
        await post('/auth/forgot', { email: form.email });
        setSent(form.email.toLowerCase());
      } else {
        await post('/auth/reset', { token, password: form.password });
        setDone(true);
      }
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message);
      setFields(apiErr.fields ?? {});
    } finally {
      setBusy(false);
    }
  };

  const resetLink = inbox.data?.mails?.[0]?.body?.match(/\/reset\/[\w-]+/)?.[0];

  return (
    <div className="auth">
      <section className="auth-side">
        <div className="auth-top">
          <div className="auth-word">Keel</div>
          <h1>A billing day you can rehearse.</h1>
        </div>
        <div className="auth-line" />
        <div className="auth-bottom">
          <p>Keel runs Brightloop's plans, subscriptions, invoices and revenue in one place. See billing day before it happens, prove nothing was billed twice, and explain every rupee.</p>
        </div>
      </section>

      <section className="auth-form">
        <h1>{{ login: 'Sign in', signup: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' }[mode]}</h1>

        {mode === 'forgot' && sent ? (
          <div className="col mt-16">
            <div className="callout good">If that email has an account, a reset link is on its way.</div>
            {resetLink && (
              <div className="callout">
                <div className="strong">Demo inbox</div>
                <div className="small muted">This address is a demo one, so the email landed here.</div>
                <Link className="link" to={resetLink}>Open the reset link</Link>
              </div>
            )}
            <Link className="link" to="/login">Back to sign in</Link>
          </div>
        ) : done ? (
          <div className="col mt-16">
            <div className="callout good">Your password has changed. Every device was signed out.</div>
            <Link className="btn primary" to="/login">Sign in</Link>
          </div>
        ) : (
          <form className="col mt-16" onSubmit={submit} noValidate>
            {mode === 'signup' && (
              <>
                <Field label="Your name" error={fields.name}><input className="input" value={form.name} onChange={set('name')} autoComplete="name" /></Field>
                <Field label="Company name" error={fields.company}><input className="input" value={form.company} onChange={set('company')} autoComplete="organization" /></Field>
                <Field label="State" hint="Decides how GST is split on your invoices">
                  <select className="input" value={form.stateCode} onChange={set('stateCode')}>
                    {INDIAN_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                </Field>
              </>
            )}
            {mode !== 'reset' && (
              <Field label="Email" error={fields.email}><input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" /></Field>
            )}
            {mode !== 'forgot' && (
              <Field label={mode === 'reset' ? 'New password' : 'Password'} error={fields.password}>
                <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
                {mode !== 'login' && <PasswordRules value={form.password} />}
              </Field>
            )}
            {error && !Object.keys(fields).length && <div className="callout bad" role="alert">{error}</div>}
            <Button variant="primary" type="submit" className="block" loading={busy}>
              {{ login: 'Sign in', signup: 'Create account', forgot: 'Send reset link', reset: 'Save new password' }[mode]}
            </Button>
          </form>
        )}

        {mode === 'login' && (
          <>
            <div className="row between small mt-12">
              <Link className="link" to="/forgot">Forgot your password?</Link>
              <Link className="link" to="/signup">New here? Create an account</Link>
            </div>
            <div className="mt-20">
              <div className="small strong">Try a role</div>
              <div className="grid three mt-8">
                {DEMO.map((d) => (
                  <button key={d.label} className="role-pick" onClick={() => signInAs(d.email, d.password)}>
                    <div className="strong">{d.label}</div>
                    <div className="tiny muted">{d.detail}</div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {mode === 'signup' && <div className="small mt-12">Have an account? <Link className="link" to="/login">Sign in</Link></div>}
        {mode === 'forgot' && !sent && <div className="small mt-12"><Link className="link" to="/login">Back to sign in</Link></div>}
      </section>
    </div>
  );
}
