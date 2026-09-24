import { formatPath, walkLeaves, type PathToken } from '../engine/jsonpath.js';
import type { Extractor, RecordedExchange, Recording, Step, Workflow } from '../types.js';
import { escapeRegex } from '../util.js';
import { encodedForms, encodedHits, plainHits, replaceEncodedForms } from './encodings.js';
import { analyzeFlow, type FlowReport } from './flow.js';

export interface BuildOptions {
  name?: string;
  /** hosts to keep (suffix match); default: the start URL's site domain, e.g. example.com (covers www., api., ...) */
  domains?: string[];
  /** legacy switch, only used when resourceTypes is not given: xhr+fetch, plus document when true */
  includeDocuments?: boolean;
  /**
   * Which recorded request types count as part of the test (Playwright resource types:
   * document, xhr, fetch, script, stylesheet, image, font, media, other).
   * Default: document + xhr + fetch.
   */
  resourceTypes?: string[];
  /** regexes; matching URLs are dropped */
  exclude: string[];
  /** literal values typed while recording -> become ${user.<field>} */
  userFields: Record<string, string>;
  minThinkMs: number;
  maxThinkMs: number;
  correlate: boolean;
  /** add a Redis-shared cache (TTL seconds) to the login step */
  cacheLoginTtlSec?: number;
  /** keep analytics / RUM / error-reporting beacons (dropped by default) */
  keepTracking?: boolean;
}

export interface BuildReport {
  kept: number;
  dropped: number;
  correlations: { variable: string; source: string; extractor: string; usedIn: string[] }[];
  userFieldSteps: string[];
  /** values the browser made up itself (request ids, timestamps): they are generated fresh for every call and user */
  generated?: GeneratedValue[];
  /** steps moved to the teardown because they log the user out at the end of the recording */
  teardown?: string[];
  /** users-file values the page sends encoded (Base64, hex, a hash): each user's own value is encoded the same way */
  encoded?: { step: string; field: string; filters: string }[];
  /** where each value flows: which step feeds which, and what is fixed, unused or unexplained */
  flow?: FlowReport;
  /** what was typed into the page while recording, and which requests carried it */
  typed?: TypedTrace[];
}

/** A value typed into a form field while recording, followed to the requests that sent it. */
export interface TypedTrace {
  field: string;
  label?: string;
  type: string;
  /** the typed text (hidden for password fields) */
  value: string;
  /** the users-file column it now comes from */
  column?: string;
  /** steps whose recorded request contained this value (as typed, or encoded) */
  sentIn: string[];
  /** how the page encoded it before sending, when it did not send it as typed (e.g. base64, sha256) */
  encoding?: string[];
}

export interface GeneratedValue {
  kind: 'uuid' | 'timestamp' | 'timestamp-seconds' | 'iso-date';
  step: string;
  /** where it was sent, e.g. header "x-request-id" or body field "clientId" */
  where: string;
  /** the value seen in the recording */
  recorded: string;
  /** variable holding it when the same value is used by later steps */
  variable?: string;
}

const DROP_HEADERS = new Set([
  'host', 'content-length', 'cookie', 'connection', 'accept-encoding', 'user-agent', 'upgrade-insecure-requests',
  'priority', 'if-none-match', 'if-modified-since', 'cache-control', 'pragma', 'keep-alive', 'te', 'dnt',
]);
const STATIC_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|map|webp|avif|mp4|webm|mp3)(\?|$)/i;
/** Types that are static assets by nature: when the user selects them, the file-extension filter must not drop them. */
const ASSET_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'other']);

/** Effective set of request types that become workflow steps. 'xhr' and 'fetch' are always selected together. */
export function effectiveResourceTypes(opts: Pick<BuildOptions, 'resourceTypes' | 'includeDocuments'>): Set<string> {
  const types = new Set((opts.resourceTypes ?? ['xhr', 'fetch', ...(opts.includeDocuments === false ? [] : ['document'])]).map((t) => t.toLowerCase()));
  if (types.has('xhr') || types.has('fetch')) {
    types.add('xhr');
    types.add('fetch');
  }
  return types;
}
const TOKEN_HEADER = /token|csrf|xsrf|auth|session/i;

/**
 * Third-party / telemetry traffic a browser sends while you use an app. It is not
 * part of the application under test, so it is dropped unless keepTracking is set.
 */
export const TRACKING_PATTERNS: RegExp[] = [
  /google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com/i,
  /\/cdn-cgi\/(rum|challenge-platform|trace)|cloudflareinsights\.com/i,
  /hotjar\.(com|io)|clarity\.ms|fullstory\.com|mouseflow\.com|smartlook\.com|logrocket\.(io|com)/i,
  /sentry\.io|\/sentry\/api\/|bugsnag\.com|rollbar\.com|raygun\.io/i,
  /nr-data\.net|newrelic\.com|datadoghq\.(com|eu)|browser-intake|dynatrace|appdynamics|elastic-apm/i,
  /segment\.(io|com)|mixpanel\.com|amplitude\.com|heap(analytics)?\.(io|com)|posthog\.com|plausible\.io|matomo|piwik/i,
  /facebook\.(com|net)\/tr|connect\.facebook\.net|linkedin\.com\/(li|px)|snap\.licdn\.com|bat\.bing\.com|tiktok\.com\/i18n\/pixel/i,
  /intercom\.io|intercomcdn|zendesk\.com|drift\.com|crisp\.chat|tawk\.to|hubspot\.com|hs-analytics|optimizely\.com|launchdarkly\.com/i,
  /\/(collect|beacon|telemetry|rum|analytics|track|tracking|pixel)(\/|\?|$)/i,
  /\/favicon\.ico|\/sockjs-node|\/__webpack_hmr|\/@vite\/|hot-update/i,
];

const MULTI_PART_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne)\.[a-z]{2}$/i;

/** Registrable site domain, e.g. app.shop.example.co.uk -> example.co.uk (heuristic, no PSL). */
export function siteDomain(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || !hostname.includes('.')) return hostname; // IP / localhost
  return hostname.split('.').slice(MULTI_PART_TLD.test(hostname) ? -3 : -2).join('.');
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EPOCH_MS_RE = /(?<![\d.])\d{13}(?![\d])/g;
const EPOCH_S_RE = /(?<![\d.])\d{10}(?![\d.])/g;
const ISO_RE = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z\b/g;
/** names of headers / fields that carry an id the client makes up for every request */
const CLIENT_ID_KEY = /(request|correlation|trace|idempotenc|nonce|txn|transaction|operation|client|external|reference|uuid|guid|uid|event|message|batch)[-_ ]?(id|key|token)?$/i;

/** A request that ends the session: /Account/LogOff, /api/auth/logout, /signout.aspx ... */
const LOGOUT = /(^|[/._-])(log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off)([/._?-]|$)/i;
const pathOnly = (url: string) => url.replace(/^\$\{[^}]+\}/, '').split('?')[0];

/** Apply fn to the parts of a text that are not ${placeholders}. */
const literalParts = (text: string, fn: (part: string) => string) => text.split(/(\$\{[^}]*\})/).map((s, i) => (i % 2 ? s : fn(s))).join('');

/** Variable name for a secondary origin: https://api.example.com -> apiUrl */
function originVar(origin: string, used: Set<string>): string {
  const label = camel(new URL(origin).hostname.split('.')[0]);
  const base = /^[A-Za-z]/.test(label) && label !== 'www' ? `${label}Url` : 'hostUrl';
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}${n}`;
  used.add(name);
  return name;
}

const ID_KEY = /id$/i;

interface Candidate {
  value: string;
  stepIdx: number;
  extractor: Omit<Extractor, 'var'>;
  /** last object key (hint for naming and short-value matching) */
  key: string;
  parentKey?: string;
  short: boolean;
}

/**
 * Turn a raw browser recording into an executable API workflow:
 *   1. keep document/xhr/fetch calls on the target domains, drop static assets & noise headers
 *   2. replace origins with ${baseUrl} / ${apiUrl} ... and typed credentials with ${user.<field>}
 *   3. correlate dynamic values: any value from an earlier response (JSON field, token header,
 *      cookie, hidden form field) that is re-sent later becomes an extractor + ${variable}
 *   4. derive think times from gaps between user actions and split setup (login) from steps
 */
export function buildWorkflow(rec: Recording, opts: BuildOptions): { workflow: Workflow; report: BuildReport } {
  const origin = new URL(rec.startUrl).origin;
  const domains = opts.domains?.length ? opts.domains : [siteDomain(new URL(rec.startUrl).hostname)];
  const exclude = opts.exclude.map((r) => new RegExp(r, 'i'));
  const allowedTypes = effectiveResourceTypes(opts);

  const kept = rec.exchanges.filter((ex) => {
    if (!ex.response || ex.failure) return false;
    if (!/^https?:/i.test(ex.request.url) || ex.request.method === 'OPTIONS') return false;
    if (!allowedTypes.has(ex.resourceType)) return false;
    const u = new URL(ex.request.url);
    if (!domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) return false;
    if (!ASSET_TYPES.has(ex.resourceType) && STATIC_EXT.test(u.pathname)) return false;
    if (!opts.keepTracking && TRACKING_PATTERNS.some((r) => r.test(ex.request.url))) return false;
    return !exclude.some((r) => r.test(ex.request.url));
  });

  // One variable per origin: ${baseUrl} for the start origin, e.g. ${apiUrl} for api.example.com,
  // so the whole test can be pointed at another environment.
  const originVars = new Map<string, string>([[origin, 'baseUrl']]);
  const originNames = new Set(['baseUrl']);
  for (const ex of kept) {
    const o = new URL(ex.request.url).origin;
    if (!originVars.has(o)) originVars.set(o, originVar(o, originNames));
  }
  const byLength = [...originVars].sort((a, b) => b[0].length - a[0].length);
  const withOriginVars = (text: string) => byLength.reduce((t, [o, v]) => t.split(o).join('${' + v + '}'), text);

  const userFields = { ...(rec.userFields ?? {}), ...opts.userFields };
  const userEntries = Object.entries(userFields)
    .filter(([, v]) => v !== '')
    .sort((a, b) => b[1].length - a[1].length);

  const steps: Step[] = [];
  const report: BuildReport = { kept: kept.length, dropped: rec.exchanges.length - kept.length, correlations: [], userFieldSteps: [] };
  const longCandidates = new Map<string, Candidate>();
  const shortCandidates = new Map<string, Candidate[]>();
  const varNames = new Set(originNames);
  const varForCandidate = new Map<string, string>();
  const correlationByVar = new Map<string, BuildReport['correlations'][number]>();
  const stepNames = new Map<string, number>();
  /** client-made ids already turned into a variable (so later requests reuse the same value) */
  const uuidVars = new Map<string, string>();
  /** did an earlier response already contain this value? then it comes from the server, not from the browser */
  const seenInResponse = (needle: string, at: RecordedExchange) => {
    const n = needle.toLowerCase();
    return rec.exchanges.some((e) => e !== at && e.startedAt <= at.startedAt && ((e.response?.body?.toLowerCase().includes(n) ?? false) || Object.values(e.response?.headers ?? {}).some((h) => h.toLowerCase().includes(n))));
  };
  const stepOfExchange = new Map<number, string>();
  let rawRequestsSoFar = '';
  let lastUserStep = -1;
  let prevEnd = kept[0]?.startedAt ?? 0;

  const varFor = (c: Candidate, usedInStep: string): string => {
    const sig = `${c.stepIdx}|${JSON.stringify(c.extractor)}`;
    let name = varForCandidate.get(sig);
    if (!name) {
      name = uniqueName(varNames, suggestName(c));
      varForCandidate.set(sig, name);
      const source = steps[c.stepIdx];
      (source.extract ??= []).push({ var: name, ...c.extractor });
      const corr = { variable: name, source: source.name, extractor: describe(c.extractor), usedIn: [] as string[] };
      correlationByVar.set(name, corr);
      report.correlations.push(corr);
    }
    const corr = correlationByVar.get(name)!;
    if (!corr.usedIn.includes(usedInStep)) corr.usedIn.push(usedInStep);
    return name;
  };

  kept.forEach((ex, i) => {
    const rawReq = `${ex.request.url}\n${JSON.stringify(ex.request.headers)}\n${ex.request.postData ?? ''}`;
    const reqOrigin = new URL(ex.request.url).origin;
    let url = '${' + originVars.get(reqOrigin) + '}' + ex.request.url.slice(reqOrigin.length);
    const headers = filterHeaders(ex.request.headers, withOriginVars);
    let body = ex.request.postData;
    const isForm = /x-www-form-urlencoded/i.test(ex.request.headers['content-type'] ?? '');
    const isJson = /json/i.test(ex.request.headers['content-type'] ?? '') || looksLikeJson(body);
    const pendingName = provisionalName(ex, origin);

    // --- correlation of dynamic values from earlier responses
    if (opts.correlate) {
      // long values: substring replacement anywhere (tokens, UUIDs, JWTs, CSRF)
      const longs = [...longCandidates.values()].sort((a, b) => b.value.length - a.value.length);
      for (const c of longs) {
        const enc = encodeURIComponent(c.value);
        const hit =
          url.includes(c.value) ||
          (enc !== c.value && url.includes(enc)) ||
          (body?.includes(c.value) ?? false) ||
          (isForm && enc !== c.value && (body?.includes(enc) ?? false)) ||
          Object.values(headers).some((h) => h.includes(c.value));
        if (!hit) continue;
        const v = varFor(c, pendingName);
        url = replaceAll(url, c.value, `\${${v}}`);
        if (enc !== c.value) url = replaceAll(url, enc, `\${${v}|urlencode}`);
        if (body !== undefined) {
          if (isForm && enc !== c.value) body = replaceAll(body, enc, `\${${v}|urlencode}`);
          body = replaceAll(body, c.value, `\${${v}}`);
        }
        for (const k of Object.keys(headers)) headers[k] = replaceAll(headers[k], c.value, `\${${v}}`);
      }
    }

    // --- user credentials / typed data -> ${user.field}
    // Only the text that is still literal: a value that was just linked to an earlier response (a token that happens to
    // contain the user name, say) must stay linked to that response.
    let usesUser = false;
    // First the values the page sent encoded (Base64 of the user name, a hashed password): they must be recognised
    // before the plain values, which could otherwise match by chance inside the encoded text.
    const encodedNotes: { field: string; filters: string }[] = [];
    for (const [field, value] of userEntries) {
      const forms = encodedForms(value);
      if (!forms.length) continue;
      const used = new Set<string>();
      url = literalParts(url, (p) => replaceEncodedForms(p, field, forms, used));
      if (body !== undefined) body = literalParts(body, (p) => replaceEncodedForms(p, field, forms, used));
      for (const k of Object.keys(headers)) headers[k] = literalParts(headers[k], (p) => replaceEncodedForms(p, field, forms, used));
      for (const filters of used) encodedNotes.push({ field, filters });
    }
    if (encodedNotes.length) usesUser = true;
    for (const [field, value] of userEntries) {
      const ph = `\${user.${field}}`;
      const enc = encodeURIComponent(value);
      const formEnc = new URLSearchParams({ v: value }).toString().slice(2);
      const before = url + JSON.stringify(headers) + (body ?? '');
      url = literalParts(url, (p) => {
        const out = replaceAll(p, value, ph);
        return enc !== value ? replaceAll(out, enc, `\${user.${field}|urlencode}`) : out;
      });
      if (body !== undefined) {
        body = literalParts(body, (p) => {
          const out = isForm && formEnc !== value ? replaceAll(p, formEnc, `\${user.${field}|urlencode}`) : p;
          return replaceAll(out, value, isJson ? `\${user.${field}|json}` : ph);
        });
      }
      for (const k of Object.keys(headers)) headers[k] = literalParts(headers[k], (p) => replaceAll(p, value, ph));
      if (before !== url + JSON.stringify(headers) + (body ?? '')) usesUser = true;
    }
    if (usesUser) lastUserStep = i;

    if (opts.correlate) {
      // short values (numeric ids etc.): only in structured positions with an id-like key
      url = correlateUrlIds(url, shortCandidates, (c) => varFor(c, pendingName));
      if (body !== undefined && isJson) body = correlateJsonIds(body, shortCandidates, (c) => varFor(c, pendingName));
      if (body !== undefined && isForm) body = correlateFormIds(body, shortCandidates, (c) => varFor(c, pendingName));
    }

    // --- values the browser generated by itself: ids made up per request, and the current time
    const set: Record<string, string> = {};
    const generalize = (text: string, where: string, key?: string): string =>
      literalParts(text, (part) => {
        let out = part;
        // a made-up id: sent by the client, never seen in any earlier response, in a header or field meant for such ids
        out = out.replace(UUID_RE, (m, offset: number) => {
          const k = key ?? /["']?([\w-]+)["']?\s*[:=]\s*["']?$/.exec(part.slice(0, offset))?.[1];
          const known = uuidVars.get(m.toLowerCase());
          if (known) return '${' + known + '}';
          if (!k || !CLIENT_ID_KEY.test(k) || seenInResponse(m, ex)) return m;
          const v = uniqueName(varNames, camel(k));
          uuidVars.set(m.toLowerCase(), v);
          set[v] = '${$uuid}';
          (report.generated ??= []).push({ kind: 'uuid', step: pendingName, where: where.startsWith('header') ? where : `field "${k}"`, recorded: m, variable: v });
          return '${' + v + '}';
        });
        if (ex.startedAt > 1e12) {
          const near = (ms: number) => Math.abs(ms - ex.startedAt) <= 10 * 60 * 1000;
          out = out.replace(EPOCH_MS_RE, (m) => (near(Number(m)) ? note('timestamp', m, where, '${$timestamp}') : m));
          out = out.replace(EPOCH_S_RE, (m) => (near(Number(m) * 1000) ? note('timestamp-seconds', m, where, '${$timestampSec}') : m));
          out = out.replace(ISO_RE, (m) => (near(Date.parse(m)) ? note('iso-date', m, where, '${$isoDate}') : m));
        }
        return out;
      });
    const note = (kind: GeneratedValue['kind'], recorded: string, where: string, replacement: string) => {
      (report.generated ??= []).push({ kind, step: pendingName, where, recorded });
      return replacement;
    };
    url = generalize(url, 'URL');
    for (const k of Object.keys(headers)) headers[k] = generalize(headers[k], `header "${k}"`, k);
    if (body !== undefined) body = generalize(body, 'body');

    // --- think time from the pause before this request
    const gap = ex.startedAt - prevEnd;
    const thinkTimeMs = i > 0 && gap >= opts.minThinkMs ? Math.round(Math.min(gap, opts.maxThinkMs) / 100) * 100 : 0;
    prevEnd = Math.max(prevEnd, ex.startedAt + ex.durationMs);

    const step: Step = {
      name: uniqueStepName(stepNames, stepName(ex.request.method, url)),
      group: pageGroup(ex, origin),
      resourceType: ex.resourceType,
      sourceId: ex.id,
      request: {
        method: ex.request.method,
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
      },
      ...(Object.keys(set).length ? { set } : {}),
      ...(thinkTimeMs ? { thinkTimeMs } : {}),
    };
    // fix up usage bookkeeping with the final name
    for (const corr of report.correlations) {
      const idx = corr.usedIn.indexOf(pendingName);
      if (idx >= 0) corr.usedIn[idx] = step.name;
    }
    for (const g of report.generated ?? []) if (g.step === pendingName) g.step = step.name;
    for (const n of encodedNotes) (report.encoded ??= []).push({ step: step.name, ...n });
    if (usesUser) report.userFieldSteps.push(step.name);
    steps.push(step);
    stepOfExchange.set(ex.id, step.name);

    // --- harvest candidates from this response for later requests
    rawRequestsSoFar += rawReq;
    if (opts.correlate) harvest(ex, i, rawRequestsSoFar, userEntries.map(([, v]) => v), longCandidates, shortCandidates);
  });

  if (opts.cacheLoginTtlSec && lastUserStep >= 0) {
    const login = steps[lastUserStep];
    const vars = (login.extract ?? []).map((e) => e.var);
    const firstField = userEntries.at(-1)?.[0] ?? Object.keys(userFields)[0];
    if (vars.length) login.cache = { key: `auth:\${user.${firstField}}`, ttlSec: opts.cacheLoginTtlSec, vars };
  }

  // A logout at the end of the recording ends the user's session: it belongs to the teardown, not to every iteration.
  const teardown: Step[] = [];
  while (steps.length > 1 && LOGOUT.test(pathOnly(steps[steps.length - 1].request.url))) teardown.unshift(steps.pop()!);
  if (teardown.length) report.teardown = teardown.map((t) => t.name);

  let setup = lastUserStep >= 0 ? steps.slice(0, lastUserStep + 1) : [];
  let main = lastUserStep >= 0 ? steps.slice(lastUserStep + 1) : steps;
  if (!main.length) {
    main = steps;
    setup = [];
  }

  const workflow: Workflow = {
    name: opts.name ?? `Recorded flow ${new URL(rec.startUrl).hostname}`,
    variables: Object.fromEntries([...originVars].map(([o, v]) => [v, o])),
    defaults: {
      headers: { 'user-agent': rec.userAgent ?? kept[0]?.request.headers['user-agent'] ?? 'distributed-load-tester' },
    },
    setup,
    steps: main,
    ...(teardown.length ? { teardown } : {}),
    onError: 'abortIteration',
  };

  // follow what the user typed while recording to the requests that carried it
  report.flow = analyzeFlow(workflow);
  report.typed = (rec.typedInputs ?? []).map((t) => {
    const plain = plainHits(kept, t.value);
    const encoded = encodedHits(kept, t.value);
    // in the order the requests were made
    const sentIn = [...new Set([...new Set([...plain, ...encoded.map((e) => e.k)])].sort((a, b) => a.id - b.id).map((k) => stepOfExchange.get(k.id)!))];
    const encoding = [...new Set(encoded.map((e) => e.filters))];
    const column = Object.entries(userFields).find(([, v]) => v === t.value)?.[0];
    const shown = t.label || t.field;
    if (!sentIn.length && t.value.length >= 3) {
      report.flow!.issues.unshift({
        level: 'warn',
        kind: 'encrypted',
        message: `You typed a value into "${shown}" but it is not in any recorded request, not even Base64, hex or hashed. The page probably encrypts it with a key or a salt.`,
        hint: 'The test then cannot send the users-file value as it is. It needs the same transformation the page applies, or a server-side option that accepts plain values.',
      });
    } else if (!plain.length && encoded.length && t.value.length >= 3) {
      report.flow!.issues.push({
        level: 'info',
        kind: 'encoded',
        message: `"${shown}" is sent encoded (${encoding.join(', ')}). Each user's own value is encoded the same way.`,
        hint: column ? `\${user.${column}|${encoding[0]}}` : 'Map the field to a users-file column so every user sends their own.',
      });
    }
    return { field: t.field, label: t.label, type: t.type, value: t.type === 'password' ? '••••••' : t.value, column, sentIn, ...(encoding.length && !plain.length ? { encoding } : {}) };
  });
  return { workflow, report };
}

/* ------------------------------------------------------------------ harvesting */

function harvest(
  ex: RecordedExchange,
  stepIdx: number,
  rawRequests: string,
  userValues: string[],
  longs: Map<string, Candidate>,
  shorts: Map<string, Candidate[]>,
) {
  const res = ex.response!;
  const addLong = (value: string, extractor: Candidate['extractor'], key: string, parentKey?: string) => {
    if (!isLongDynamic(value) || userValues.includes(value) || rawRequests.includes(value)) return;
    longs.set(value, { value, stepIdx, extractor, key, parentKey, short: false });
  };

  // JSON body fields
  const body = res.body;
  if (body && looksLikeJson(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    let count = 0;
    for (const leaf of walkLeaves(parsed)) {
      if (++count > 5000) break;
      const tokens = leaf.tokens;
      const key = lastKey(tokens);
      const parentKey = lastKey(tokens.slice(0, tokens.lastIndexOf(key)));
      const value = String(leaf.value);
      const extractor = { from: 'body' as const, path: formatPath(tokens) };
      if (isLongDynamic(value)) addLong(value, extractor, key, parentKey);
      else if (ID_KEY.test(key) && value !== '' && !/\s/.test(value) && value.length <= 40) {
        const list = shorts.get(value) ?? [];
        // keep the latest candidate for the same key/parent at the front
        list.unshift({ value, stepIdx, extractor, key, parentKey, short: true });
        shorts.set(value, list.slice(0, 20));
      }
    }
  }

  // Token-like response headers
  for (const [name, value] of Object.entries(res.headers)) {
    if (name === 'set-cookie' || !TOKEN_HEADER.test(name)) continue;
    addLong(value, { from: 'header', name }, name);
  }

  // Cookies whose value is re-sent outside the Cookie header (e.g. XSRF-TOKEN -> X-XSRF-TOKEN)
  for (const line of (res.headers['set-cookie'] ?? '').split('\n')) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      addLong(decodeURIComponent(first.slice(eq + 1).trim()), { from: 'cookie', name }, name);
    }
  }

  // HTML hidden inputs and <meta name="csrf-token" content="...">
  if (body && /html/i.test(res.mimeType ?? res.headers['content-type'] ?? '')) {
    for (const tag of body.match(/<input\b[^>]*>/gi) ?? []) {
      const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
      const value = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1];
      if (!name || !value) continue;
      const nameFirst = tag.search(/\bname=/i) < tag.search(/\bvalue=/i);
      const n = escapeRegex(name);
      const regex = nameFirst
        ? `<input[^>]*name=["']${n}["'][^>]*value=["']([^"']*)["']`
        : `<input[^>]*value=["']([^"']*)["'][^>]*name=["']${n}["']`;
      addLong(value, { from: 'regex', regex, group: 1 }, name);
    }
    for (const tag of body.match(/<meta\b[^>]*>/gi) ?? []) {
      const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
      const content = /\bcontent=["']([^"']*)["']/i.exec(tag)?.[1];
      if (!name || !content || !TOKEN_HEADER.test(name)) continue;
      addLong(content, { from: 'regex', regex: `<meta[^>]*name=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["']`, group: 1 }, name);
    }
  }
}

/** Heuristic for values worth correlating by plain substring match. */
function isLongDynamic(v: string): boolean {
  if (v.length < 8 || v.length > 4096 || /\s/.test(v)) return false;
  if (/^(true|false|null|undefined)$/i.test(v)) return false;
  if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(v)) return false; // mime types
  if (/^https?:\/\//i.test(v) && !/[?&=]/.test(v)) return false; // plain links
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return false; // dates
  return /\d/.test(v) || v.length >= 20;
}

/* ------------------------------------------------------------------ short id correlation */

function pickShort(list: Candidate[] | undefined, hint: string): Candidate | undefined {
  if (!list?.length) return undefined;
  const h = hint.toLowerCase();
  const score = (c: Candidate) => {
    const key = c.key.toLowerCase();
    const parent = singular(c.parentKey ?? '').toLowerCase();
    if (key === h) return 3;
    if (key === 'id' && parent && (h === `${parent}id` || h === `${parent}_id` || singular(h) === parent)) return 2;
    return 0;
  };
  let best: Candidate | undefined;
  let bestScore = -1;
  for (const c of list) {
    const s = score(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  // require some key affinity unless there is a single unambiguous candidate
  return bestScore > 0 || list.length === 1 ? best : undefined;
}

function correlateUrlIds(url: string, shorts: Map<string, Candidate[]>, varFor: (c: Candidate) => string): string {
  const qIndex = url.indexOf('?');
  const pathPart = qIndex >= 0 ? url.slice(0, qIndex) : url;
  const query = qIndex >= 0 ? url.slice(qIndex + 1) : undefined;

  const segs = pathPart.split('/');
  // skip scheme/host/${baseUrl} segments and the first path segment
  const firstPathSeg = pathPart.startsWith('${') ? 1 : 3;
  for (let i = firstPathSeg + 1; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg || seg.includes('${')) continue;
    const c = pickShort(shorts.get(decodeURIComponent(seg)), segs[i - 1] ?? '');
    if (c) segs[i] = `\${${varFor(c)}}`;
  }
  let out = segs.join('/');
  if (query !== undefined) {
    const parts = query.split('&').map((p) => {
      const eq = p.indexOf('=');
      if (eq <= 0) return p;
      const k = p.slice(0, eq);
      const v = p.slice(eq + 1);
      if (!ID_KEY.test(k) || v.includes('${')) return p;
      const c = pickShort(shorts.get(decodeURIComponent(v)), k);
      return c ? `${k}=\${${varFor(c)}|urlencode}` : p;
    });
    out += '?' + parts.join('&');
  }
  return out;
}

function correlateJsonIds(body: string, shorts: Map<string, Candidate[]>, varFor: (c: Candidate) => string): string {
  if (!shorts.size) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // body already contains placeholders or is not JSON
  }
  const replacements: { sentinel: string; placeholder: string; numeric: boolean }[] = [];
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if ((typeof v === 'number' || typeof v === 'string') && ID_KEY.test(k)) {
          const c = pickShort(shorts.get(String(v)), k);
          if (c) {
            const sentinel = `__LT_${replacements.length}__`;
            replacements.push({ sentinel, placeholder: `\${${varFor(c)}}`, numeric: typeof v === 'number' });
            out[k] = sentinel;
            continue;
          }
        }
        out[k] = visit(v);
      }
      return out;
    }
    return node;
  };
  const rewritten = visit(parsed);
  if (!replacements.length) return body;
  let text = JSON.stringify(rewritten);
  for (const r of replacements) {
    text = text.replace(`"${r.sentinel}"`, r.numeric ? r.placeholder : `"${r.placeholder}"`);
  }
  return text;
}

function correlateFormIds(body: string, shorts: Map<string, Candidate[]>, varFor: (c: Candidate) => string): string {
  return body
    .split('&')
    .map((p) => {
      const eq = p.indexOf('=');
      if (eq <= 0) return p;
      const k = decodeURIComponent(p.slice(0, eq));
      const v = p.slice(eq + 1);
      if (!ID_KEY.test(k) || v.includes('${')) return p;
      const c = pickShort(shorts.get(decodeURIComponent(v.replace(/\+/g, ' '))), k);
      return c ? `${p.slice(0, eq)}=\${${varFor(c)}|urlencode}` : p;
    })
    .join('&');
}

/* ------------------------------------------------------------------ helpers */

function filterHeaders(headers: Record<string, string>, withOriginVars: (s: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawK, v] of Object.entries(headers)) {
    const k = rawK.toLowerCase();
    if (k.startsWith(':') || k.startsWith('sec-') || DROP_HEADERS.has(k)) continue;
    out[k] = withOriginVars(v);
  }
  return out;
}

function replaceAll(s: string, find: string, repl: string): string {
  return find && s.includes(find) ? s.split(find).join(repl) : s;
}

function looksLikeJson(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

function lastKey(tokens: PathToken[]): string {
  for (let i = tokens.length - 1; i >= 0; i--) if (typeof tokens[i] === 'string') return tokens[i] as string;
  return '';
}

function singular(s: string): string {
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(ss|us)$/i.test(s)) return s;
  if (/s$/i.test(s)) return s.slice(0, -1);
  return s;
}

function camel(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
  return /^[A-Za-z_]/.test(out) ? out : `v${out}`;
}

function suggestName(c: Candidate): string {
  if (c.extractor.from === 'header' || c.extractor.from === 'cookie' || c.extractor.from === 'regex') return camel(c.key) || 'value';
  if (/^id$/i.test(c.key) && c.parentKey) return camel(`${singular(c.parentKey)}_id`);
  return camel(c.key) || 'value';
}

function uniqueName(used: Set<string>, base: string): string {
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}${n}`;
  used.add(name);
  return name;
}

function stepName(method: string, url: string): string {
  const path = url.replace('${baseUrl}', '').split('?')[0] || '/';
  return `${method.toUpperCase()} ${path}`;
}

function provisionalName(ex: RecordedExchange, origin: string): string {
  return `#${ex.id} ${stepName(ex.request.method, ex.request.url.replace(origin, ''))}`;
}

function uniqueStepName(used: Map<string, number>, base: string): string {
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base} #${n}`;
}

function pageGroup(ex: RecordedExchange, origin: string): string | undefined {
  const page = ex.resourceType === 'document' ? ex.request.url : ex.pageUrl;
  if (!page) return undefined;
  try {
    const u = new URL(page);
    return u.origin === origin ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return page;
  }
}

function describe(e: Candidate['extractor']): string {
  if (e.from === 'body') return `body ${e.path}`;
  if (e.from === 'regex') return `regex ${e.regex}`;
  return `${e.from} ${e.name}`;
}
