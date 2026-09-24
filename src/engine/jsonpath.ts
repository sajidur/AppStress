/**
 * Small JSON path support, enough for correlating recorded calls and for picking values out of lists:
 *   $.a.b[0]["c-d"]                       an exact value
 *   $.items[*].id                         every item's id (choose with select: first / last / random)
 *   $.items[?(@.status=='OPEN')].id       the ids of the items that match a condition
 *   $.items[?(@.qty>0 && @.type=='A')]    conditions can be combined with &&
 * Conditions compare @.field (nested fields allowed) with a string, number, true/false/null, or a /regex/ using
 * ==  !=  >  >=  <  <=  =~ ; a bare @.field means "is set and not false/0/empty".
 */
export type PathToken = string | number;
export type Wildcard = { any: true };
export type Filter = { filter: string };
/** A step of a query: an exact key/index, every child, or the children matching a condition. */
export type QueryToken = PathToken | Wildcard | Filter;

const isWildcard = (t: QueryToken): t is Wildcard => typeof t === 'object' && 'any' in t;
const isFilter = (t: QueryToken): t is Filter => typeof t === 'object' && 'filter' in t;

/** true when the path can match several values (a wildcard or a condition) */
export function isMultiPath(path: string): boolean {
  try {
    return tokenizePath(path).some((t) => typeof t === 'object');
  } catch {
    return false;
  }
}

export function tokenizePath(path: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[["']((?:[^"'\\]|\\.)*)["']\]|\[\*\]/y;
  let s = path.trim();
  if (s.startsWith('$')) s = s.slice(1);
  let pos = 0;
  while (pos < s.length) {
    if (s.startsWith('[?(', pos)) {
      const end = filterEnd(s, pos + 3);
      if (end < 0) throw new Error(`invalid JSON path "${path}": unterminated condition`);
      tokens.push({ filter: s.slice(pos + 3, end) });
      pos = end + 2; // skip )]
      continue;
    }
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error(`invalid JSON path "${path}"`);
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else if (m[3] !== undefined) tokens.push(m[3].replace(/\\(.)/g, '$1'));
    else tokens.push({ any: true });
    pos = re.lastIndex;
  }
  return tokens;
}

/** index of the ")" that closes a "[?(" condition ("...)]"), ignoring parentheses inside quotes */
function filterEnd(s: string, from: number): number {
  let depth = 1;
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return s[i + 1] === ']' ? i : -1;
  }
  return -1;
}

export function formatPath(tokens: QueryToken[]): string {
  return (
    '$' +
    tokens
      .map((t) =>
        isWildcard(t)
          ? '[*]'
          : isFilter(t)
            ? `[?(${t.filter})]`
            : typeof t === 'number'
              ? `[${t}]`
              : /^[A-Za-z_$][\w$]*$/.test(t)
                ? `.${t}`
                : `[${JSON.stringify(t)}]`,
      )
      .join('')
  );
}

/* ------------------------------------------------------------------ conditions */

type Cmp = '==' | '!=' | '>=' | '<=' | '>' | '<' | '=~';
interface Condition {
  field: QueryToken[];
  op?: Cmp;
  value?: unknown;
}

function splitAnd(expr: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += expr[++i] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '&' && expr[i + 1] === '&') {
      parts.push(cur);
      cur = '';
      i++;
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function literal(text: string, op: Cmp): unknown {
  const t = text.trim();
  if (op === '=~') {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(t);
    if (!m) throw new Error(`invalid condition value ${t}: a regex looks like /pattern/i`);
    return new RegExp(m[1], m[2]);
  }
  const q = /^(['"])(.*)\1$/s.exec(t);
  if (q) return q[2].replace(/\\(.)/g, '$1');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  throw new Error(`invalid condition value ${t}: quote text, like 'OPEN'`);
}

const cache = new Map<string, Condition[]>();

function compile(expr: string): Condition[] {
  let list = cache.get(expr);
  if (list) return list;
  list = splitAnd(expr).map((part) => {
    const m = /^\s*@((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[["'][^"']*["']\])*)\s*(?:(==|!=|>=|<=|=~|>|<)\s*([\s\S]+?))?\s*$/.exec(part);
    if (!m) throw new Error(`invalid condition "${part.trim()}": use @.field == 'value'`);
    const field = tokenizePath(`$${m[1]}`);
    return m[2] ? { field, op: m[2] as Cmp, value: literal(m[3], m[2] as Cmp) } : { field };
  });
  if (cache.size > 500) cache.clear();
  cache.set(expr, list);
  return list;
}

function fieldValue(item: unknown, field: QueryToken[]): unknown {
  let cur = item;
  for (const t of field) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || typeof t === 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[t];
  }
  return cur;
}

function holds(item: unknown, conds: Condition[]): boolean {
  return conds.every((c) => {
    const v = fieldValue(item, c.field);
    if (!c.op) return !(v === undefined || v === null || v === false || v === 0 || v === '');
    const want = c.value;
    switch (c.op) {
      case '==':
        return v === want || (v !== undefined && v !== null && typeof want !== 'object' && String(v) === String(want));
      case '!=':
        return !(v === want || (v !== undefined && v !== null && typeof want !== 'object' && String(v) === String(want)));
      case '=~':
        return typeof v === 'string' || typeof v === 'number' ? (want as RegExp).test(String(v)) : false;
      default: {
        const a = typeof v === 'number' ? v : Number(v);
        const b = want as number;
        if (v === undefined || v === null || Number.isNaN(a)) return false;
        return c.op === '>' ? a > b : c.op === '>=' ? a >= b : c.op === '<' ? a < b : a <= b;
      }
    }
  });
}

/* ------------------------------------------------------------------ evaluation */

/** Every value the path matches, in document order (empty when nothing matches). */
export function getPathAll(obj: unknown, path: string): unknown[] {
  let level: unknown[] = [obj];
  for (const t of tokenizePath(path)) {
    const next: unknown[] = [];
    for (const cur of level) {
      if (cur === null || cur === undefined || typeof cur !== 'object') continue;
      if (isWildcard(t)) next.push(...(Array.isArray(cur) ? cur : Object.values(cur)));
      else if (isFilter(t)) {
        const conds = compile(t.filter);
        for (const child of Array.isArray(cur) ? cur : Object.values(cur)) if (holds(child, conds)) next.push(child);
      } else {
        const v = (cur as Record<string | number, unknown>)[t];
        if (v !== undefined) next.push(v);
      }
    }
    level = next;
    if (!level.length) break;
  }
  return level;
}

/** The first match, or undefined. */
export function getPath(obj: unknown, path: string): unknown {
  return getPathAll(obj, path)[0];
}

export type Select = 'first' | 'last' | 'random';

export function pickOne<T>(matches: T[], select: Select = 'first', random: () => number = Math.random): T | undefined {
  if (!matches.length) return undefined;
  if (select === 'last') return matches[matches.length - 1];
  if (select === 'random') return matches[Math.floor(random() * matches.length)];
  return matches[0];
}

/** Walk JSON leaves (strings / numbers) with their paths. */
export function* walkLeaves(
  value: unknown,
  tokens: PathToken[] = [],
  depth = 0,
): Generator<{ tokens: PathToken[]; value: string | number }> {
  if (depth > 12) return;
  if (typeof value === 'string' || typeof value === 'number') {
    yield { tokens, value };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 200; i++) yield* walkLeaves(value[i], [...tokens, i], depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walkLeaves(v, [...tokens, k], depth + 1);
  }
}
