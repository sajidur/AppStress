import type { MetricSink } from '../engine/executor.js';
import { bucketOf } from './histogram.js';

export interface StepAgg {
  count: number;
  errors: number;
  sumMs: number;
  maxMs: number;
  minMs: number;
  buckets: Map<number, number>;
  statuses: Map<number, number>;
}

export interface SecondAgg {
  requests: number;
  errors: number;
  sumMs: number;
}

export interface Snapshot {
  steps: Map<string, StepAgg>;
  /** unix second -> aggregate over all non-iteration samples */
  timeline: Map<number, SecondAgg>;
  /** "step|message" -> count */
  errors: Map<string, number>;
}

const emptySnapshot = (): Snapshot => ({ steps: new Map(), timeline: new Map(), errors: new Map() });

/**
 * In-process aggregation. Workers record thousands of samples per second, so
 * samples are aggregated locally and flushed to Redis in one pipeline per interval.
 */
export class MetricsCollector implements MetricSink {
  private snap = emptySnapshot();

  record(step: string, durationMs: number, status: number, error?: string): void {
    let agg = this.snap.steps.get(step);
    if (!agg) {
      agg = { count: 0, errors: 0, sumMs: 0, maxMs: 0, minMs: Infinity, buckets: new Map(), statuses: new Map() };
      this.snap.steps.set(step, agg);
    }
    agg.count++;
    agg.sumMs += durationMs;
    agg.maxMs = Math.max(agg.maxMs, durationMs);
    agg.minMs = Math.min(agg.minMs, durationMs);
    const b = bucketOf(durationMs);
    agg.buckets.set(b, (agg.buckets.get(b) ?? 0) + 1);
    agg.statuses.set(status, (agg.statuses.get(status) ?? 0) + 1);
    if (error) {
      agg.errors++;
      const key = `${step}|${error.slice(0, 200)}`;
      this.snap.errors.set(key, (this.snap.errors.get(key) ?? 0) + 1);
    }

    if (step.startsWith('__')) return; // iteration samples are not HTTP requests
    const sec = Math.floor(Date.now() / 1000);
    let s = this.snap.timeline.get(sec);
    if (!s) this.snap.timeline.set(sec, (s = { requests: 0, errors: 0, sumMs: 0 }));
    s.requests++;
    s.sumMs += durationMs;
    if (error) s.errors++;
  }

  /** Take everything recorded since the last drain. */
  drain(): Snapshot | null {
    if (!this.snap.steps.size) return null;
    const out = this.snap;
    this.snap = emptySnapshot();
    return out;
  }
}
