// Where a request field's value comes from, and how to change it (pure, unit tested).
import {
  availableVars,
  chainFor,
  detectBodyKind,
  formFields,
  joinForm,
  joinUrl,
  jsonFields,
  orderedSteps,
  placeholder,
  setJsonField,
  splitUrl,
  stepsBefore,
  type StepRef,
} from './bindings';
import type { Step, Workflow } from './types';

export type SourceKind = 'fixed' | 'user' | 'step' | 'generated' | 'loop' | 'mixed';

export interface FieldSource {
  kind: SourceKind;
  /** the variable, e.g. user.name or token */
  name?: string;
  /** the filters after the name, e.g. base64|urlencode */
  filters?: string;
}

const ONLY_PLACEHOLDER = /^\$\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}$/;

/** Classify the text of one field: a fixed value, or exactly one ${variable} from some source. */
export function fieldSource(value: string, loopAs?: string): FieldSource {
  const v = value.trim();
  if (!v.includes('${')) return { kind: 'fixed' };
  const m = ONLY_PLACEHOLDER.exec(v);
  if (!m) return { kind: 'mixed' };
  const name = m[1];
  const filters = m[2]?.trim() || undefined;
  if (name.startsWith('user.')) return { kind: 'user', name, filters };
  if (name.startsWith('$')) return { kind: 'generated', name, filters };
  if (loopAs && (name === loopAs || name.startsWith(`${loopAs}.`))) return { kind: 'loop', name, filters };
  return { kind: 'step', name, filters };
}

const CONTEXT = new Set(['json', 'urlencode']);

/** The encodings of a filter chain (base64, sha256, ...) without the escaping that only the place needs. */
export function encodingOf(filters?: string): string | undefined {
  const rest = (filters ?? '').split('|').map((f) => f.trim()).filter((f) => f && !CONTEXT.has(f));
  return rest.length ? rest.join('|') : undefined;
}

/** The text a field gets when its source is changed to a variable; the encoding it had is kept. */
export function withSource(name: string, previous: FieldSource | undefined, context?: string): string {
  return placeholder(name, chainFor(encodingOf(previous?.filters), context));
}

/* ------------------------------------------------------------------ making a fixed value dynamic */

/** Text that decodes from Base64 to readable text, like YWxpY2U= (alice). */
export function looksBase64(value: string): boolean {
  const v = value.trim();
  if (v.length < 4 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  try {
    const text = atob(v);
    return /^[\x20-\x7e -￿]+$/.test(text) && !/[\x00-\x08]/.test(text);
  } catch {
    return false;
  }
}

/**
 * Replace the fixed value of one field (found by its `where`, like `body "userName"` or `query "u"`) by a placeholder.
 * A value that looks Base64 encoded gets |base64, so every user's own value is encoded the same way.
 */
export function bindLiteral(step: Step, where: string, key: string, variable: string): Step | null {
  const m = /^(body|query) "(.*)"$/.exec(where);
  if (!m) return null;
  const req = step.request;
  const pick = (literal: string, place: 'json' | 'urlencode') => {
    const filters = looksBase64(literal) ? 'base64' : undefined;
    return placeholder(variable, chainFor(filters, place));
  };
  if (m[1] === 'query') {
    const { base, params, hash } = splitUrl(req.url);
    const at = params.findIndex((p) => p.key === key);
    if (at < 0) return null;
    const next = params.map((p, i) => (i === at ? { key: p.key, value: pick(decodeURIComponent(p.value), 'urlencode') } : p));
    return { ...step, request: { ...req, url: joinUrl(base, next, hash) } };
  }
  const body = req.body ?? '';
  const kind = detectBodyKind(body, req.headers);
  if (kind === 'json') {
    const field = jsonFields(body)?.find((f) => f.label === key || f.label.endsWith(`.${key}`) || f.label === `[${key}]`);
    if (!field) return null;
    return { ...step, request: { ...req, body: setJsonField(body, field.tokens, pick(field.value, 'json')) } };
  }
  if (kind === 'form') {
    const fields = formFields(body);
    const at = fields.findIndex((f) => decodeURIComponent(f.key) === key);
    if (at < 0) return null;
    return { ...step, request: { ...req, body: joinForm(fields.map((f, i) => (i === at ? { key: f.key, value: pick(decodeURIComponent(f.value), 'urlencode') } : f))) } };
  }
  return null;
}

/** Best guess of the users-file column for a field name: "userName" -> name / user_name / username. */
export function guessColumn(key: string, columns: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const k = norm(key);
  const score = (c: string) => {
    const n = norm(c);
    if (!n) return 0;
    if (n === k) return 4;
    if (k.includes(n) || n.includes(k)) return 3;
    const generic = (s: string) => s.replace(/^(user|login|account|employee|customer)/, '').replace(/(name|id|no|code)$/, '');
    return generic(k) && generic(k) === generic(n) ? 2 : 0;
  };
  const best = columns.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s > 0 ? best.c : undefined;
}

/* ------------------------------------------------------------------ loops */

/** Variables that hold a list, saved by steps that run before `ref`. */
export function listVars(wf: Workflow, ref: StepRef): { name: string; source: string; path?: string }[] {
  const out: { name: string; source: string; path?: string }[] = [];
  for (const { step } of stepsBefore(wf, ref)) for (const e of step.extract ?? []) if (e.list) out.push({ name: e.var, source: step.name, path: e.path });
  return out;
}

/** The step that saves a list variable, with its extractor. */
export function listProducer(wf: Workflow, list: string): { step: Step; path?: string } | null {
  for (const { step } of orderedSteps(wf)) {
    const e = (step.extract ?? []).find((x) => x.var === list && x.list);
    if (e) return { step, path: e.path };
  }
  return null;
}

/**
 * Field names of one item of a list, learnt from the recorded response: for a list saved with $.customers[*] the
 * first item's fields ($.customers[0].id, $.customers[0].address.city) become id and address.city.
 */
export function loopFieldsFromSample(listPath: string | undefined, sample: { path: string }[]): string[] {
  if (!listPath) return [];
  const m = /^(.*)\[(?:\*|\?\(.*\))\]$/.exec(listPath.trim());
  if (!m) return []; // the items are plain values (a path such as $.customers[*].id)
  const head = `${m[1]}[0].`;
  const fields = new Set<string>();
  for (const s of sample) {
    if (!s.path.startsWith(head)) continue;
    const rest = s.path.slice(head.length).replace(/\[\d+\]/g, '');
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(rest)) fields.add(rest);
  }
  return [...fields];
}

/** Suggest the name of one item from the name of the list: customers -> customer. */
export function itemName(list: string): string {
  const base = list.replace(/(List|Items|Array)$/, '');
  const singular = /ies$/i.test(base) ? `${base.slice(0, -3)}y` : /(ss|us)$/i.test(base) ? base : /s$/i.test(base) ? base.slice(0, -1) : base;
  return singular && singular !== list ? singular : 'item';
}

export { availableVars };

/* ------------------------------------------------------------------ which user is who */

export interface UserPlan {
  vus: number;
  usersMode: 'per-vu' | 'unique' | 'per-iteration';
  mode: 'duration' | 'iterations';
  iterations: number;
  freshSession?: boolean;
}

/** In words: which row of the users file every virtual user and iteration will be. */
export function describeUsers(p: UserPlan, rows: number): { summary: string; warning?: string } {
  if (rows === 0) {
    return {
      summary: 'No users file: every virtual user runs with the same values, the ones that were recorded.',
      warning: 'Upload a users file (Test users tab) so that every virtual user can log in as a different user.',
    };
  }
  if (p.usersMode === 'per-iteration') {
    const logins = p.mode === 'iterations' ? p.vus * p.iterations : 0;
    const count = logins ? ` With ${p.vus} virtual user${p.vus === 1 ? '' : 's'} and ${p.iterations} iteration${p.iterations === 1 ? '' : 's'} that is ${logins} logins, using rows 1 to ${Math.min(logins, rows)}${logins > rows ? ', then starting again at row 1' : ''}.` : '';
    return { summary: `Every iteration logs in as the next row of the file: row 1, 2, 3, ..., back to row 1 after row ${rows}. The rows are taken in turn across all virtual users.${count}` };
  }
  const last = Math.min(p.vus, rows);
  const wraps = p.vus > rows ? ` Virtual user ${rows + 1} and above start again at row 1.` : '';
  const who = p.vus === 1 ? 'The one virtual user is row 1.' : `Virtual user 1 is row 1, virtual user ${last} is row ${last}.${wraps}`;
  const again = p.freshSession ? ' Every iteration logs that same user in again with a new session.' : ' Every iteration of a virtual user keeps the same user and session.';
  const warning =
    p.vus === 1 && rows > 1
      ? 'With one virtual user every iteration is the same user (row 1). To go through the file, choose "New user every iteration", or use more virtual users.'
      : undefined;
  return { summary: who + again, warning };
}
