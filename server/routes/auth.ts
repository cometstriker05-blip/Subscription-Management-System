import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { one, q, tx } from '../db/pool.ts';
import { passwordProblems } from '../engine/index.ts';
import { aiStatus } from '../services/ai.ts';
import { appState, AppError, audit, conflict, invalid } from '../services/core.ts';
import { sendMail } from '../services/mail.ts';
import { hashPassword, verifyPassword } from '../services/passwords.ts';
import { adminOnly, actorOf, body, hashToken, SESSION_COOKIE, type Env } from './helpers.ts';

export const auth = new Hono<Env>();

const SESSION_DAYS = 14;
const secureCookie = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';

async function startSession(c: any, userId: number) {
  const token = randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [hashToken(token), userId]);
  await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secureCookie, path: '/', maxAge: SESSION_DAYS * 86400 });
}

// In-memory throttle. One instance is enough for this deployment.
const failures = new Map<string, { count: number; until: number }>();
function throttle(key: string) {
  const entry = failures.get(key);
  if (entry && entry.count >= 8 && entry.until > Date.now()) throw new AppError(429, 'Too many attempts. Try again in a minute', 'throttled');
}
function recordFailure(key: string) {
  const entry = failures.get(key);
  failures.set(key, { count: (entry && entry.until > Date.now() ? entry.count : 0) + 1, until: Date.now() + 60_000 });
}

const passwordField = z.string().superRefine((value, ctx) => {
  const problem = passwordProblems(value)[0];
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name'),
  company: z.string().trim().min(2, 'Tell us your company name'),
  email: z.string().trim().email('Use a valid email address'),
  password: passwordField,
  stateCode: z.string().length(2).optional(),
  stateName: z.string().optional(),
});

auth.post('/signup', async (c) => {
  const input = await body(c, signupSchema);
  const { today } = await appState();
  const user = await tx(async (client) => {
    const taken = await one(`SELECT 1 AS ok FROM users WHERE email = $1`, [input.email], client);
    if (taken) throw conflict('Email already in use. Sign in instead?');
    const seq = await one(`SELECT nextval(pg_get_serial_sequence('customers','id')) AS n`, [], client);
    await client.query(
      `INSERT INTO customers (id, code, name, email, state_code, state_name, segment, payment_term_id, created_on)
       VALUES ($1,$2,$3,$4,$5,$6,'small',2,$7)`,
      [seq!.n, `C${String(seq!.n).padStart(5, '0')}`, input.company, input.email, input.stateCode ?? null, input.stateName ?? null, today],
    );
    const created = await one(
      `INSERT INTO users (email, password_hash, name, role, customer_id) VALUES ($1,$2,$3,'customer',$4) RETURNING id`,
      [input.email, hashPassword(input.password), input.name, seq!.n],
      client,
    );
    await audit(input.name, 'user.signup', 'customer', seq!.n, { company: input.company }, client);
    return created!;
  });
  await startSession(c, user.id);
  return c.json({ ok: true }, 201);
});

auth.post('/login', async (c) => {
  const { email, password } = await body(c, z.object({ email: z.string().email('Use a valid email address'), password: z.string().min(1, 'Enter your password') }));
  const key = email.toLowerCase();
  throttle(key);
  const user = await one(`SELECT id, password_hash, active, role FROM users WHERE email = $1`, [email]);
  // Same message either way, so the form never reveals which emails have accounts.
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordFailure(key);
    throw new AppError(401, 'That email and password do not match', 'bad_credentials');
  }
  failures.delete(key);
  await startSession(c, user.id);
  return c.json({ ok: true, role: user.role });
});

auth.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await q(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

auth.get('/me', async (c) => {
  const state = await appState();
  const base = { today: state.today, clockMode: state.clockMode, autoConfirm: state.autoConfirm, company: state.company, ai: aiStatus() };
  const actor = c.get('actor');
  return c.json({ user: actor, ...base });
});

auth.post('/forgot', async (c) => {
  const { email } = await body(c, z.object({ email: z.string().email('Use a valid email address') }));
  const user = await one(`SELECT id, name, email FROM users WHERE email = $1 AND active`, [email]);
  if (user) {
    const { today, company } = await appState();
    const token = randomBytes(32).toString('base64url');
    await q(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [hashToken(token), user.id]);
    await sendMail({
      to: user.email,
      subject: `Reset your ${company.name} password`,
      body: `Hello ${user.name},\n\nUse this link within 30 minutes to choose a new password:\n\n${APP_URL}/reset/${token}\n\nIf you did not ask for this, ignore this email and nothing changes.`,
      kind: 'password_reset',
      onDate: today,
    });
  }
  // Always the same reply, so nobody can test which emails are registered.
  return c.json({ ok: true, message: 'If that email has an account, a reset link is on its way' });
});

auth.post('/reset', async (c) => {
  const { token, password } = await body(c, z.object({ token: z.string().min(10), password: passwordField }));
  await tx(async (client) => {
    const reset = await one(
      `SELECT user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashToken(token)],
      client,
    );
    if (!reset) throw invalid('This reset link has expired or been used. Ask for a new one');
    await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [reset.user_id, hashPassword(password)]);
    await client.query(`UPDATE password_resets SET used_at = now() WHERE token_hash = $1`, [hashToken(token)]);
    // A reset signs out every device, in case the old password leaked.
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [reset.user_id]);
    await audit('system', 'user.password_reset', 'user', reset.user_id, {}, client);
  });
  return c.json({ ok: true });
});

/** Lets a judge see a reset email without a real mailbox. Only for .demo addresses in simulation. */
auth.get('/demo-inbox', async (c) => {
  const state = await appState();
  const email = (c.req.query('email') ?? '').toLowerCase();
  if (state.clockMode !== 'simulated' || !email.endsWith('.demo')) return c.json({ mails: [] });
  const mails = await q(`SELECT id, subject, body, created_at FROM outbox WHERE lower(to_email) = $1 ORDER BY id DESC LIMIT 5`, [email]);
  return c.json({ mails });
});

export const team = new Hono<Env>();

team.get('/', adminOnly, async (c) => {
  return c.json(await q(`SELECT id, name, email, role, active, last_login_at, created_at FROM users WHERE role <> 'customer' ORDER BY role, name`));
});

// Only an admin can add staff. Public signup can only ever create a customer.
team.post('/', adminOnly, async (c) => {
  const input = await body(c, z.object({
    name: z.string().trim().min(2, 'Enter a name'),
    email: z.string().trim().email('Use a valid email address'),
    password: passwordField,
  }));
  const taken = await one(`SELECT 1 AS ok FROM users WHERE email = $1`, [input.email]);
  if (taken) throw conflict('Email already in use');
  const user = await one(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'staff') RETURNING id`,
    [input.email, hashPassword(input.password), input.name],
  );
  await audit(actorOf(c).name, 'user.add_staff', 'user', user!.id, { email: input.email });
  return c.json({ id: user!.id }, 201);
});

team.post('/:id/active', adminOnly, async (c) => {
  const { active } = await body(c, z.object({ active: z.boolean() }));
  const id = Number(c.req.param('id'));
  if (id === actorOf(c).id) throw conflict('You cannot switch off your own account');
  await q(`UPDATE users SET active = $2 WHERE id = $1 AND role = 'staff'`, [id, active]);
  if (!active) await q(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  await audit(actorOf(c).name, active ? 'user.enable' : 'user.disable', 'user', id);
  return c.json({ ok: true });
});
