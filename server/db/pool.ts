import pg from 'pg';

// Money is bigint paise and fits safely in a JS number. Dates stay as strings so
// no timezone can shift a billing day.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);
pg.types.setTypeParser(1082, (v) => v);

const LOCAL_URL = `postgres://keel:keel-local-only@127.0.0.1:${process.env.KEEL_PG_PORT ?? 54329}/keel`;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? LOCAL_URL,
  max: Number(process.env.DB_POOL_SIZE ?? 24),
  idleTimeoutMillis: 30_000,
});

export type Db = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query<T>(sql, params as any[])).rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  return (await db.query<T>(sql, params as any[])).rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Fast bulk insert: one JSON parameter expands to many rows with full type coercion. */
export async function bulkInsert(table: string, rows: Record<string, unknown>[], db: Db = pool, chunk = 4000): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const columns = Object.keys(batch[0]).map((c) => `"${c}"`).join(',');
    await db.query(
      `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM json_populate_recordset(null::${table}, $1)`,
      [JSON.stringify(batch)],
    );
  }
}

export const PG_ERRORS = {
  exclusion: '23P01',
  unique: '23505',
  check: '23514',
  foreignKey: '23503',
} as const;
