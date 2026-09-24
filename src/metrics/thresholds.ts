import type { RunStats, StepStats } from './stats.js';
import type { Threshold, ThresholdResult, Verdict } from '../types.js';

export const METRIC_LABELS: Record<Threshold['metric'], string> = {
  avg: 'avg response time (ms)',
  p50: 'p50 response time (ms)',
  p90: 'p90 response time (ms)',
  p95: 'p95 response time (ms)',
  p99: 'p99 response time (ms)',
  max: 'max response time (ms)',
  errorRate: 'error rate (%)',
  rps: 'throughput (req/s)',
};

function metricValue(s: StepStats, metric: Threshold['metric']): number {
  switch (metric) {
    case 'avg':
      return s.avgMs;
    case 'max':
      return s.maxMs;
    case 'errorRate':
      return s.errorRate * 100;
    case 'rps':
      return s.rps;
    default:
      return s[metric];
  }
}

function compare(actual: number, op: Threshold['op'], value: number): boolean {
  switch (op) {
    case '<':
      return actual < value;
    case '<=':
      return actual <= value;
    case '>':
      return actual > value;
    case '>=':
      return actual >= value;
  }
}

/** Evaluate SLA thresholds. A threshold on a step that never ran fails. */
export function evaluateThresholds(stats: RunStats, thresholds: Threshold[]): { verdict: Verdict; results: ThresholdResult[] } {
  const results = thresholds.map((t): ThresholdResult => {
    const target = t.step ? stats.steps.find((s) => s.name === t.step) : stats.total;
    if (!target || target.count === 0) return { ...t, actual: NaN, passed: false };
    const actual = Math.round(metricValue(target, t.metric) * 100) / 100;
    return { ...t, actual, passed: compare(actual, t.op, t.value) };
  });
  // A run with no requests at all is never a pass.
  const verdict: Verdict = stats.total.count === 0 ? 'failed' : results.every((r) => r.passed) ? 'passed' : 'failed';
  return { verdict, results };
}

export function describeThreshold(t: Threshold): string {
  return `${t.step ? `[${t.step}] ` : ''}${METRIC_LABELS[t.metric]} ${t.op} ${t.value}`;
}

const xml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * JUnit XML for CI systems (Jenkins, GitLab, Azure DevOps, GitHub Actions):
 * one testcase per threshold plus one per step (fails if the step had errors).
 */
export function toJUnit(testName: string, stats: RunStats, results: ThresholdResult[]): string {
  const cases: string[] = [];
  for (const r of results) {
    const name = describeThreshold(r);
    cases.push(
      r.passed
        ? `    <testcase classname="thresholds" name="${xml(name)}"/>`
        : `    <testcase classname="thresholds" name="${xml(name)}"><failure message="${xml(`actual ${Number.isNaN(r.actual) ? 'no data' : r.actual}`)}"/></testcase>`,
    );
  }
  for (const s of stats.steps) {
    const time = (s.avgMs / 1000).toFixed(3);
    const detail = `count=${s.count} errors=${s.errors} avg=${s.avgMs.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms`;
    cases.push(
      s.errors
        ? `    <testcase classname="steps" name="${xml(s.name)}" time="${time}"><failure message="${xml(`${s.errors} of ${s.count} requests failed`)}">${xml(detail)}</failure></testcase>`
        : `    <testcase classname="steps" name="${xml(s.name)}" time="${time}"><system-out>${xml(detail)}</system-out></testcase>`,
    );
  }
  const failures = results.filter((r) => !r.passed).length + stats.steps.filter((s) => s.errors).length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${xml(testName)}" tests="${cases.length}" failures="${failures}" time="${stats.durationSec}">
  <testsuite name="${xml(`${testName} (${stats.runId})`)}" tests="${cases.length}" failures="${failures}" time="${stats.durationSec}">
${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}
