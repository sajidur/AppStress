import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStats, StepStats } from './stats.js';
import type { ThresholdResult, Verdict, Workflow } from '../types.js';
import { describeThreshold } from './thresholds.js';

export interface ReportExtras {
  verdict?: Verdict;
  thresholds?: ThresholdResult[];
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function printSummary(s: RunStats): void {
  const rows = [...s.steps, s.total, ...(s.iteration ? [{ ...s.iteration, name: 'ITERATION (full flow)' }] : [])];
  console.log(`\n=== Run ${s.runId} — ${s.durationSec}s, ${s.vus.started} VUs started ===`);
  console.table(
    Object.fromEntries(
      rows.map((r) => [
        r.name.length > 60 ? r.name.slice(0, 57) + '...' : r.name,
        {
          count: r.count,
          'err%': pct(r.errorRate),
          'rps': r.rps.toFixed(1),
          avg: ms(r.avgMs),
          p50: ms(r.p50),
          p90: ms(r.p90),
          p95: ms(r.p95),
          p99: ms(r.p99),
          max: ms(r.maxMs),
        },
      ]),
    ),
  );
  if (s.errors.length) {
    console.log('Top errors:');
    for (const e of s.errors.slice(0, 10)) console.log(`  ${String(e.count).padStart(7)}  ${e.step}: ${e.message}`);
  }
}

export function writeReports(s: RunStats, workflow: Workflow | undefined, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const jsonFile = join(dir, `${s.runId}.json`);
  const htmlFile = join(dir, `${s.runId}.html`);
  writeFileSync(jsonFile, JSON.stringify({ ...s, workflow: workflow?.name }, null, 2));
  writeFileSync(htmlFile, renderHtml(s, workflow));
  return [jsonFile, htmlFile];
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function lineChart(points: { x: number; y: number }[], color: string, label: string, unit: string): string {
  const W = 800;
  const H = 180;
  const P = 36;
  if (!points.length) return '<p class="muted">No data</p>';
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const maxY = Math.max(1, ...points.map((p) => p.y)) * 1.1;
  const sx = (x: number) => P + (x / maxX) * (W - P * 2);
  const sy = (y: number) => H - P / 2 - (y / maxY) * (H - P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1].map((f) => {
    const y = maxY * f;
    return `<line x1="${P}" x2="${W - P}" y1="${sy(y)}" y2="${sy(y)}" class="grid"/><text x="${P - 6}" y="${sy(y) + 4}" text-anchor="end">${y.toFixed(y < 10 ? 1 : 0)}</text>`;
  });
  return `<figure><figcaption>${esc(label)} <span class="muted">(${unit})</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${ticks.join('')}
<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>
<text x="${W - P}" y="${H - 2}" text-anchor="end">${maxX}s</text><text x="${P}" y="${H - 2}">0s</text></svg></figure>`;
}

function row(r: StepStats, cls = ''): string {
  return `<tr class="${cls}"><td class="name">${esc(r.name)}</td><td>${r.count}</td><td class="${r.errors ? 'bad' : ''}">${r.errors} (${pct(r.errorRate)})</td>
<td>${r.rps.toFixed(1)}</td><td>${ms(r.avgMs)}</td><td>${ms(r.minMs)}</td><td>${ms(r.p50)}</td><td>${ms(r.p90)}</td><td>${ms(r.p95)}</td><td>${ms(r.p99)}</td><td>${ms(r.maxMs)}</td>
<td class="muted">${Object.entries(r.statuses).map(([k, v]) => `${k === '0' ? 'net' : k}:${v}`).join(' ')}</td></tr>`;
}

export function renderHtml(s: RunStats, workflow?: Workflow, extras: ReportExtras = {}): string {
  const t0 = s.timeline[0]?.t ?? 0;
  const rps = s.timeline.map((p) => ({ x: p.t - t0, y: p.requests }));
  const lat = s.timeline.map((p) => ({ x: p.t - t0, y: p.avgMs }));
  const errs = s.timeline.map((p) => ({ x: p.t - t0, y: p.errors }));
  const c = s.config;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Load test ${esc(s.runId)}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--bad:#b91c1c;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--bad:#f87171;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}.bad{color:var(--bad);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td.name{text-align:left}td.name{font-family:ui-monospace,monospace;font-size:12px}
tr.total td{font-weight:600}
.verdict{display:inline-block;margin-top:16px;padding:6px 14px;border-radius:999px;font-weight:700;letter-spacing:.04em}
.verdict.passed{background:#dcfce7;color:#166534}.verdict.failed,.verdict.error{background:#fee2e2;color:#991b1b}
.ok{color:#15803d;font-weight:600}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.charts{display:grid;gap:12px}
svg{width:100%;height:auto}svg text{fill:var(--muted);font-size:11px}svg .grid{stroke:var(--line)}
</style></head><body><main>
<h1>${esc(workflow?.name ?? 'Load test')}</h1>
<div class="muted">Run ${esc(s.runId)}${c ? ` · ${new Date(c.startAt).toLocaleString()} · ${c.vus} VUs · ramp-up ${c.rampUpSec}s · ${c.durationSec ? `duration ${c.durationSec}s` : `${c.iterations} iterations/VU`} · users ${c.usersCount} (${c.usersMode})` : ''}</div>
<div class="kpis">
<div class="kpi"><span class="muted">Requests</span><b>${s.total.count}</b></div>
<div class="kpi"><span class="muted">Throughput</span><b>${s.total.rps.toFixed(1)}/s</b></div>
<div class="kpi"><span class="muted">Error rate</span><b class="${s.total.errors ? 'bad' : ''}">${pct(s.total.errorRate)}</b></div>
<div class="kpi"><span class="muted">p95 latency</span><b>${ms(s.total.p95)}</b></div>
<div class="kpi"><span class="muted">Iterations</span><b>${s.iteration?.count ?? 0}</b></div>
<div class="kpi"><span class="muted">Duration</span><b>${s.durationSec}s</b></div>
</div>
${verdictHtml(extras)}
<h2>Over time</h2><div class="charts">
${lineChart(rps, 'var(--accent)', 'Requests per second', 'req/s')}
${lineChart(lat, '#d97706', 'Average response time', 'ms')}
${lineChart(errs, 'var(--bad)', 'Errors per second', 'errors/s')}
</div>
<h2>Steps</h2><div class="wrap"><table><thead><tr><th>Step</th><th>Count</th><th>Errors</th><th>RPS</th><th>Avg</th><th>Min</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>Max</th><th>Status codes</th></tr></thead><tbody>
${s.steps.map((r) => row(r)).join('\n')}
${row(s.total, 'total')}
${s.iteration ? row({ ...s.iteration, name: 'Full iteration (all steps)' }, 'total') : ''}
</tbody></table></div>
<h2>Errors</h2>${
    s.errors.length
      ? `<div class="wrap"><table><thead><tr><th>Step</th><th>Message</th><th>Count</th></tr></thead><tbody>${s.errors
          .slice(0, 50)
          .map((e) => `<tr><td class="name">${esc(e.step)}</td><td style="text-align:left">${esc(e.message)}</td><td>${e.count}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<p class="muted">No errors.</p>'
  }
</main></body></html>`;
}

function verdictHtml(x: ReportExtras): string {
  if (!x.verdict) return '';
  const rows = (x.thresholds ?? [])
    .map(
      (t) =>
        `<tr><td class="name">${esc(describeThreshold(t))}</td><td>${Number.isNaN(t.actual) ? 'no data' : t.actual}</td><td class="${t.passed ? 'ok' : 'bad'}">${t.passed ? 'PASS' : 'FAIL'}</td></tr>`,
    )
    .join('');
  return `<div class="verdict ${x.verdict}">${x.verdict.toUpperCase()}</div>
<h2>Thresholds</h2>${rows ? `<div class="wrap"><table><thead><tr><th>Threshold</th><th>Actual</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No thresholds defined.</p>'}`;
}
