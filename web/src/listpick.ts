// Turning "the 2nd item of a list" into "the first / a random / the first item where ..." (pure, unit tested).
import type { Extractor } from './types';

export interface ListPath {
  /** everything before the list position, e.g. $.items */
  prefix: string;
  /** the recorded position, e.g. 1 */
  index: number;
  /** what follows the item, e.g. .id */
  suffix: string;
}

/** Split a JSON path at its last numeric list index: $.items[1].id -> {prefix: '$.items', index: 1, suffix: '.id'} */
export function splitListPath(path: string): ListPath | null {
  const m = /^(.*)\[(\d+)\]((?:\.[A-Za-z_$][\w$]*)*)$/.exec(path.trim());
  return m ? { prefix: m[1], index: Number(m[2]), suffix: m[3] } : null;
}

export type Op = '==' | '!=' | '>' | '>=' | '<' | '<=' | '=~';
export const OPS: { value: Op; label: string }[] = [
  { value: '==', label: 'is' },
  { value: '!=', label: 'is not' },
  { value: '>', label: 'is greater than' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at most' },
  { value: '=~', label: 'matches regex' },
];

export interface Condition {
  /** field of the item, e.g. status or owner.name */
  field: string;
  op: Op;
  value: string;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** @.status=='OPEN' - text is quoted, numbers/true/false/null and regexes are not. */
export function conditionText(c: Condition): string {
  const field = c.field.trim().replace(/^@?\.?/, '');
  const v = c.value;
  let value: string;
  if (c.op === '=~') value = /^\/.*\/[a-z]*$/s.test(v) ? v : `/${v}/`;
  else if (c.op !== '==' && c.op !== '!=') value = NUMERIC.test(v.trim()) ? v.trim() : '0';
  else if (NUMERIC.test(v.trim()) || /^(true|false|null)$/.test(v.trim())) value = v.trim();
  else value = `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `@.${field}${c.op}${value}`;
}

export type PickMode = 'position' | 'first' | 'last' | 'random' | 'where';

export interface ListPick {
  mode: PickMode;
  /** all of these must hold (mode = where) */
  where?: Condition[];
  /** when several items match (mode = where): which one */
  select?: Extractor['select'];
}

/** The JSON path and selection that implement a pick. */
export function applyListPick(p: ListPath, pick: ListPick): Pick<Extractor, 'path' | 'select'> {
  switch (pick.mode) {
    case 'position':
      return { path: `${p.prefix}[${p.index}]${p.suffix}`, select: undefined };
    case 'first':
      return { path: `${p.prefix}[*]${p.suffix}`, select: 'first' };
    case 'last':
      return { path: `${p.prefix}[*]${p.suffix}`, select: 'last' };
    case 'random':
      return { path: `${p.prefix}[*]${p.suffix}`, select: 'random' };
    case 'where': {
      const conds = (pick.where ?? []).filter((c) => c.field.trim() !== '').map(conditionText);
      const filter = conds.length ? `[?(${conds.join(' && ')})]` : '[*]';
      return { path: `${p.prefix}${filter}${p.suffix}`, select: pick.select ?? 'first' };
    }
  }
}

/** The recorded item's own fields, as suggested conditions ("the item you used had status = OPEN"). */
export function siblingFields(sample: { path: string; value: string }[], p: ListPath): { field: string; value: string }[] {
  const head = `${p.prefix}[${p.index}].`;
  return sample
    .filter((s) => s.path.startsWith(head))
    .map((s) => ({ field: s.path.slice(head.length).replace(/\[(\d+)\]/g, '[$1]'), value: s.value }))
    .filter((s) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(s.field) && s.value.length <= 60);
}

/** Describe an extractor's selection in words (for chips and hints). */
export function describePick(e: Pick<Extractor, 'path' | 'select'>): string {
  const path = e.path ?? '';
  const filter = /\[\?\((.*)\)\]/.exec(path);
  if (filter) return `${e.select ?? 'first'} item where ${filter[1].replace(/@\./g, '')}`;
  if (path.includes('[*]')) return `${e.select ?? 'first'} item`;
  const p = splitListPath(path);
  return p ? `item #${p.index + 1} of the list` : 'exact value';
}
