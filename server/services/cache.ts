// Heavy read-only reports only. Every write bumps the version, so a cached report can
// never survive the change that made it wrong. Identical requests in flight share one
// query. Keel runs as a single instance, which is what makes this simple and correct.
let version = 0;

export const bumpDataVersion = () => void version++;

const entries = new Map<string, { version: number; at: number; value: Promise<unknown> }>();
const MAX_ENTRIES = 200;

export function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;

  const value = compute().catch((err) => {
    entries.delete(key);
    throw err;
  });
  if (entries.size >= MAX_ENTRIES) entries.clear();
  entries.set(key, { version, at: Date.now(), value });
  return value;
}
