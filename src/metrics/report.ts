import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStats, StepStats } from './stats.js';
import type { CallSample, CaptureSettings, Step, ThresholdResult, Verdict, Workflow } from '../types.js';
import { describeThreshold } from './thresholds.js';

export interface ReportExtras {
  verdict?: Verdict;
  thresholds?: ThresholdResult[];
  /** calls kept with full request/response details */
  samples?: CallSample[];
  /** how many calls were kept in total (the HTML shows only the first few per step) */
  keptTotal?: number;
  capture?: CaptureSettings;
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

export function writeReports(s: RunStats, workflow: Workflow | undefined, dir: string, extras: ReportExtras = {}): string[] {
  mkdirSync(dir, { recursive: true });
  const jsonFile = join(dir, `${s.runId}.json`);
  const htmlFile = join(dir, `${s.runId}.html`);
  writeFileSync(jsonFile, JSON.stringify({ ...s, workflow: workflow?.name, samples: extras.samples ?? [] }, null, 2));
  writeFileSync(htmlFile, renderHtml(s, workflow, extras));
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
.calls h3{font-size:14px;margin:22px 0 6px;font-family:ui-monospace,monospace}.calls h3 .muted{font:12px system-ui,sans-serif;margin-left:8px}
.calls h4{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:10px 0 4px}
.calls details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:6px 0}
.calls summary{cursor:pointer;padding:8px 12px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.calls details.err{border-left:3px solid var(--bad)}.calls details.okc{border-left:3px solid #15803d}
.calls .cols{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;padding:0 12px 12px}@media(max-width:900px){.calls .cols{grid-template-columns:1fr}}
.calls pre{margin:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;word-break:break-all;overflow:auto;max-height:340px;font:12px/1.45 ui-monospace,monospace}
.calls .st{font-weight:700;font-variant-numeric:tabular-nums}.calls .st.e{color:var(--bad)}.calls .st.g{color:#15803d}
.calls .note{padding:0 12px 10px}.calls .tpl{margin:4px 0}.calls .tpl summary{padding:4px 10px;font-size:12px;color:var(--muted)}.calls .tpl pre{margin:0 10px 10px}
.calls .method{font:700 11px ui-monospace,monospace;padding:1px 6px;border-radius:4px;background:var(--line)}
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
${callsHtml(s, workflow, extras)}
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

/* ------------------------------------------------------------------ call details */

const prettyBody = (body: string | undefined, truncated?: boolean): string => {
  if (body === undefined) return '';
  if (!truncated) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return body;
};

const headerLines = (h: Record<string, string> | undefined) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

const none = '<span class="muted">none</span>';

function templateHtml(step: Step | undefined): string {
  if (!step) return '';
  const r = step.request;
  const text = [`${r.method} ${r.url}`, headerLines(r.headers), r.body !== undefined ? `\n${r.body}` : ''].filter((x) => x !== '').join('\n');
  return `<details class="tpl"><summary>Configured request (with variables not yet filled in)</summary><pre>${esc(text)}</pre></details>`;
}

function callHtml(c: CallSample): string {
  const bad = c.outcome === 'error';
  const req = c.request;
  const res = c.response;
  const when = new Date(c.at).toLocaleTimeString();
  const auth = c.auth === 'applied' ? '<span class="muted">authentication sent</span>' : c.auth === 'skipped' ? '<span class="muted">no authentication yet</span>' : '';
  const redirects = c.redirects?.length ? esc('\n' + c.redirects.map((h) => `redirect ${h.status} to ${h.url}`).join('\n')) : '';
  const saved = Object.keys(c.extracted).length
    ? `<div class="note"><h4>Saved for later steps</h4><pre>${esc(Object.entries(c.extracted).map(([k, v]) => `${k} = ${v}`).join('\n'))}</pre></div>`
    : '';
  return `<details class="${bad ? 'err' : 'okc'}"${bad ? ' open' : ''}><summary>
<span class="st ${bad ? 'e' : 'g'}">${res ? res.status : 'no response'}</span><span>${ms(c.durationMs)}</span>
<span class="muted">${c.phase === 'setup' ? 'setup' : c.phase === 'teardown' ? 'teardown' : `iteration ${c.iteration + 1}`} · virtual user ${c.vu + 1} · ${esc(when)}</span>${auth}
${c.error ? `<span class="bad">${esc(c.error)}</span>` : ''}</summary>
<div class="cols"><div><h4>Request</h4><pre>${esc(`${req.method} ${req.url}`)}</pre>
<h4>Request headers</h4><pre>${esc(headerLines(req.headers)) || none}</pre>
<h4>Request body${req.bodyTruncated ? ' (cut)' : ''}</h4><pre>${req.body !== undefined ? esc(prettyBody(req.body, req.bodyTruncated)) : '<span class="muted">no body</span>'}</pre></div>
<div><h4>Response${res ? ` · ${res.bytes} bytes` : ''}</h4><pre>${res ? esc(String(res.status)) : '<span class="muted">no response received</span>'}${redirects}</pre>
<h4>Response headers</h4><pre>${(res && esc(headerLines(res.headers))) || none}</pre>
<h4>Response body${res?.bodyTruncated ? ' (cut)' : ''}</h4><pre>${res?.body ? esc(prettyBody(res.body, res.bodyTruncated)) : '<span class="muted">empty</span>'}</pre></div></div>${saved}
</details>`;
}

/** One section per step with the calls that were kept: what was sent, what came back, what was saved. */
function callsHtml(s: RunStats, workflow: Workflow | undefined, x: ReportExtras): string {
  const samples = x.samples ?? [];
  if (!samples.length) {
    const off = x.capture && !x.capture.keepAll && x.capture.okSamples + x.capture.errorSamples === 0;
    return `<h2>Call details</h2><p class="muted">No call details were kept for this run${off ? ' (call capture was switched off in the test settings)' : ''}.</p>`;
  }
  const steps = [...(workflow?.setup ?? []), ...(workflow?.steps ?? []), ...(workflow?.teardown ?? [])];
  const order = new Map(steps.map((st, i) => [st.name, i]));
  const names = [...new Set(samples.map((c) => c.step))].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  const stat = new Map(s.steps.map((r) => [r.name, r]));
  const cap = x.capture;
  const masked = samples.some((c) => c.masked);
  const kept = cap?.keepAll ? 'calls' : cap ? `${cap.okSamples} successful and ${cap.errorSamples} failed calls` : 'calls';
  const partial = x.keptTotal !== undefined && x.keptTotal > samples.length ? ` This page shows ${samples.length} of the ${x.keptTotal} calls that were kept (the first few of every step); the JSON report and the run page have all of them.` : '';
  const maskNote = masked ? ' Credentials (Authorization and Cookie headers, password and token fields) are masked; switch this off in the test settings to see them.' : '';
  const sections = names
    .map((name) => {
      const list = samples
        .filter((c) => c.step === name)
        .sort((a, b) => Number(b.outcome === 'error') - Number(a.outcome === 'error') || a.at - b.at);
      const st = steps.find((z) => z.name === name);
      const r = stat.get(name);
      const counts = r ? `<span class="muted">${r.count} calls · ${r.errors} failed · avg ${ms(r.avgMs)}</span>` : '';
      return `<h3><span class="method">${esc(st?.request.method ?? list[0].request.method)}</span> ${esc(name)}${counts}</h3>${templateHtml(st)}${list.map(callHtml).join('')}`;
    })
    .join('');
  return `<h2>Call details</h2><div class="calls">
<p class="muted">The numbers above count every request. For each step, the report keeps the first ${kept} in full: what was sent, what came back and what was saved for later steps. Failed calls are opened.${partial}${maskNote}</p>
${sections}</div>`;
}
