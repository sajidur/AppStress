import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { RunStatus, Verdict } from '../types';

/* ---------------------------------------------------------------- toasts */

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: shows errors as toasts and tracks a busy flag. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

/* ---------------------------------------------------------------- building blocks */

export function Card({ title, hint, actions, children, bodyless }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children?: ReactNode; bodyless?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {bodyless ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

export function Field({ label, help, children, htmlFor }: { label: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <div className="empty row" style={{ justifyContent: 'center' }}>
      <Spinner /> {what}…
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="callout bad row between">
      <span>{error.message}</span>
      {retry && (
        <button className="btn small" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Modal({ title, children, footer, onClose }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-header">
          <h2>{title}</h2>
          <button className="btn ghost icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- status */

const STATUS: Record<RunStatus, { label: string; cls: string; live?: boolean }> = {
  starting: { label: 'Starting', cls: 'info', live: true },
  running: { label: 'Running', cls: 'info', live: true },
  stopping: { label: 'Stopping', cls: 'warn', live: true },
  completed: { label: 'Completed', cls: '' },
  stopped: { label: 'Stopped', cls: 'warn' },
  timeout: { label: 'Timed out', cls: 'bad' },
  failed: { label: 'Failed', cls: 'bad' },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status] ?? { label: status, cls: '' };
  return (
    <span className={`badge ${s.cls}`}>
      <span className={`dot ${s.live ? 'pulse' : ''}`} />
      {s.label}
    </span>
  );
}

export function VerdictBadge({ verdict, large }: { verdict: Verdict | null; large?: boolean }) {
  if (!verdict) return <span className="faint">—</span>;
  const icon = verdict === 'passed' ? '✓' : verdict === 'failed' ? '✕' : '!';
  const label = verdict === 'passed' ? 'Passed' : verdict === 'failed' ? 'Failed' : 'Error';
  if (large) {
    return (
      <span className={`verdict ${verdict}`}>
        {icon} {label.toUpperCase()}
      </span>
    );
  }
  return (
    <span className={`badge ${verdict === 'passed' ? 'good' : 'bad'}`}>
      {icon} {label}
    </span>
  );
}

export function MethodTag({ method }: { method: string }) {
  return <span className={`method ${method.toUpperCase()}`}>{method.toUpperCase()}</span>;
}

/* ---------------------------------------------------------------- formatting */

export const fmt = {
  ms: (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`),
  pct: (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`),
  num: (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString()),
  rps: (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(1)),
  dur: (sec: number | null | undefined) => {
    if (sec === null || sec === undefined) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  },
  date: (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : '—'),
  ago: (ms: number | null | undefined) => {
    if (!ms) return '—';
    const d = (Date.now() - ms) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  },
  path: (url: string) => {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  },
};
