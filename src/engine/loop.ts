import type { LoopSpec } from '../types.js';

/** Steps with the same list and name belong to one loop body: they run once per item, one after another. */
export function sameLoop(a: LoopSpec | undefined, b: LoopSpec | undefined): boolean {
  return !!a && !!b && a.list === b.list && a.as === b.as;
}

const MAX_ITEMS = 10_000;
const DEFAULT_MAX_ITEMS = 1_000;
const MAX_DEPTH = 3;

/** The items to loop over, from the variable that holds the list (a JSON array). A string is the reason it cannot be done. */
export function loopItems(raw: string | undefined, spec: LoopSpec, random: () => number = Math.random): unknown[] | string {
  if (raw === undefined) return `loop over \${${spec.list}}: no earlier step saved a list with that name`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `loop over \${${spec.list}}: the value is not a list (it is "${raw.length > 40 ? `${raw.slice(0, 37)}...` : raw}")`;
  }
  let items = Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed];
  if (spec.order === 'random') {
    items = [...items];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }
  return items.slice(0, Math.min(spec.max && spec.max > 0 ? spec.max : DEFAULT_MAX_ITEMS, MAX_ITEMS));
}

const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The variables one item of a loop defines: ${as} (the value, or the whole object as JSON), ${as.field} for its fields
 * (nested ones as ${as.address.city}), ${as.$index} (from 0) and ${as.$count}.
 */
export function itemVars(as: string, item: unknown, index: number, count: number): Record<string, string> {
  const out: Record<string, string> = { [as]: text(item), [`${as}.$index`]: String(index), [`${as}.$count`]: String(count) };
  const walk = (value: unknown, path: string, depth: number) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < MAX_DEPTH) {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, depth + 1);
    } else if (path !== as) out[path] = text(value);
  };
  if (item && typeof item === 'object' && !Array.isArray(item)) walk(item, as, 0);
  return out;
}

/** Names that hold an item of the loop, to clear them before the next item is set. */
export const isItemVar = (name: string, as: string) => name === as || name.startsWith(`${as}.`);
