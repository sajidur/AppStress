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

export interface Workflow {
  name: string;
  /** default variables; ${baseUrl} is conventional */
  variables: Record<string, string>;
  defaults?: { headers?: Record<string, string> };
  /** runs once per virtual user (e.g. login) */
  setup: Step[];
  /** runs every iteration */
  steps: Step[];
  /** what to do when a step fails: abort the current iteration (default) or continue */
  onError?: 'abortIteration' | 'continue';
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
