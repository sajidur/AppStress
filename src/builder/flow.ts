import { isMultiPath, tokenizePath } from '../engine/jsonpath.js';
import type { Extractor, Step, Workflow } from '../types.js';

/**
 * Data-flow analysis of a workflow: for every request, where each dynamic value comes from
 * (the users file, an earlier response, a generated value, the authentication), and for every value a
 * step saves, which later requests use it. Also finds values nobody produces and values nobody uses.
 * Pure and dependency-free, so the server (build report) and the browser (live while editing) share it.
 */

export type FlowOrigin = 'step' | 'user' | 'generated';

export interface FlowInput {
  /** where in the request the value goes, e.g. `query "page"`, `header "x-csrf"`, `body "itemId"`, `URL path` */
  where: string;
  /** the template text at that place */
  text: string;
  origin: FlowOrigin;
  /** the ${variable} (or built-in) */
  variable: string;
  /** origin=step: the step that produced it */
  from?: string;
  /** how it is obtained: JSON path, header name, users-file column, generator */
  how: string;
  /** origin=step: the request that produced it comes before this one */
  ordered: boolean;
}

export interface FlowOutput {
  variable: string;
  how: string;
  /** which later steps use it */
  usedBy: string[];
  /** the JSON path picks a list item by a fixed position, e.g. $.items[1].id */
  fixedPosition?: boolean;
}

export interface FlowStep {
  name: string;
  phase: 'setup' | 'steps' | 'teardown';
  index: number;
  method: string;
  /** the URL without ${baseUrl} */
  path: string;
  inputs: FlowInput[];
  outputs: FlowOutput[];
  /** variables this step makes up itself (ids, timestamps) */
  generates: { variable: string; how: string }[];
  /** fixed values in the request that look dynamic (tokens, ids): every user sends this same recorded value */
  fixedDynamic: { where: string; value: string; kind: string }[];
}

export interface FlowIssue {
  level: 'warn' | 'info';
  step?: string;
  message: string;
  /** what to do about it */
  hint?: string;
  /** machine-readable kind, so the UI can offer a fix */
  kind: 'unresolved' | 'too-early' | 'unused' | 'fixed-position' | 'encrypted' | 'encoded' | 'unexplained';
  variable?: string;
}

export interface FlowReport {
  steps: FlowStep[];
  issues: FlowIssue[];
  /** number of value hand-overs between steps */
  links: number;
}

const PLACEHOLDER = /\$\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}/g;

const describeExtractor = (e: Extractor): string => {
  const pick = e.select && e.select !== 'first' && e.path && isMultiPath(e.path) ? ` (${e.select})` : '';
  const fallback = e.default !== undefined ? `, else "${e.default}"` : '';
  if (e.from === 'body') return `${e.path}${pick}${fallback}`;
  if (e.from === 'regex') return `regex ${e.regex}`;
  if (e.from === 'status') return 'status code';
  return `${e.from} ${e.name}`;
};

/** A numeric list index in a JSON path, e.g. $.items[1].id (an exact position, the same for every user). */
const hasFixedPosition = (e: Extractor) => e.from === 'body' && !!e.path && /\[\d+\]/.test(e.path) && !isMultiPath(e.path);

/** name of the JSON key or form field a placeholder sits in: `"itemId":${x}` -> itemId, `a=${x}` -> a */
function keyBefore(text: string, offset: number): string | undefined {
  const before = text.slice(Math.max(0, offset - 120), offset);
  return /["']?([\w.-]+)["']?\s*[:=]\s*["']?$/.exec(before)?.[1];
}

const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{24,}\b/gi;
const OPAQUE = /(?<![\w-])(?=[A-Za-z0-9_-]{20,}(?![\w-]))(?=[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}/g;
/** headers whose fixed value is normal (content negotiation, browser identity) */
const PLAIN_HEADERS = /^(accept|accept-language|content-type|user-agent|origin|referer|x-requested-with|cache-control|sec-.*)$/i;

/** Fixed (recorded) values in a request that look like tokens or ids: they will be the same for every user. */
function fixedDynamic(step: Step, defaults: Record<string, string> = {}): FlowStep['fixedDynamic'] {
  const found: FlowStep['fixedDynamic'] = [];
  const seen = new Set<string>();
  const scan = (text: string, where: string) => {
    const literal = text.replace(/\$\{[^}]*\}/g, ' ');
    for (const [re, kind] of [[JWT, 'token'], [UUID, 'id'], [HEX, 'id'], [OPAQUE, 'id']] as const) {
      for (const m of literal.matchAll(re)) {
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        found.push({ where, value: m[0].length > 40 ? `${m[0].slice(0, 37)}...` : m[0], kind });
      }
    }
  };
  const url = step.request.url;
  const q = url.indexOf('?');
  scan(q < 0 ? url : url.slice(0, q), 'URL path');
  if (q >= 0) scan(url.slice(q + 1), 'query string');
  for (const [k, v] of Object.entries(step.request.headers ?? {})) if (!PLAIN_HEADERS.test(k) && defaults[k] !== v) scan(v, `header "${k}"`);
  if (step.request.body) scan(step.request.body, 'body');
  return found;
}

/** ' -> base64 -> urlencode' when a value is transformed before it is sent */
const sentAs = (filters?: string) => (filters ? ` -> ${filters.split('|').map((x) => x.trim()).filter(Boolean).join(' -> ')}` : '');

const urlPath = (url: string) => url.replace(/^\$\{[^}]+\}/, '').replace(/^https?:\/\/[^/]+/, '') || '/';

/** Pull the placeholders out of a step's request, with where each one is used. */
function placeholdersOf(step: Step): { where: string; text: string; name: string; filters?: string }[] {
  const out: { where: string; text: string; name: string; filters?: string }[] = [];
  const scan = (text: string, where: (offset: number) => string) => {
    for (const m of text.matchAll(PLACEHOLDER)) out.push({ where: where(m.index ?? 0), text: m[0], name: m[1], filters: m[2]?.trim() || undefined });
  };
  const url = step.request.url;
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  scan(path.replace(/^\$\{[^}]+\}/, (m) => ' '.repeat(m.length)), () => 'URL path');
  if (q >= 0) scan(url.slice(q + 1), (o) => `query "${keyBefore(url.slice(q + 1), o) ?? '?'}"`);
  for (const [k, v] of Object.entries(step.request.headers ?? {})) scan(v, () => `header "${k}"`);
  const body = step.request.body;
  if (body) scan(body, (o) => (keyBefore(body, o) ? `body "${keyBefore(body, o)}"` : 'body'));
  return out;
}

export function analyzeFlow(wf: Workflow, opts: { userColumns?: string[] } = {}): FlowReport {
  const ordered = [
    ...wf.setup.map((step, index) => ({ step, phase: 'setup' as const, index })),
    ...wf.steps.map((step, index) => ({ step, phase: 'steps' as const, index })),
    ...(wf.teardown ?? []).map((step, index) => ({ step, phase: 'teardown' as const, index })),
  ];

  // who produces which variable, and at which position in the run order
  const producer = new Map<string, { at: number; step: Step; how: string; extractor?: Extractor; generated?: boolean }>();
  ordered.forEach(({ step }, at) => {
    for (const [v, t] of Object.entries(step.set ?? {})) if (!producer.has(v)) producer.set(v, { at, step, how: t, generated: true });
    for (const e of step.extract ?? []) if (!producer.has(e.var)) producer.set(e.var, { at, step, how: describeExtractor(e), extractor: e });
  });

  const steps: FlowStep[] = [];
  const issues: FlowIssue[] = [];
  const usedBy = new Map<string, Set<string>>();
  let links = 0;

  ordered.forEach(({ step, phase, index }, at) => {
    const inputs: FlowInput[] = [];
    const uses = placeholdersOf(step);
    if (wf.auth && !step.skipAuth) {
      for (const [where, t] of [['authentication token', wf.auth.token], ['authentication username', wf.auth.username], ['authentication password', wf.auth.password], ['authentication value', wf.auth.value]] as const) {
        if (!t) continue;
        for (const m of t.matchAll(PLACEHOLDER)) uses.push({ where, text: m[0], name: m[1], filters: m[2]?.trim() || undefined });
      }
    }

    for (const u of uses) {
      const name = u.name;
      let input: FlowInput | undefined;
      if (name.startsWith('$')) {
        input = { where: u.where, text: u.text, origin: 'generated', variable: name, how: name.replace(/^\$/, '').replace(/\(.*$/, '') + ' (new value every call)', ordered: true };
      } else if (name.startsWith('user.')) {
        const col = name.slice(5);
        input = { where: u.where, text: u.text, origin: 'user', variable: name, how: `users file, column "${col}"${sentAs(u.filters)}`, ordered: true };
        if (opts.userColumns?.length && !opts.userColumns.includes(col)) {
          issues.push({ level: 'warn', step: step.name, kind: 'unresolved', variable: name, message: `${step.name} uses \${${name}} but the users file has no column "${col}"`, hint: `Columns: ${opts.userColumns.join(', ')}` });
        }
      } else if (producer.has(name)) {
        const p = producer.get(name)!;
        const early = p.at >= at && !(p.generated && p.step === step);
        input = {
          where: u.where,
          text: u.text,
          origin: p.generated ? 'generated' : 'step',
          variable: name,
          from: p.step.name,
          how: p.how + sentAs(u.filters),
          ordered: !early,
        };
        if (early) {
          issues.push({ level: 'warn', step: step.name, kind: 'too-early', variable: name, message: `${step.name} uses \${${name}}, but it is only produced later by ${p.step.name}`, hint: 'Move the producing step above this one.' });
        }
        if (!usedBy.has(name)) usedBy.set(name, new Set());
        usedBy.get(name)!.add(step.name);
        if (!p.generated) links++;
      } else if (name in wf.variables) {
        continue; // environment variable such as baseUrl: not data flowing between steps
      } else {
        issues.push({ level: 'warn', step: step.name, kind: 'unresolved', variable: name, message: `${step.name} uses \${${name}}, but no step produces it`, hint: 'Save it from an earlier response, or fix the name.' });
        continue;
      }
      inputs.push(input);
    }

    const fixed = fixedDynamic(step, wf.defaults?.headers);
    for (const f of fixed) {
      issues.push({
        level: 'warn',
        step: step.name,
        kind: 'unexplained',
        message: `${step.name} sends the fixed value ${f.value} in the ${f.where}. It looks like a ${f.kind === 'token' ? 'token' : 'generated id'} that no earlier response provides, so every user sends the same one.`,
        hint: 'If it comes from an earlier response, save it there and use it here. If the browser makes it up, use a generated value such as ${$uuid}.',
      });
    }

    steps.push({
      name: step.name,
      phase,
      index,
      fixedDynamic: fixed,
      method: step.request.method.toUpperCase(),
      path: urlPath(step.request.url),
      inputs,
      outputs: (step.extract ?? []).map((e) => ({ variable: e.var, how: describeExtractor(e), usedBy: [], fixedPosition: hasFixedPosition(e) })),
      generates: Object.entries(step.set ?? {}).map(([variable, how]) => ({ variable, how })),
    });
  });

  for (const s of steps) {
    for (const o of s.outputs) {
      o.usedBy = [...(usedBy.get(o.variable) ?? [])];
      if (!o.usedBy.length) {
        issues.push({ level: 'info', step: s.name, kind: 'unused', variable: o.variable, message: `${s.name} saves \${${o.variable}} (${o.how}) but no step uses it`, hint: 'Harmless. Remove it, or use it in a later request.' });
      } else if (o.fixedPosition) {
        issues.push({
          level: 'info',
          step: s.name,
          kind: 'fixed-position',
          variable: o.variable,
          message: `\${${o.variable}} always takes the same list position (${o.how}), for every user and iteration`,
          hint: 'Pick the first, last or a random item, or the first one matching a condition such as status == OPEN.',
        });
      }
    }
  }

  // a path that cannot be parsed is a broken step, not data flow: surface it
  for (const { step } of ordered) {
    for (const e of step.extract ?? []) {
      if (e.from !== 'body' || !e.path) continue;
      try {
        tokenizePath(e.path);
      } catch (err) {
        issues.push({ level: 'warn', step: step.name, kind: 'unresolved', variable: e.var, message: `${step.name}: ${(err as Error).message}` });
      }
    }
  }
  return { steps, issues, links };
}
