import { readFileSync } from 'node:fs';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Sleep in small slices so a stop signal can interrupt long waits. */
export async function sleepInterruptible(ms: number, shouldStop: () => boolean, sliceMs = 250): Promise<void> {
  const until = Date.now() + ms;
  while (!shouldStop()) {
    const left = until - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(left, sliceMs));
  }
}

export function log(scope: string, ...args: unknown[]) {
  console.log(`${new Date().toISOString()} [${scope}]`, ...args);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${e.message}: ${cause.message}`;
    return e.message;
  }
  return String(e);
}

/** Parse `k=v` pairs given as repeated CLI options. */
export function parseKeyValues(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`Expected key=value, got "${item}"`);
    out[item.slice(0, i).trim()] = item.slice(i + 1);
  }
  return out;
}

export const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else field += c;
  }
  if (field !== '' || row.length) pushRow();
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.replace(/^﻿/, '').trim());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Load users from .csv or .json (array of objects). */
export function loadUsers(file: string): Record<string, string>[] {
  const text = readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error(`${file} must contain a JSON array`);
    return data.map((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, String(v)])));
  }
  return parseCsv(text);
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
