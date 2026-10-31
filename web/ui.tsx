import { useMutation, useQuery, useQueryClient, type UseMutationOptions } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, queryString } from './lib/api';

// Toasts
const ToastContext = createContext<(message: string, kind?: 'ok' | 'bad') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string; kind: string }[]>([]);
  const next = useRef(1);
  const show = useCallback((message: string, kind: 'ok' | 'bad' = 'ok') => {
    const id = next.current++;
    setItems((list) => [...list, { id, message, kind }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind === 'bad' ? 'bad' : ''}`}>{t.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

/** A mutation that reports its outcome and refreshes the data it touched. */
export function useAction<V = void, R = any>(fn: (vars: V) => Promise<R>, opts: { success?: string | ((r: R) => string); onDone?: (r: R) => void } & Partial<UseMutationOptions<R, ApiError, V>> = {}) {
  const toast = useToast();
  const client = useQueryClient();
  return useMutation<R, ApiError, V>({
    mutationFn: fn,
    onSuccess: (result) => {
      client.invalidateQueries();
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(result) : opts.success);
      opts.onDone?.(result);
    },
    onError: (err) => toast(err.message, 'bad'),
  });
}

export function useGet<T = any>(path: string | null, options: { keepPrevious?: boolean; refetchInterval?: number } = {}) {
  return useQuery<T, ApiError>({
    queryKey: [path],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    placeholderData: options.keepPrevious ? (prev) => prev : undefined,
    refetchInterval: options.refetchInterval,
  });
}

/** List state lives in the URL, so a filtered view can be shared or bookmarked. */
export function useListParams(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? defaults[key] ?? '';
  const set = (key: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== 'page') next.delete('page');
      return next;
    }, { replace: true });
  };
  const all = Object.fromEntries(params.entries());
  return { get, set, query: queryString({ ...defaults, ...all }), page: Number(params.get('page') ?? 1) };
}

export function Button({ variant = '', size = '', loading, children, ...props }: { variant?: string; size?: string; loading?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} className={`btn ${variant} ${size} ${props.className ?? ''}`} disabled={props.disabled || loading}>
      {children}
    </button>
  );
}

export function Field({ label, error, hint, children, className = '' }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span />
    </span>
  );
}

export function Stat({ label, value, foot, alert, href }: { label: string; value: ReactNode; foot?: ReactNode; alert?: boolean; href?: string }) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value" title={typeof value === 'string' ? value : undefined}>{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </>
  );
  return href ? <a href={href} className={`stat ${alert ? 'alert' : ''}`} style={{ display: 'block' }}>{body}</a> : <div className={`stat ${alert ? 'alert' : ''}`}>{body}</div>;
}

const TONES: Record<string, string> = {
  draft: '', quotation: 'sea', confirmed: 'sea', active: 'good', paused: 'warn', closed: 'ink', paid: 'good', cancelled: 'bad',
  overdue: 'bad', open: 'sea', auto_posted: 'good', suggested: 'warn', unmatched: 'bad', ignored: '', running: 'warn', completed: 'good', failed: 'bad',
  logged: '', sent: 'good', billed: 'good', voided: 'bad', waived: 'warn',
};

const LABELS: Record<string, string> = { auto_posted: 'Auto-posted', suggested: 'Needs a look', unmatched: 'No match' };

export function Status({ value }: { value: string }) {
  return <span className={`badge ${TONES[value] ?? ''}`}>{LABELS[value] ?? value[0].toUpperCase() + value.slice(1).replace(/_/g, ' ')}</span>;
}

export interface Column<T> {
  label: string;
  num?: boolean;
  render: (row: T) => ReactNode;
  width?: string;
}

export function Table<T>({ columns, rows, onRow, keyOf, foot, empty }: { columns: Column<T>[]; rows: T[]; onRow?: (row: T) => void; keyOf?: (row: T, i: number) => string | number; foot?: ReactNode; empty?: ReactNode }) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.label} className={c.num ? 'num' : ''} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={keyOf?.(row, i) ?? i} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(row) : undefined}
              tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(row); } : undefined}>
              {columns.map((c) => <td key={c.label} className={c.num ? 'num' : ''}>{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
        {foot && <tfoot>{foot}</tfoot>}
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>{total.toLocaleString('en-IN')} in total</span>
      <div className="row gap-6">
        <Button size="small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span>Page {page} of {pages.toLocaleString('en-IN')}</span>
        <Button size="small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onClose={onClose}>
      {open && (
        <>
          <div className="dialog-head"><h2>{title}</h2><button className="btn ghost small" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children}</div>;
}

export function Loading({ height = 200 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-label="Loading" />;
}

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return <div className="callout bad">{error.message}</div>;
}

export function Stepper({ steps, current, labels }: { steps: string[]; current: string; labels?: Record<string, string> }) {
  const at = steps.indexOf(current);
  return (
    <div className="stepper" aria-label={`Status: ${current}`}>
      {steps.map((step, i) => (
        <span key={step} className="row gap-4" style={{ gap: 0 }}>
          <span className={`step ${i < at ? 'done' : i === at ? 'now' : ''}`}>
            <span className="dot">{i <= at && <Check size={11} strokeWidth={3} />}</span>
            {labels?.[step] ?? step[0].toUpperCase() + step.slice(1)}
          </span>
          {i < steps.length - 1 && <span className={`bar ${i < at ? 'done' : ''}`} />}
        </span>
      ))}
    </div>
  );
}

export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{children && <p>{children}</p>}</div>
      {actions && <div className="row wrap no-print">{actions}</div>}
    </div>
  );
}

export function useTitle(title: string) {
  useEffect(() => { document.title = `${title} · Keel`; }, [title]);
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const id = setTimeout(() => onChange(text), 250);
    return () => clearTimeout(id);
  }, [text]);
  return <input className="input" style={{ width: 240 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} />;
}

export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? err.fields ?? {} : {};
}
