import type { Extractor } from '../types.js';
import { getPathAll, pickOne } from './jsonpath.js';

export interface ResponseView {
  status: number;
  headers: Headers;
  body: string;
  /** cookies set by this response (name -> value) */
  setCookies: Record<string, string>;
  /** lazily parsed JSON body */
  json?: unknown;
}

function json(res: ResponseView): unknown {
  if (res.json === undefined) {
    try {
      res.json = JSON.parse(res.body);
    } catch {
      res.json = null;
    }
  }
  return res.json;
}

export function runExtractor(ex: Extractor, res: ResponseView): string | undefined {
  switch (ex.from) {
    case 'status':
      return String(res.status);
    case 'header':
      return res.headers.get(ex.name ?? '') ?? undefined;
    case 'cookie':
      return res.setCookies[ex.name ?? ''];
    case 'regex': {
      const m = new RegExp(ex.regex ?? '').exec(res.body);
      return m ? (m[ex.group ?? 1] ?? m[0]) : undefined;
    }
    case 'body': {
      const v = pickOne(getPathAll(json(res), ex.path ?? '$'), ex.select ?? 'first');
      if (v === undefined || v === null) return undefined;
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    default:
      return undefined;
  }
}

export function parseSetCookies(list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list) {
    const first = h.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}
