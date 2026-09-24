// Pure helpers behind the "use data from another step" editor. No React / DOM here so they can be unit tested.
import type { Extractor, Step, Workflow } from './types';

export type Phase = 'setup' | 'steps' | 'teardown';

/** The step list of a phase (the teardown may be absent). */
export const stepsOf = (wf: Workflow, phase: Phase): Step[] => (phase === 'setup' ? wf.setup : phase === 'steps' ? wf.steps : (wf.teardown ?? []));
export interface StepRef {
  phase: Phase;
  index: number;
}

export interface VarInfo {
  /** name as used in ${name} */
  name: string;
  kind: 'step' | 'user' | 'variable' | 'builtin';
  /** where the value comes from, e.g. the step name */
  source: string;
  /** ready-to-insert placeholder text for kind=builtin (e.g. ${$randomInt(1,100)}) */
  example?: string;
}

export const BUILTINS: VarInfo[] = [
  { name: '$uuid', kind: 'builtin', source: 'random UUID' },
  { name: '$timestamp', kind: 'builtin', source: 'current time (ms)' },
  { name: '$timestampSec', kind: 'builtin', source: 'current time (seconds)' },
  { name: '$isoDate', kind: 'builtin', source: 'current ISO date' },
  { name: '$randomInt(1,100)', kind: 'builtin', source: 'random number 1-100' },
  { name: '$vu', kind: 'builtin', source: 'virtual user number' },
  { name: '$iteration', kind: 'builtin', source: 'iteration number' },
];

/** All steps in execution order: setup first, then the iteration steps. */
export function orderedSteps(wf: Workflow): { ref: StepRef; step: Step }[] {
  return [
    ...wf.setup.map((step, index) => ({ ref: { phase: 'setup' as const, index }, step })),
    ...wf.steps.map((step, index) => ({ ref: { phase: 'steps' as const, index }, step })),
    ...(wf.teardown ?? []).map((step, index) => ({ ref: { phase: 'teardown' as const, index }, step })),
  ];
}

const position = (wf: Workflow, ref: StepRef) => (ref.phase === 'setup' ? ref.index : ref.phase === 'steps' ? wf.setup.length + ref.index : wf.setup.length + wf.steps.length + ref.index);

/** Steps that run before `ref` (in a virtual user's first iteration). `ref.index` may equal the list length = "after everything". */
export function stepsBefore(wf: Workflow, ref: StepRef): { ref: StepRef; step: Step }[] {
  const pos = position(wf, ref);
  return orderedSteps(wf).slice(0, pos);
}

/** Variables a step can reference: values extracted by earlier steps, user columns, workflow variables and built-ins. */
export function availableVars(wf: Workflow, ref: StepRef, userColumns: string[] = [], extraVars: string[] = []): VarInfo[] {
  const out: VarInfo[] = [];
  const seen = new Set<string>();
  const add = (v: VarInfo) => {
    if (!seen.has(v.name)) {
      seen.add(v.name);
      out.push(v);
    }
  };
  for (const { step } of stepsBefore(wf, ref)) {
    for (const name of Object.keys(step.set ?? {})) add({ name, kind: 'step', source: `made up in ${step.name}` });
    for (const e of step.extract ?? []) add({ name: e.var, kind: 'step', source: step.name });
  }
  // variables a step generates for itself are available to its own request
  const own = stepsOf(wf, ref.phase)[ref.index];
  for (const name of Object.keys(own?.set ?? {})) add({ name, kind: 'step', source: 'made up by this step' });
  for (const c of userColumns) add({ name: `user.${c}`, kind: 'user', source: 'users file' });
  for (const name of [...Object.keys(wf.variables), ...extraVars]) add({ name, kind: 'variable', source: 'workflow variable' });
  for (const b of BUILTINS) add(b);
  return out;
}

const PLACEHOLDER = /\$\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}/g;

/** Names referenced as ${name} / ${name|filter} in some text. */
export function placeholdersIn(text: string | undefined): string[] {
  const names: string[] = [];
  for (const m of (text ?? '').matchAll(PLACEHOLDER)) names.push(m[1]);
  return names;
}

export function stepTexts(step: Step): string[] {
  return [step.request.url, step.request.body ?? '', ...Object.values(step.request.headers ?? {})];
}

/** Variables a step reads that come from other steps (for the summary chip). */
export function usedStepVars(wf: Workflow, step: Step): string[] {
  const produced = new Set(orderedSteps(wf).flatMap(({ step: s }) => (s.extract ?? []).map((e) => e.var)));
  const used = new Set<string>();
  for (const t of stepTexts(step)) for (const n of placeholdersIn(t)) if (produced.has(n)) used.add(n);
  return [...used];
}

/** Placeholders the step uses that nothing provides at that point (typos, or produced by a later step). */
export function unresolvedVars(wf: Workflow, ref: StepRef, userColumns: string[] = [], extraVars: string[] = []): string[] {
  const step = stepsOf(wf, ref.phase)[ref.index];
  if (!step) return [];
  const ok = new Set(availableVars(wf, ref, userColumns, extraVars).map((v) => v.name));
  const missing = new Set<string>();
  for (const t of stepTexts(step)) {
    for (const n of placeholdersIn(t)) {
      if (n.startsWith('$') || ok.has(n)) continue;
      // user.<column> is only checked when the users file is known
      if (n.startsWith('user.') && userColumns.length === 0) continue;
      missing.add(n);
    }
  }
  return [...missing];
}

/** Every variable name already defined by some extractor or generated by a step. */
export function extractorVarNames(wf: Workflow): Set<string> {
  return new Set(orderedSteps(wf).flatMap(({ step }) => [...(step.extract ?? []).map((e) => e.var), ...Object.keys(step.set ?? {})]));
}

export function camel(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
  return /^[A-Za-z_]/.test(out) ? out : out ? `v${out}` : 'value';
}

/** Suggest a variable name for a JSON path, e.g. $.user.id -> userId, $.items[0].name -> itemName. */
export function suggestVarName(from: Extractor['from'], hint: string): string {
  if (from !== 'body') return camel(hint);
  const tokens = [...hint.matchAll(/\.([A-Za-z_$][\w$]*)|\["([^"]+)"\]/g)].map((m) => m[1] ?? m[2]);
  const last = tokens.at(-1) ?? 'value';
  if (/^id$/i.test(last) && tokens.length > 1) {
    const parent = tokens.at(-2)!;
    return camel(`${parent.replace(/ies$/i, 'y').replace(/(?<!s)s$/i, '')}_id`);
  }
  return camel(last);
}

export function uniqueVarName(base: string, taken: Set<string>): string {
  let name = base || 'value';
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
}

export const sameExtractor = (a: Extractor, b: Extractor) =>
  a.from === b.from && (a.path ?? '') === (b.path ?? '') && (a.name ?? '').toLowerCase() === (b.name ?? '').toLowerCase() && (a.regex ?? '') === (b.regex ?? '') && (a.group ?? 1) === (b.group ?? 1);

export const placeholder = (name: string, filter?: string) => '${' + name + (filter ? `|${filter}` : '') + '}';

/* ------------------------------------------------------------------ query parameters */

export interface Param {
  key: string;
  value: string;
  /** the key had no '=' (e.g. ?flag) and its value is still empty */
  bare?: boolean;
}

/** Split a URL into the part before the query and its raw (still encoded / templated) parameters. */
export function splitUrl(url: string): { base: string; params: Param[]; hash: string } {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = noHash.indexOf('?');
  if (q < 0) return { base: noHash, params: [], hash };
  const params = noHash
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? { key: p, value: '', bare: true } : { key: p.slice(0, eq), value: p.slice(eq + 1) };
    });
  return { base: noHash.slice(0, q), params, hash };
}

export function joinUrl(base: string, params: Param[], hash = ''): string {
  const q = params.map(paramText).join('&');
  return base + (q ? `?${q}` : '') + hash;
}

const paramText = (p: Param) => (p.bare && p.value === '' ? p.key : `${p.key}=${p.value}`);

/** Next unused parameter name: param1, param2, ... */
export function newParamName(params: Param[]): string {
  const used = new Set(params.map((p) => p.key));
  let n = 1;
  while (used.has(`param${n}`)) n++;
  return `param${n}`;
}

/* ------------------------------------------------------------------ request body */

export type BodyKind = 'json' | 'form' | 'text' | 'empty';

export function detectBodyKind(body: string | undefined, headers?: Record<string, string>): BodyKind {
  if (body === undefined || body === '') return 'empty';
  const ct = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const t = body.trimStart();
  if (/x-www-form-urlencoded/i.test(ct)) return 'form';
  if (/json/i.test(ct) || t.startsWith('{') || t.startsWith('[')) return jsonFields(body) ? 'json' : 'text';
  return /^[^\s=&]+=[^\s]*$/.test(body.trim()) && !t.startsWith('<') ? 'form' : 'text';
}

export function formFields(body: string): Param[] {
  return body
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? { key: p, value: '', bare: true } : { key: p.slice(0, eq), value: p.slice(eq + 1) };
    });
}

export const joinForm = (params: Param[]) => params.map(paramText).join('&');

type Tok = string | number;

export interface JsonField {
  tokens: Tok[];
  /** display path, e.g. items[0].name */
  label: string;
  /** text shown in the value box */
  value: string;
  /** true for numbers, booleans, null and bare ${placeholders}: written without quotes */
  raw: boolean;
}

const SENTINEL = /^__LTVAR(\d+)__$/;

/**
 * JSON bodies produced by the builder contain bare placeholders such as {"id":${productId}}, which is not valid
 * JSON. Swap them for sentinel strings so the body can be parsed, and remember the originals.
 */
function protect(body: string): { text: string; raws: string[] } {
  const raws: string[] = [];
  let out = '';
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += body[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '$' && body[i + 1] === '{') {
      const end = body.indexOf('}', i);
      if (end < 0) {
        out += c;
        continue;
      }
      out += `"__LTVAR${raws.length}__"`;
      raws.push(body.slice(i, end + 1));
      i = end;
    } else out += c;
  }
  return { text: out, raws };
}

function parseProtected(body: string): { data: unknown; raws: string[] } | null {
  try {
    const { text, raws } = protect(body);
    return { data: JSON.parse(text), raws };
  } catch {
    return null;
  }
}

const labelOf = (tokens: Tok[]) => tokens.map((t, i) => (typeof t === 'number' ? `[${t}]` : i === 0 ? t : `.${t}`)).join('') || '(body)';

/** Editable leaves of a JSON body, or null when the body is not JSON. */
export function jsonFields(body: string): JsonField[] | null {
  const parsed = parseProtected(body);
  if (!parsed || parsed.data === null || typeof parsed.data !== 'object') return null;
  const fields: JsonField[] = [];
  const walk = (node: unknown, tokens: Tok[], depth: number) => {
    if (fields.length >= 300 || depth > 10) return;
    if (Array.isArray(node)) node.slice(0, 100).forEach((v, i) => walk(v, [...tokens, i], depth + 1));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...tokens, k], depth + 1);
    else if (typeof node === 'string') {
      const m = SENTINEL.exec(node);
      if (m) fields.push({ tokens, label: labelOf(tokens), value: parsed.raws[Number(m[1])], raw: true });
      else fields.push({ tokens, label: labelOf(tokens), value: node, raw: false });
    } else fields.push({ tokens, label: labelOf(tokens), value: String(node), raw: true });
  };
  walk(parsed.data, [], 0);
  return fields;
}

const RAW_LITERAL = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/;
const ONLY_PLACEHOLDERS = /^\$\{[^}]*\}$/;

/** Set one leaf of a JSON body. Raw leaves stay unquoted while the new text is a number/bool/null/${placeholder}. */
export function setJsonField(body: string, tokens: Tok[], value: string): string {
  const parsed = parseProtected(body);
  if (!parsed) return body;
  const raws = [...parsed.raws];
  let cursor: unknown = parsed.data;
  for (const t of tokens.slice(0, -1)) cursor = (cursor as Record<Tok, unknown>)[t];
  const last = tokens[tokens.length - 1];
  const holder = cursor as Record<Tok, unknown>;
  const current = holder[last];
  const wasRaw = typeof current !== 'string' || SENTINEL.test(current);
  if (wasRaw && (RAW_LITERAL.test(value.trim()) || ONLY_PLACEHOLDERS.test(value.trim()))) {
    if (RAW_LITERAL.test(value.trim())) holder[last] = JSON.parse(value.trim());
    else {
      raws.push(value.trim());
      holder[last] = `__LTVAR${raws.length - 1}__`;
    }
  } else holder[last] = value;
  return serialize(parsed.data, raws, body);
}

function serialize(data: unknown, raws: string[], original: string): string {
  const indent = /\n\s+"/.test(original) ? 2 : 0;
  return JSON.stringify(data, null, indent || undefined).replace(/"__LTVAR(\d+)__"/g, (_m, n) => raws[Number(n)]);
}

const JSON_SAFE = new Set(['base64', 'base64url', 'base64utf16', 'hex', 'md5', 'sha1', 'sha256', 'sha512']);
const URL_SAFE = new Set(['base64url', 'hex', 'md5', 'sha1', 'sha256', 'sha512', 'urlencode']);

/**
 * The filter chain for a placeholder: the encoding the user chose (base64, sha256, ...) followed by whatever the place
 * needs (|urlencode in a query string, |json in a JSON string), unless the encoding already produces text that is safe there.
 */
export function chainFor(encoding: string | undefined, context?: string): string | undefined {
  if (!encoding) return context;
  if (context === 'json' && JSON_SAFE.has(encoding)) return encoding;
  if (context === 'urlencode' && URL_SAFE.has(encoding)) return encoding;
  return context ? `${encoding}|${context}` : encoding;
}

/** What to wrap a variable in for a given place: JSON strings need |json, URLs and forms need |urlencode. */
export function filterFor(place: 'json-string' | 'json-raw' | 'url' | 'form' | 'plain'): string | undefined {
  return place === 'json-string' ? 'json' : place === 'url' || place === 'form' ? 'urlencode' : undefined;
}

/* ------------------------------------------------------------------ authentication detection */

export interface DetectedAuth {
  auth: NonNullable<Workflow['auth']>;
  /** number of steps that carry the header */
  steps: number;
  /** the exact header value found on the steps (pass to stripAuthorization) */
  headerValue: string;
}

/** Find an Authorization header repeated on the steps, so it can be moved to the workflow-level authentication. */
export function detectAuth(wf: Workflow): DetectedAuth | null {
  const counts = new Map<string, number>();
  for (const { step } of orderedSteps(wf)) {
    for (const [k, v] of Object.entries(step.request.headers ?? {})) if (k.toLowerCase() === 'authorization' && v.trim()) counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [value, steps] = top;
  const bearer = /^bearer\s+(.+)$/i.exec(value);
  if (bearer) return { auth: { type: 'bearer', token: bearer[1] }, steps, headerValue: value };
  const basic = /^basic\s+(.+)$/i.exec(value);
  if (basic && !basic[1].includes('${')) {
    const [u, ...p] = decodeBase64(basic[1]).split(':');
    return { auth: { type: 'basic', username: u, password: p.join(':') }, steps, headerValue: value };
  }
  return { auth: { type: 'header', name: 'Authorization', value }, steps, headerValue: value };
}

function decodeBase64(s: string): string {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return '';
  }
}

/** Remove the Authorization header carrying `value` from every step. Returns a new workflow. */
export function stripAuthorization(wf: Workflow, value: string): Workflow {
  const clean = (steps: Step[]) =>
    steps.map((s) => {
      const headers = Object.fromEntries(Object.entries(s.request.headers ?? {}).filter(([k, v]) => !(k.toLowerCase() === 'authorization' && v.trim() === value)));
      const { headers: _drop, ...rest } = s.request;
      return { ...s, request: { ...rest, ...(Object.keys(headers).length ? { headers } : {}) } };
    });
  return { ...wf, setup: clean(wf.setup), steps: clean(wf.steps), ...(wf.teardown ? { teardown: clean(wf.teardown) } : {}) };
}
