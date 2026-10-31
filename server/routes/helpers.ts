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

export const idParam = (c: Context, name = 'id') => {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value <= 0) throw new AppError(400, 'Bad id', 'bad_request');
  return value;
};

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-01');
export const money = z.number().int('Amounts are whole paise').min(0);
