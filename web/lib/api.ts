export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public fields?: Record<string, string>) {
    super(message);
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
let lastMs: number | null = null;

export const latency = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => lastMs,
};

function recordLatency(ms: number) {
  lastMs = Math.round(ms);
  listeners.forEach((fn) => fn());
}

async function handle(res: Response) {
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Something went wrong', data?.code, data?.fields);
  return data;
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const started = performance.now();
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await handle(res);
  if (!path.startsWith('/auth')) recordLatency(performance.now() - started);
  return data;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export async function upload<T = any>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return handle(await fetch(`/api${path}`, { method: 'POST', body: form, credentials: 'same-origin' }));
}

/** Reads a server-sent event stream from a POST, which EventSource cannot do. */
export async function streamPost(path: string, body: unknown, onEvent: (event: string, data: any) => void) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) await handle(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = frame.match(/^event: (.*)$/m)?.[1] ?? 'message';
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

export function queryString(params: Record<string, unknown>) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : '';
}
