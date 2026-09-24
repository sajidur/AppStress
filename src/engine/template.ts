import { randomUUID, randomInt } from 'node:crypto';

export type Vars = Record<string, string>;

const PLACEHOLDER = /\$\{\s*([^}]+?)\s*\}/g;

export class TemplateError extends Error {}

/**
 * Render `${name}` placeholders.
 *  - variables:      ${token}, ${user.username}, ${baseUrl}
 *  - filters:        ${user.email|urlencode}, ${note|json}, ${id|base64}
 *  - built-ins:      ${$uuid}, ${$timestamp}, ${$isoDate}, ${$randomInt(1,100)}, ${$vu}, ${$iteration}
 */
export function render(template: string, vars: Vars): string {
  if (!template.includes('${')) return template;
  return template.replace(PLACEHOLDER, (_m, expr: string) => {
    const [name, ...filters] = expr.split('|').map((s) => s.trim());
    let value = resolve(name, vars);
    if (value === undefined) throw new TemplateError(`unresolved variable \${${name}}`);
    for (const f of filters) value = applyFilter(f, value);
    return value;
  });
}

export function renderRecord(rec: Record<string, string> | undefined, vars: Vars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec ?? {})) out[k] = render(v, vars);
  return out;
}

function resolve(name: string, vars: Vars): string | undefined {
  if (name in vars) return vars[name];
  if (!name.startsWith('$')) return undefined;
  if (name === '$uuid') return randomUUID();
  if (name === '$timestamp') return String(Date.now());
  if (name === '$isoDate') return new Date().toISOString();
  const m = /^\$randomInt\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(name);
  if (m) return String(randomInt(Number(m[1]), Number(m[2]) + 1));
  return undefined;
}

function applyFilter(filter: string, value: string): string {
  switch (filter) {
    case 'urlencode':
      return encodeURIComponent(value);
    case 'json':
      return JSON.stringify(value).slice(1, -1);
    case 'base64':
      return Buffer.from(value).toString('base64');
    case 'lower':
      return value.toLowerCase();
    case 'upper':
      return value.toUpperCase();
    default:
      throw new TemplateError(`unknown filter "${filter}"`);
  }
}
