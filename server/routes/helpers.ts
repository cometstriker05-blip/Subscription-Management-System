import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { one } from '../db/pool.ts';
import { AppError, type Actor } from '../services/core.ts';

export type Env = { Variables: { actor: Actor | null } };

export const SESSION_COOKIE = 'keel_session';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const loadActor: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  let actor: Actor | null = null;
  if (token) {
    const row = await one(
      `SELECT u.id, u.name, u.role, u.customer_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [hashToken(token)],
    );
    if (row) actor = { id: row.id, name: row.name, role: row.role, customerId: row.customer_id, email: row.email };
  }
  c.set('actor', actor);
  await next();
};

export const requireRole = (...roles: Actor['role'][]): MiddlewareHandler<Env> => async (c, next) => {
  const actor = c.get('actor');
  if (!actor) throw new AppError(401, 'Sign in to continue', 'unauthenticated');
  if (!roles.includes(actor.role)) throw new AppError(403, 'Your role does not allow this', 'forbidden');
  await next();
};

export const staffOnly = requireRole('admin', 'staff');
export const adminOnly = requireRole('admin');
export const customerOnly = requireRole('customer');

export const actorOf = (c: Context<Env>) => c.get('actor')!;

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw new AppError(400, 'Send a JSON body', 'bad_request');
  });
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) fields[issue.path.join('.') || 'form'] = issue.message;
  throw new AppError(422, Object.values(fields)[0] ?? 'Check the form', 'invalid', fields);
}

const MAX_ID = 9_000_000_000_000;
// Large enough for any contract, and small enough that quantity × price stays exact.
const MAX_MONEY = 10_000_000_000;
export const MAX_QUANTITY = 100_000;

export const idParam = (c: Context, name = 'id') => {
  const value = Number(c.req.param(name));
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ID) throw new AppError(400, 'Bad id', 'bad_request');
  return value;
};

/** True only for dates that exist on the calendar, so 2026-02-31 is refused. */
export function isRealDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const asked = (message: string) => ({ required_error: message, invalid_type_error: message });

export const date = z.string(asked('Choose a date')).refine(isRealDate, 'Use a real date, like 2026-11-01');
export const dbId = z.number(asked('Choose one')).int('Choose one').positive('Choose one').max(MAX_ID, 'Choose one');
export const money = z.number(asked('Enter an amount')).int('Enter an amount').min(0, 'Enter zero or more').max(MAX_MONEY, 'That amount is too large');
export const quantity = z.number(asked('Enter a quantity')).int('Use a whole number').min(1, 'Must be at least 1').max(MAX_QUANTITY, `At most ${MAX_QUANTITY.toLocaleString('en-IN')}`);
export const text = (max: number, message: string) => z.string(asked(message)).trim().min(2, message).max(max, `Keep it under ${max} characters`);
export const note = (max = 2000) => z.string().trim().max(max, `Keep it under ${max} characters`);
export const phone = z.string().trim().regex(/^\+?[\d\s-]{7,20}$/, 'That phone number does not look right');
export const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]$/;

const QUERY_LISTS: Record<string, string[]> = {
  segment: ['small', 'mid', 'enterprise'],
  method: ['upi', 'bank_transfer', 'card', 'cash', 'cheque', 'tds', 'gateway'],
  bucket: ['d1_30', 'd31_60', 'd61_90', 'd90_plus'],
  mode: ['manual', 'auto'],
  preset: ['month', 'quarter', 'year'],
  kind: ['invoice', 'quotation', 'dunning', 'renewal_reminder', 'password_reset'],
};
const SUBSCRIPTION_STATUS = ['draft', 'quotation', 'confirmed', 'active', 'paused', 'closed'];
const INVOICE_STATUS = ['draft', 'confirmed', 'paid', 'cancelled'];
const QUERY_DATES = ['from', 'to', 'date'];
const QUERY_NUMBERS = ['page', 'pageSize', 'limit', 'days', 'customerId', 'planId', 'subscriptionId', 'runId'];

/** Every query value is checked here, so a bad filter can never reach the database. */
export const validateQuery: MiddlewareHandler<Env> = async (c, next) => {
  const query = c.req.query();
  const refuse = (field: string, message: string) => new AppError(422, message, 'invalid', { [field]: message });
  for (const [key, value] of Object.entries(query)) {
    if (!value) continue;
    if (value.length > 200) throw refuse(key, 'That filter is too long');
    if (QUERY_DATES.includes(key) && !isRealDate(value)) throw refuse(key, 'Use a real date, like 2026-11-01');
    if (QUERY_NUMBERS.includes(key)) {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_ID) throw refuse(key, 'That filter must be a positive whole number');
    }
    if (QUERY_LISTS[key] && !QUERY_LISTS[key].includes(value)) throw refuse(key, `Unknown ${key}`);
    if (key === 'stateCode' && !/^\d{2}$/.test(value)) throw refuse(key, 'Unknown state');
    if (key === 'status') {
      const allowed = c.req.path.includes('/invoices') ? INVOICE_STATUS : SUBSCRIPTION_STATUS;
      if (!allowed.includes(value)) throw refuse(key, 'Unknown status');
    }
  }
  await next();
};
