/** ---------- Recording (output of the Playwright recorder or a HAR import) ---------- */

export interface RecordedExchange {
  id: number;
  /** epoch ms when the request started */
  startedAt: number;
  durationMs: number;
  /** URL of the page (main frame) when the request was issued */
  pageUrl: string;
  /** Playwright resource type: document, xhr, fetch, script, ... */
  resourceType: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    postData?: string;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    mimeType?: string;
  };
  failure?: string;
}

export interface Recording {
  version: 1;
  startUrl: string;
  recordedAt: string;
  userAgent?: string;
  navigations: { url: string; at: number }[];
  exchanges: RecordedExchange[];
  /** Literal values typed during recording that should become ${user.<field>} */
  userFields?: Record<string, string>;
  /** what the user typed into the page's input fields while recording (which field, which value) */
  typedInputs?: TypedInput[];
}

/** A value typed into a form field of the page during recording. */
export interface TypedInput {
  /** epoch ms */
  at: number;
  /** the field's name or id */
  field: string;
  /** its visible label, placeholder or aria-label */
  label?: string;
  /** input type: text, password, email, ... */
  type: string;
  value: string;
  page: string;
}

/** What a recorded response contained: values a later request can bind to. Served to the workflow editor. */
export interface ResponseSample {
  id: number;
  method: string;
  url: string;
  status?: number;
  mimeType?: string;
  /** JSON leaves (strings / numbers) that can be extracted with a JSON path */
  jsonPaths: { path: string; value: string }[];
  /** response headers (lower-cased names) that can be extracted */
  headers: { name: string; value: string }[];
  /** cookies set by the response */
  cookies: { name: string; value: string }[];
  /** hidden form fields / csrf meta tags found in an HTML response, with a ready-made regex */
  htmlFields: { name: string; value: string; regex: string }[];
  bodyPreview: string;
  truncated: boolean;
}

/** ---------- Workflow (what the engine executes) ---------- */

export type ExtractorSource = 'body' | 'header' | 'cookie' | 'regex' | 'status';

export interface Extractor {
  var: string;
  from: ExtractorSource;
  /** JSON path for from=body, e.g. $.data.items[0].id */
  path?: string;
  /** header/cookie name for from=header|cookie */
  name?: string;
  /** regex for from=regex (applied to the body) */
  regex?: string;
  group?: number;
  optional?: boolean;
  /** when the JSON path matches several values (a [*] wildcard or a [?(...)] condition): which one to take. Default: first */
  select?: 'first' | 'last' | 'random';
  /** used when nothing matches instead of failing the step; may contain ${templates}. Empty string is allowed */
  default?: string;
  /** filters applied to the value once it is read, e.g. "base64decode" or "base64decode|lower" */
  transform?: string;
}

export interface StepRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Step {
  name: string;
  /** logical page / transaction the step belongs to */
  group?: string;
  /** Playwright resource type the request was recorded as (document, xhr, fetch, script, ...) */
  resourceType?: string;
  /** id of the recorded exchange this step came from (lets the UI show the recorded response) */
  sourceId?: number;
  /** do not add the workflow-level authentication to this step (e.g. the login call itself) */
  skipAuth?: boolean;
  /**
   * Variables computed once before this step's request is built, e.g. {"requestId": "${$uuid}"}.
   * Later steps can use them too, so a client-generated id can be sent in several calls.
   */
  set?: Record<string, string>;
  request: StepRequest;
  extract?: Extractor[];
  expect?: { status?: number[]; bodyContains?: string };
  /** pause before this step (recorded user think time) */
  thinkTimeMs?: number;
  /**
   * Share the extracted vars through Redis. When the key already exists the step
   * is skipped and the cached vars are used (e.g. share one login token per user
   * across all workers).
   */
  cache?: { key: string; ttlSec: number; vars: string[] };
}

/**
 * Authentication added to every request. Values are templates (${token}, ${user.password}, ...).
 * If a referenced variable is not available yet (e.g. before the login step ran), the request is sent
 * without it. A step that sets its own Authorization header (or skipAuth) is left untouched.
 */
export interface AuthConfig {
  type: 'bearer' | 'basic' | 'header' | 'query';
  /** bearer: the token */
  token?: string;
  /** basic: credentials */
  username?: string;
  password?: string;
  /** header / query: parameter name and value (API key style) */
  name?: string;
  value?: string;
}

export interface Workflow {
  name: string;
  /** default variables; ${baseUrl} is conventional */
  variables: Record<string, string>;
  defaults?: { headers?: Record<string, string> };
  auth?: AuthConfig;
  /** runs once per virtual user (e.g. login) */
  setup: Step[];
  /** runs every iteration */
  steps: Step[];
  /**
   * runs when a user's session ends, e.g. the logout call: after the last iteration of a virtual user, and, when every
   * iteration starts a new session, before the next login. Skipped when a run is stopped. Failed steps do not stop the others.
   */
  teardown?: Step[];
  /** what to do when a step fails: abort the current iteration (default) or continue */
  onError?: 'abortIteration' | 'continue';
}

/** ---------- Call details (samples shown in validation and reports) ---------- */

/** How much detail a run keeps about individual calls. Every request is counted; only samples keep full details. */
export interface CaptureSettings {
  /** successful calls kept per step (0 = none) */
  okSamples: number;
  /** failed calls kept per step (0 = none) */
  errorSamples: number;
  /** response/request bodies are cut after this many KB */
  bodyKb: number;
  /** hide credentials (Authorization/Cookie headers, password and token fields) in the stored details */
  maskSecrets: boolean;
  /** keep the details of EVERY call instead of a few per step (okSamples/errorSamples are then ignored) */
  keepAll?: boolean;
  /** with keepAll: stop keeping details after this many calls, to protect memory and disk. Default 100000 */
  maxCalls?: number;
}

/**
 * Every call is kept in full by default. okSamples / errorSamples only matter when keepAll is switched off
 * ("a few per step").
 */
export const DEFAULT_CAPTURE: CaptureSettings = { okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true, keepAll: true, maxCalls: 100_000 };
export const DEFAULT_MAX_CALLS = 100_000;
export const MAX_CALLS_LIMIT = 1_000_000;

/**
 * Fill in the defaults for a run. Settings saved before "every call" existed have no keepAll: they now keep every call too,
 * except when both counts are 0, which was how capture was switched off.
 */
export function normalizeCapture(c?: Partial<CaptureSettings>): CaptureSettings {
  const switchedOff = c !== undefined && c.okSamples === 0 && c.errorSamples === 0;
  return { ...DEFAULT_CAPTURE, ...c, keepAll: c?.keepAll ?? !switchedOff };
}

/** Everything about one call: what was sent, what came back, and what was extracted from it. */
export interface CallSample {
  step: string;
  outcome: 'ok' | 'error';
  phase: 'setup' | 'iteration' | 'teardown';
  /** epoch ms when the call started */
  at: number;
  vu: number;
  iteration: number;
  durationMs: number;
  request: { method: string; url: string; headers: Record<string, string>; body?: string; bodyTruncated?: boolean };
  response?: { status: number; headers: Record<string, string>; body?: string; bodyTruncated?: boolean; bytes: number };
  /** redirect hops followed before the final response */
  redirects?: { status: number; url: string }[];
  error?: string;
  /** values this call saved for later steps */
  extracted: Record<string, string>;
  /** workflow authentication: applied, skipped (value not available yet) or own (the step sets it) */
  auth?: 'applied' | 'skipped' | 'own';
  /** true when secrets in this sample were masked */
  masked?: boolean;
}

/** ---------- Distributed run ---------- */

export type UsersMode = 'per-vu' | 'unique' | 'per-iteration';

export interface RunConfig {
  runId: string;
  vus: number;
  rampUpSec: number;
  durationSec?: number;
  iterations?: number;
  usersMode: UsersMode;
  usersCount: number;
  thinkTimeScale: number;
  requestTimeoutMs: number;
  /** every iteration starts a new session (see TestSettings.freshSession) */
  freshSession?: boolean;
  /** per-call detail capture; absent on runs started before this existed */
  capture?: CaptureSettings;
  /** epoch ms at which VU #0 starts */
  startAt: number;
  /** epoch ms after which no new iteration starts */
  endAt: number;
  createdAt: number;
}

/** ---------- Test automation: settings, thresholds (SLAs) and verdicts ---------- */

export type ThresholdMetric = 'avg' | 'p50' | 'p90' | 'p95' | 'p99' | 'max' | 'errorRate' | 'rps';
export type ThresholdOp = '<' | '<=' | '>' | '>=';

export interface Threshold {
  metric: ThresholdMetric;
  op: ThresholdOp;
  /** ms for latency metrics, percent (0-100) for errorRate, req/s for rps */
  value: number;
  /** step name; omit for the aggregate of all requests */
  step?: string;
}

export interface ThresholdResult extends Threshold {
  actual: number;
  passed: boolean;
}

export type Verdict = 'passed' | 'failed' | 'error';

export interface TestSettings {
  vus: number;
  rampUpSec: number;
  mode: 'duration' | 'iterations';
  durationSec: number;
  iterations: number;
  usersMode: UsersMode;
  thinkTimeScale: number;
  requestTimeoutMs: number;
  /** log in again at the start of every iteration with a clean session (cookies and saved values cleared); the teardown (logout) runs before it */
  freshSession?: boolean;
  /** overrides workflow.variables.baseUrl, e.g. to target staging */
  baseUrl?: string;
  variables: Record<string, string>;
  thresholds: Threshold[];
  /** how many calls per step are kept with full request/response details; DEFAULT_CAPTURE when absent */
  capture?: CaptureSettings;
}

export const DEFAULT_SETTINGS: TestSettings = {
  vus: 10,
  rampUpSec: 10,
  mode: 'duration',
  durationSec: 60,
  iterations: 1,
  usersMode: 'per-vu',
  thinkTimeScale: 1,
  requestTimeoutMs: 30000,
  variables: {},
  thresholds: [
    { metric: 'errorRate', op: '<', value: 1 },
    { metric: 'p95', op: '<', value: 1000 },
  ],
};

export interface VuJob {
  runId: string;
  vuIndex: number;
  /** delay after startAt (ramp-up) */
  startDelayMs: number;
}
