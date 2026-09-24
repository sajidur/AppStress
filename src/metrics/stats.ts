import type { RunConfig } from '../types.js';
import type { Snapshot } from './collector.js';
import { percentiles } from './histogram.js';

/* ------------------------------------------------------------------ public stats (API / reports) */

export interface StepStats {
  name: string;
  count: number;
  errors: number;
  errorRate: number;
  rps: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  statuses: Record<string, number>;
}

export interface TimelinePoint {
  t: number;
  requests: number;
  errors: number;
  avgMs: number;
}

export interface RunStats {
  runId: string;
  config: RunConfig | null;
  steps: StepStats[];
  total: StepStats;
  iteration?: StepStats;
  timeline: TimelinePoint[];
  errors: { step: string; message: string; count: number }[];
  vus: { started: number; active: number; done: number };
  durationSec: number;
}

/* ------------------------------------------------------------------ raw aggregates (backend storage format) */

/** Additive per-step aggregate; every backend stores this (Redis hashes or in-memory maps). */
export interface RawStep {
  count: number;
  errors: number;
  sumMs: number;
  maxMs: number;
  /** Infinity when no sample yet */
  minMs: number;
  statuses: Map<string, number>;
  buckets: Map<number, number>;
}

export interface RawRun {
  config: RunConfig | null;
  vus: { started: number; active: number; done: number };
  steps: Map<string, RawStep>;
  /** unix second -> sums */
  timeline: Map<number, { requests: number; errors: number; sumMs: number }>;
  /** "step|message" -> count */
  errors: Map<string, number>;
}

export const emptyRawStep = (): RawStep => ({ count: 0, errors: 0, sumMs: 0, maxMs: 0, minMs: Infinity, statuses: new Map(), buckets: new Map() });

function addMap<K>(target: Map<K, number>, source: Map<K, number>) {
  for (const [k, v] of source) target.set(k, (target.get(k) ?? 0) + v);
}

export function mergeRawStep(target: RawStep, s: RawStep): void {
  target.count += s.count;
  target.errors += s.errors;
  target.sumMs += s.sumMs;
  target.maxMs = Math.max(target.maxMs, s.maxMs);
  target.minMs = Math.min(target.minMs, s.minMs);
  addMap(target.statuses, s.statuses);
  addMap(target.buckets, s.buckets);
}

/** Merge a worker's metrics snapshot into a raw run aggregate (used by the in-memory backend). */
export function mergeSnapshot(raw: RawRun, snap: Snapshot): void {
  for (const [name, a] of snap.steps) {
    let step = raw.steps.get(name);
    if (!step) raw.steps.set(name, (step = emptyRawStep()));
    mergeRawStep(step, {
      count: a.count,
      errors: a.errors,
      sumMs: a.sumMs,
      maxMs: a.maxMs,
      minMs: a.minMs,
      statuses: new Map([...a.statuses].map(([k, v]) => [String(k), v])),
      buckets: a.buckets,
    });
  }
  for (const [sec, s] of snap.timeline) {
    const t = raw.timeline.get(sec) ?? { requests: 0, errors: 0, sumMs: 0 };
    t.requests += s.requests;
    t.errors += s.errors;
    t.sumMs += s.sumMs;
    raw.timeline.set(sec, t);
  }
  addMap(raw.errors, snap.errors);
}

function toStepStats(name: string, s: RawStep, durationSec: number): StepStats {
  const [p50, p90, p95, p99] = percentiles(s.buckets, [50, 90, 95, 99], s.maxMs);
  return {
    name,
    count: s.count,
    errors: s.errors,
    errorRate: s.count ? s.errors / s.count : 0,
    rps: durationSec > 0 ? s.count / durationSec : 0,
    avgMs: s.count ? s.sumMs / s.count : 0,
    minMs: Number.isFinite(s.minMs) ? s.minMs : 0,
    maxMs: s.maxMs,
    p50,
    p90,
    p95,
    p99,
    statuses: Object.fromEntries(s.statuses),
  };
}

/** Turn raw aggregates into the stats shown in the UI and reports (identical for every backend). */
export function computeStats(runId: string, raw: RawRun, stepOrder: string[] = []): RunStats {
  const timeline = [...raw.timeline]
    .map(([t, s]) => ({ t, requests: s.requests, errors: s.errors, avgMs: s.requests ? s.sumMs / s.requests : 0 }))
    .sort((a, b) => a.t - b.t);
  const durationSec = timeline.length ? timeline[timeline.length - 1].t - timeline[0].t + 1 : 0;

  const order = (n: string) => {
    const i = stepOrder.indexOf(n);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const httpSteps = [...raw.steps].filter(([n]) => !n.startsWith('__'));
  const steps = httpSteps
    .map(([n, s]) => toStepStats(n, s, durationSec))
    .sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));

  const totalRaw = emptyRawStep();
  for (const [, s] of httpSteps) mergeRawStep(totalRaw, s);
  const iterationRaw = [...raw.steps].find(([n]) => n.startsWith('__'))?.[1];

  const errors = [...raw.errors]
    .map(([k, count]) => {
      const i = k.indexOf('|');
      return { step: k.slice(0, i), message: k.slice(i + 1), count };
    })
    .sort((a, b) => b.count - a.count);

  return {
    runId,
    config: raw.config,
    steps,
    total: toStepStats('TOTAL', totalRaw, durationSec),
    iteration: iterationRaw ? toStepStats('__iteration__', iterationRaw, durationSec) : undefined,
    timeline,
    errors,
    vus: raw.vus,
    durationSec,
  };
}
