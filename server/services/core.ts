import { one, pool, q, type Db } from '../db/pool.ts';

export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error', public fields?: Record<string, string>) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, `${what} not found`, 'not_found');
export const conflict = (message: string) => new AppError(409, message, 'conflict');
export const invalid = (message: string, fields?: Record<string, string>) => new AppError(422, message, 'invalid', fields);

export interface Company {
  name: string;
  legalName: string;
  gstin: string;
  stateCode: string;
  stateName: string;
  address: string;
  email: string;
  invoicePrefix: string;
}

export interface AppState {
  today: string;
  clockMode: 'simulated' | 'live';
  autoConfirm: boolean;
  company: Company;
}

export async function appState(db: Db = pool): Promise<AppState> {
  const row = await one(`SELECT today, clock_mode, auto_confirm, company FROM app_state WHERE id = 1`, [], db);
  if (!row) throw new AppError(503, 'Keel has not been seeded yet. Run npm run db:seed', 'not_seeded');
  return { today: row.today, clockMode: row.clock_mode, autoConfirm: row.auto_confirm, company: row.company };
}

export const today = async (db: Db = pool) => (await appState(db)).today;

export async function audit(actor: string, action: string, entity: string, entityId: string | number | null, detail: object = {}, db: Db = pool) {
  await db.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,'','')`, [
    actor,
    action,
    entity,
    entityId === null ? null : String(entityId),
    JSON.stringify(detail),
  ]);
}

export interface Actor {
  id: number;
  name: string;
  role: 'admin' | 'staff' | 'customer';
  customerId: number | null;
  email: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paging(query: Record<string, string | undefined>, fallback = 25) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || fallback));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Builds a WHERE clause from optional filters, keeping parameters in order. */
export class Filters {
  clauses: string[] = [];
  params: unknown[] = [];

  add(sql: (ref: string) => string, value: unknown) {
    if (value === undefined || value === null || value === '') return this;
    this.params.push(value);
    this.clauses.push(sql(`$${this.params.length}`));
    return this;
  }

  raw(sql: string) {
    this.clauses.push(sql);
    return this;
  }

  get where() {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }

  next(value: unknown) {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

export async function listPage<T>(opts: {
  select: string;
  from: string;
  filters: Filters;
  orderBy: string;
  page: { page: number; pageSize: number; offset: number };
  db?: Db;
}): Promise<Page<T>> {
  const { select, from, filters, orderBy, page, db = pool } = opts;
  const params = [...filters.params];
  const [rows, count] = await Promise.all([
    q(`SELECT ${select} FROM ${from} ${filters.where} ORDER BY ${orderBy} LIMIT ${page.pageSize} OFFSET ${page.offset}`, params, db),
    one(`SELECT count(*)::int AS n FROM ${from} ${filters.where}`, params, db),
  ]);
  return { rows: rows as T[], total: count?.n ?? 0, page: page.page, pageSize: page.pageSize };
}
