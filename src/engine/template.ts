import { createHash, randomUUID, randomInt } from 'node:crypto';
import { parseFilterChain } from './filter-names.js';

export type Vars = Record<string, string>;

const PLACEHOLDER = /\$\{\s*([^}]+?)\s*\}/g;

export class TemplateError extends Error {}

/**
 * Render `${name}` placeholders.
 *  - variables:      ${token}, ${user.username}, ${baseUrl}
 *  - filters:        ${user.email|urlencode}, ${note|json}, ${user.name|base64}, ${user.name|base64|urlencode}, ${token|base64decode}
 *                    (base64 base64url base64utf16 hex urlencode json base64decode base64utf16decode hexdecode urldecode md5 sha1 sha256 sha512 lower upper trim)
 *  - built-ins:      ${$uuid}, ${$timestamp}, ${$timestampSec}, ${$isoDate}, ${$randomInt(1,100)}, ${$vu}, ${$iteration}
 */
export function render(template: string, vars: Vars): string {
  if (!template.includes('${')) return template;
  return template.replace(PLACEHOLDER, (_m, expr: string) => {
    const [name, ...filters] = expr.split('|').map((s) => s.trim());
    let value = resolve(name, vars);
    if (value === undefined) throw new TemplateError(`unresolved variable \${${name}}`);
    return applyFilters(value, filters);
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
  if (name === '$timestampSec') return String(Math.floor(Date.now() / 1000));
  if (name === '$isoDate') return new Date().toISOString();
  const m = /^\$randomInt\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(name);
  if (m) return String(randomInt(Number(m[1]), Number(m[2]) + 1));
  return undefined;
}

const BASE64_TEXT = /^[A-Za-z0-9+/_-]*={0,2}$/;
const HEX_TEXT = /^(?:[0-9a-fA-F]{2})*$/;

/** Decode Base64 (standard or URL-safe, padded or not) to bytes, refusing text that is not Base64 at all. */
function fromBase64(value: string, filter: string): Buffer {
  const text = value.trim();
  if (!BASE64_TEXT.test(text) || text.replace(/=+$/, '').length % 4 === 1) {
    throw new TemplateError(`${filter}: "${text.length > 24 ? `${text.slice(0, 21)}...` : text}" is not valid Base64`);
  }
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function applyFilter(filter: string, value: string): string {
  switch (filter) {
    case 'urlencode':
      return encodeURIComponent(value);
    case 'urldecode':
      try {
        return decodeURIComponent(value);
      } catch {
        throw new TemplateError('urldecode: the value is not valid URL-encoded text');
      }
    case 'json':
      return JSON.stringify(value).slice(1, -1);
    case 'base64':
      return Buffer.from(value, 'utf8').toString('base64');
    case 'base64url':
      return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    case 'base64utf16':
      return Buffer.from(value, 'utf16le').toString('base64');
    case 'base64decode':
      return fromBase64(value, filter).toString('utf8');
    case 'base64utf16decode':
      return fromBase64(value, filter).toString('utf16le');
    case 'hex':
      return Buffer.from(value, 'utf8').toString('hex');
    case 'hexdecode':
      if (!HEX_TEXT.test(value.trim())) throw new TemplateError('hexdecode: the value is not hex digits');
      return Buffer.from(value.trim(), 'hex').toString('utf8');
    case 'md5':
    case 'sha1':
    case 'sha256':
    case 'sha512':
      return createHash(filter).update(value, 'utf8').digest('hex');
    case 'lower':
      return value.toLowerCase();
    case 'upper':
      return value.toUpperCase();
    case 'trim':
      return value.trim();
    default:
      throw new TemplateError(`unknown filter "${filter}"`);
  }
}

/** Apply a chain such as "base64|urlencode" (or an array of filter names) to a value. */
export function applyFilters(value: string, chain: string | string[] | undefined): string {
  const filters = Array.isArray(chain) ? chain : parseFilterChain(chain).filters;
  return filters.reduce((v, f) => applyFilter(f.trim(), v), value);
}
