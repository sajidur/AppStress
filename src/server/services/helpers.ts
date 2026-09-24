import { VirtualUser, type StepTrace } from '../../engine/executor.js';
import { keepEverything } from '../../engine/sampling.js';
import { formatPath, walkLeaves } from '../../engine/jsonpath.js';
import { MetricsCollector } from '../../metrics/collector.js';
import { API_TYPES } from '../../recorder/recorder.js';
import { DEFAULT_CAPTURE, type CaptureSettings, type RecordedExchange, type Recording, type ResponseSample, type TestSettings, type Workflow } from '../../types.js';
import { escapeRegex, parseCsv } from '../../util.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Parse an uploaded users file (.csv or .json array). */
export function parseUsersFile(filename: string, content: string): { columns: string[]; rows: Record<string, string>[] } {
  let rows: Record<string, string>[];
  if (/\.json$/i.test(filename) || /^\s*\[/.test(content)) {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new HttpError(400, 'Invalid JSON users file');
    }
    if (!Array.isArray(data) || data.some((u) => !u || typeof u !== 'object')) throw new HttpError(400, 'JSON users file must be an array of objects');
    rows = data.map((u) => Object.fromEntries(Object.entries(u as object).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])));
  } else {
    rows = parseCsv(content);
  }
  if (!rows.length) throw new HttpError(400, 'The users file has no data rows (a header row plus at least one user is required)');
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (columns.some((c) => !/^[A-Za-z_][\w.-]*$/.test(c))) {
    throw new HttpError(400, `Column names must be simple identifiers (letters, digits, _ . -): ${columns.join(', ')}`);
  }
  return { columns, rows };
}

const SENSITIVE = /pass|secret|token|pin|otp|key/i;

/** Preview rows with sensitive-looking columns masked. */
export function maskRows(rows: Record<string, string>[], columns: string[]): Record<string, string>[] {
  const masked = columns.filter((c) => SENSITIVE.test(c));
  return rows.map((r) => {
    const out = { ...r };
    for (const c of masked) if (out[c]) out[c] = '••••••';
    return out;
  });
}

/**
 * Find which users-file columns were typed during recording: pick the row whose
 * values appear most often in the recorded requests, and map those columns.
 */
export function suggestUserFields(rec: Recording, rows: Record<string, string>[]): Record<string, string> {
  const text = rec.exchanges
    .filter((e) => API_TYPES.includes(e.resourceType))
    .map((e) => `${e.request.url}\n${e.request.postData ?? ''}\n${Object.values(e.request.headers).join('\n')}`)
    .join('\n');
  const variants = (v: string) => [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];
  let best: Record<string, string> = {};
  for (const row of rows.slice(0, 20_000)) {
    const hit: Record<string, string> = {};
    for (const [col, value] of Object.entries(row)) {
      if (value.length >= 3 && variants(value).some((v) => text.includes(v))) hit[col] = value;
    }
    if (Object.keys(hit).length > Object.keys(best).length) best = hit;
  }
  return best;
}

/** Apply run settings (base URL, extra variables) to a workflow. */
export function applySettings(wf: Workflow, s: TestSettings): Workflow {
  return {
    ...wf,
    variables: { ...wf.variables, ...s.variables, ...(s.baseUrl ? { baseUrl: s.baseUrl.replace(/\/+$/, '') } : {}) },
  };
}

/** Execute the workflow once for a single user and return the step traces (no Redis/RabbitMQ needed). */
export async function validateWorkflow(
  wf: Workflow,
  user: Record<string, string>,
  opts: { iterations: number; requestTimeoutMs: number; capture?: CaptureSettings },
): Promise<{ passed: boolean; traces: (StepTrace & { phase: string })[] }> {
  const traces: (StepTrace & { phase: string })[] = [];
  let phase = 'setup';
  const vu = new VirtualUser({
    workflow: wf,
    user,
    vuIndex: 0,
    metrics: new MetricsCollector(),
    requestTimeoutMs: opts.requestTimeoutMs,
    thinkTimeScale: 0,
    shouldStop: () => false,
    sampler: keepEverything(opts.capture ?? DEFAULT_CAPTURE, () => undefined),
    onTrace: (t) => traces.push({ ...t, phase }),
  });
  let passed = await vu.runSetup();
  if (passed) {
    for (let i = 0; i < opts.iterations; i++) {
      phase = `iteration ${i + 1}`;
      if (!(await vu.runIteration(i))) passed = false;
    }
  }
  return { passed: passed && traces.every((t) => !t.error), traces };
}

/* ------------------------------------------------------------------ recorded response samples */


const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a recorded response contained, so the UI can offer real values to bind into later requests. */
export function sampleExchange(ex: RecordedExchange): ResponseSample {
  const res = ex.response;
  const body = res?.body ?? '';
  const sample: ResponseSample = {
    id: ex.id,
    method: ex.request.method,
    url: ex.request.url,
    status: res?.status,
    mimeType: res?.mimeType,
    jsonPaths: [],
    headers: [],
    cookies: [],
    htmlFields: [],
    bodyPreview: body.slice(0, 4000),
    truncated: body.length > 4000,
  };
  if (!res) return sample;

  const t = body.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      let n = 0;
      for (const leaf of walkLeaves(JSON.parse(body))) {
        if (++n > 400) break;
        sample.jsonPaths.push({ path: formatPath(leaf.tokens), value: clip(String(leaf.value)) });
      }
    } catch {
      /* not JSON after all */
    }
  }
  for (const [name, value] of Object.entries(res.headers)) {
    if (name.toLowerCase() === 'set-cookie') continue;
    sample.headers.push({ name: name.toLowerCase(), value: clip(value) });
  }
  for (const line of (res.headers['set-cookie'] ?? '').split('\n')) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) sample.cookies.push({ name: first.slice(0, eq).trim(), value: clip(first.slice(eq + 1).trim()) });
  }
  if (/html/i.test(res.mimeType ?? res.headers['content-type'] ?? '')) {
    for (const tag of body.match(/<input\b[^>]*>/gi) ?? []) {
      const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
      const value = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1];
      if (!name || !value) continue;
      const nameFirst = tag.search(/\bname=/i) < tag.search(/\bvalue=/i);
      const n = escapeRegex(name);
      sample.htmlFields.push({
        name,
        value: clip(value),
        regex: nameFirst ? `<input[^>]*name=["']${n}["'][^>]*value=["']([^"']*)["']` : `<input[^>]*value=["']([^"']*)["'][^>]*name=["']${n}["']`,
      });
    }
    for (const tag of body.match(/<meta\b[^>]*>/gi) ?? []) {
      const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
      const content = /\bcontent=["']([^"']*)["']/i.exec(tag)?.[1];
      if (!name || !content) continue;
      sample.htmlFields.push({ name, value: clip(content), regex: `<meta[^>]*name=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["']` });
    }
    sample.htmlFields = sample.htmlFields.slice(0, 100);
  }
  return sample;
}
