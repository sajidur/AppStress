import type { RunStats, StepStats, Threshold, ThresholdMetric, ThresholdResult } from './types';

export const METRICS: { value: ThresholdMetric; label: string; unit: string }[] = [
  { value: 'p95', label: 'p95 response time', unit: 'ms' },
  { value: 'p90', label: 'p90 response time', unit: 'ms' },
  { value: 'p99', label: 'p99 response time', unit: 'ms' },
  { value: 'p50', label: 'median response time', unit: 'ms' },
  { value: 'avg', label: 'average response time', unit: 'ms' },
  { value: 'max', label: 'max response time', unit: 'ms' },
  { value: 'errorRate', label: 'error rate', unit: '%' },
  { value: 'rps', label: 'throughput', unit: 'req/s' },
];

export const metricInfo = (m: ThresholdMetric) => METRICS.find((x) => x.value === m)!;

export function describe(t: Threshold): string {
  const info = metricInfo(t.metric);
  return `${t.step ? `${t.step}: ` : ''}${info.label} ${t.op} ${t.value} ${info.unit}`;
}

function value(s: StepStats, m: ThresholdMetric): number {
  if (m === 'avg') return s.avgMs;
  if (m === 'max') return s.maxMs;
  if (m === 'errorRate') return s.errorRate * 100;
  if (m === 'rps') return s.rps;
  return s[m];
}

/** Client-side mirror of the server's evaluation, used for live pass/fail while a run is in progress. */
export function evaluate(stats: RunStats, thresholds: Threshold[]): ThresholdResult[] {
  return thresholds.map((t) => {
    const target = t.step ? stats.steps.find((s) => s.name === t.step) : stats.total;
    if (!target || !target.count) return { ...t, actual: NaN, passed: false };
    const actual = Math.round(value(target, t.metric) * 100) / 100;
    const passed = t.op === '<' ? actual < t.value : t.op === '<=' ? actual <= t.value : t.op === '>' ? actual > t.value : actual >= t.value;
    return { ...t, actual, passed };
  });
}
