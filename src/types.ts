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
}

export const DEFAULT_CAPTURE: CaptureSettings = { okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true };

/** Everything about one call: what was sent, what came back, and what was extracted from it. */
export interface CallSample {
  step: string;
  outcome: 'ok' | 'error';
  phase: 'setup' | 'iteration';
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
