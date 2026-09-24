import { useState, type ReactNode } from 'react';
import type { CallSample } from '../types';
import { fmt, useToast } from './ui';

/** Pretty-print JSON bodies (unless they were cut), leave everything else as it is. */
export function prettyBody(body: string | undefined, truncated?: boolean): string {
  if (body === undefined) return '';
  if (!truncated) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return body;
}

export const headerLines = (h: Record<string, string> | undefined) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** curl command for the request exactly as it was recorded (masked values stay masked). */
export function toCurl(c: CallSample): string {
  const parts = ['curl', '-i', '-X', c.request.method, shellQuote(c.request.url)];
  for (const [k, v] of Object.entries(c.request.headers)) parts.push('-H', shellQuote(`${k}: ${v}`));
  if (c.request.body !== undefined) parts.push('--data-raw', shellQuote(c.request.body));
  return parts.join(' ');
}

function Block({ title, children, empty }: { title: string; children?: string; empty: string }) {
  return (
    <div>
      <div className="call-h">{title}</div>
      {children ? <pre className="call-pre">{children}</pre> : <div className="faint" style={{ fontSize: 12.5 }}>{empty}</div>}
    </div>
  );
}

/** Everything about one call: request line, headers, body, and the response with what was saved from it. */
export function CallDetail({ call: c }: { call: CallSample }) {
  const toast = useToast();
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast('Copy failed: the browser blocked clipboard access', 'error');
    }
  };
  const res = c.response;
  return (
    <div className="call-body">
      <div className="call-cols">
        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <Block title="Request" empty="">{`${c.request.method} ${c.request.url}`}</Block>
          <Block title="Request headers" empty="No headers.">{headerLines(c.request.headers)}</Block>
          <Block title={`Request body${c.request.bodyTruncated ? ' (cut)' : ''}`} empty="No body.">
            {c.request.body !== undefined && c.request.body !== '' ? prettyBody(c.request.body, c.request.bodyTruncated) : undefined}
          </Block>
        </div>
        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <Block title={res ? `Response · ${res.bytes.toLocaleString()} bytes` : 'Response'} empty="No response was received.">
            {res ? [String(res.status), ...(c.redirects ?? []).map((h) => `redirect ${h.status} to ${h.url}`)].join('\n') : undefined}
          </Block>
          <Block title="Response headers" empty="No headers.">{res ? headerLines(res.headers) : undefined}</Block>
          <Block title={`Response body${res?.bodyTruncated ? ' (cut)' : ''}`} empty="Empty.">
            {res?.body ? prettyBody(res.body, res.bodyTruncated) : undefined}
          </Block>
        </div>
      </div>
      {Object.keys(c.extracted).length > 0 && (
        <Block title="Saved for later steps" empty="">
          {Object.entries(c.extracted)
            .map(([k, v]) => `${k} = ${v}`)
            .join('\n')}
        </Block>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => copy(toCurl(c), 'curl command')}>
          Copy as cURL
        </button>
        {res?.body && (
          <button className="btn small" onClick={() => copy(res.body!, 'Response body')}>
            Copy response body
          </button>
        )}
        {c.masked && <span className="faint" style={{ fontSize: 12.5 }}>Credentials are masked. Change this under Load &amp; criteria → Call details.</span>}
      </div>
    </div>
  );
}

/** One collapsible row per call. Failed calls start open. */
export function CallRow({ call: c, defaultOpen }: { call: CallSample; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? c.outcome === 'error');
  const bad = c.outcome === 'error';
  const status = c.response?.status;
  return (
    <div className={`call ${bad ? 'bad' : 'ok'}`}>
      <button className="call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="faint">{open ? '▾' : '▸'}</span>
        <span className={`badge ${bad ? 'bad' : 'good'}`}>{status ?? 'no response'}</span>
        <span className="num">{fmt.ms(c.durationMs)}</span>
        <span className="faint">
          {c.phase === 'setup' ? 'setup' : c.phase === 'teardown' ? 'teardown' : `iteration ${c.iteration + 1}`} · user {c.vu + 1} · {new Date(c.at).toLocaleTimeString()}
        </span>
        {c.auth === 'applied' && <span className="chip">auth sent</span>}
        {c.auth === 'skipped' && <span className="chip">no auth yet</span>}
        {c.error && <span style={{ color: 'var(--critical-text)', fontWeight: 600 }}>{c.error}</span>}
      </button>
      {open && <CallDetail call={c} />}
    </div>
  );
}

export function CallList({ calls, empty }: { calls: CallSample[]; empty?: ReactNode }) {
  if (!calls.length) return <>{empty ?? null}</>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {calls.map((c, i) => (
        <CallRow key={`${c.at}-${c.vu}-${i}`} call={c} />
      ))}
    </div>
  );
}
