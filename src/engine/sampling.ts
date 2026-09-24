import type { CallSample, CaptureSettings } from '../types.js';

/** Decides which calls keep their full details, and receives them. Implemented by the metrics collector. */
export interface CallSampler {
  /** called once the outcome of a call is known; return true to build a CallSample for it */
  want(step: string, failed: boolean): boolean;
  add(sample: CallSample): void;
  readonly capture: CaptureSettings;
}

/** A sampler that keeps every call (used by "Validate", which runs a handful of calls). */
export function keepEverything(capture: CaptureSettings, into: (s: CallSample) => void): CallSampler {
  return { want: () => true, add: into, capture };
}

/* ------------------------------------------------------------------ masking */

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
/** key names whose value is a credential; "pass|pwd|secret|otp" are hidden completely, tokens keep a short prefix */
const HIDE_KEY = /pass|pwd|secret|otp|pin$/i;
const TOKEN_KEY = /token|api[_-]?key|apikey|authorization|session/i;
const FIELD = /("?)([A-Za-z0-9_.-]*(?:pass|pwd|secret|otp|token|api[_-]?key|apikey|session|authorization)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^&\s,;}"]+)/gi;

/** Keep a recognisable prefix so the value can still be matched by eye, hide the rest. */
export function maskValue(v: string): string {
  if (v.length <= 8) return '••••••';
  return `${v.slice(0, 6)}…[masked, ${v.length} chars]`;
}

function maskAuthHeader(v: string): string {
  const m = /^(Bearer|Basic|Token|Digest)\s+(.+)$/i.exec(v);
  return m ? `${m[1]} ${maskValue(m[2])}` : maskValue(v);
}

const maskPair = (c: string) => {
  const eq = c.indexOf('=');
  return eq > 0 && /^[^\s]+$/.test(c.slice(0, eq)) ? `${c.slice(0, eq)}=${maskValue(c.slice(eq + 1))}` : c;
};

/** Cookie: every name=value pair is a credential. */
function maskCookies(v: string): string {
  return v.split(/;\s*/).map(maskPair).join('; ');
}

/** Set-Cookie: only the first pair is the credential, the rest (Path, HttpOnly, ...) are attributes. */
function maskSetCookie(line: string): string {
  const [first, ...attrs] = line.split(/;\s*/);
  return [maskPair(first), ...attrs].join('; ');
}

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SECRET_HEADER.test(k)) out[k] = v;
    else if (/^(cookie|set-cookie)$/i.test(k)) out[k] = k.toLowerCase() === 'cookie' ? maskCookies(v) : v.split('\n').map(maskSetCookie).join('\n');
    else out[k] = maskAuthHeader(v);
  }
  return out;
}

/** Mask credential-looking fields in JSON, form bodies and URL query strings. */
export function maskText(text: string): string {
  return text.replace(FIELD, (_m, q: string, key: string, sep: string, value: string) => {
    const quoted = value.startsWith('"');
    const raw = quoted ? value.slice(1, -1) : value;
    if (raw === '' || /^\$\{.*\}$/.test(raw)) return _m; // empty, or a template placeholder: nothing secret
    if (!HIDE_KEY.test(key) && !TOKEN_KEY.test(key)) return _m;
    const masked = HIDE_KEY.test(key) ? '••••••' : maskValue(raw);
    return `${q}${key}${q}${sep}${quoted ? `"${masked}"` : masked}`;
  });
}

export function maskVars(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, HIDE_KEY.test(k) ? '••••••' : TOKEN_KEY.test(k) ? maskValue(v) : v]));
}

export function cut(text: string | undefined, maxBytes: number): { text?: string; truncated?: boolean } {
  if (text === undefined) return {};
  return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text };
}

/* ------------------------------------------------------------------ merging (workers -> run) */

/** Keep at most okSamples successful and errorSamples failed calls per step; earlier ones win. */
export function mergeSamples(into: CallSample[], incoming: CallSample[], capture: CaptureSettings): void {
  const count = new Map<string, number>();
  for (const s of into) count.set(`${s.step}|${s.outcome}`, (count.get(`${s.step}|${s.outcome}`) ?? 0) + 1);
  for (const s of incoming) {
    const key = `${s.step}|${s.outcome}`;
    const n = count.get(key) ?? 0;
    if (n >= (s.outcome === 'ok' ? capture.okSamples : capture.errorSamples)) continue;
    count.set(key, n + 1);
    into.push(s);
  }
}
