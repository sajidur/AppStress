import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { CallList } from '../components/CallDetail';
import { TimeChart } from '../components/TimeChart';
import { Card, ErrorBox, fmt, Loading, MethodTag, StatusBadge, useAction, VerdictBadge } from '../components/ui';
import { useAsync, useEventStream } from '../hooks';
import { describe, evaluate } from '../thresholds';
import type { CallSample, RunDetails, RunProgress, RunRow, RunStats, RunStatus, StepStats } from '../types';

type RunEvent = { type: 'status'; status: RunStatus } | { type: 'progress'; progress: RunProgress } | { type: 'finished'; run: RunRow };

const ACTIVE: RunStatus[] = ['starting', 'running', 'stopping'];

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-value" style={tone === 'bad' ? { color: 'var(--critical-text)' } : undefined}>
        {value}
      </div>
      {sub && <div className="k-sub">{sub}</div>}
    </div>
  );
}

/** Full request/response details of the calls kept for each step. */
function CallDetails({ runId, status, stats }: { runId: string; status: RunStatus; stats: RunStats }) {
  const calls = useAsync(() => api.runSamples(runId), [runId, status]);
  const d = calls.data;
  const byStep = useMemo(() => {
    const m = new Map<string, CallSample[]>();
    for (const s of d?.samples ?? []) m.set(s.step, [...(m.get(s.step) ?? []), s]);
    return m;
  }, [d]);
  const names = [...new Set([...(d?.steps.map((s) => s.name) ?? []), ...stats.steps.map((s) => s.name), ...byStep.keys()])].filter((n) => byStep.has(n));
  const cap = d?.capture;
  const statOf = (name: string) => stats.steps.find((s) => s.name === name);
  const defOf = (name: string) => d?.steps.find((s) => s.name === name)?.request;
  const hint = cap
    ? `The numbers above count every request. For each step the run keeps the first ${cap.okSamples} successful and ${cap.errorSamples} failed calls in full: what was sent, what came back and what was saved. ${cap.maskSecrets ? 'Credentials are masked.' : 'Credentials are shown.'}`
    : 'Full request and response of the calls kept for each step.';
  const off = cap && cap.okSamples + cap.errorSamples === 0;
  const running = status === 'starting' || status === 'running';

  return (
    <Card
      title="Call details"
      hint={hint}
      actions={
        <button className="btn small" onClick={() => void calls.reload()} disabled={calls.loading}>
          Refresh
        </button>
      }
    >
      {calls.error ? (
        <div className="callout bad">{calls.error.message}</div>
      ) : !d ? (
        <Loading what="Loading call details" />
      ) : names.length === 0 ? (
        <div className="faint">
          {off
            ? 'Call capture was switched off for this run (Load & criteria → Call details).'
            : running
              ? 'No calls kept yet. They appear here as the run makes requests.'
              : 'No call details were kept for this run. Runs started before this feature existed have none.'}
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {names.map((name) => {
            const list = byStep.get(name)!;
            const st = statOf(name);
            const def = defOf(name);
            const failed = list.filter((c) => c.outcome === 'error').length;
            const defText = def
              ? [`${def.method} ${def.url}`, ...Object.entries(def.headers ?? {}).map(([k, v]) => `${k}: ${v}`), ...(def.body !== undefined ? ['', def.body] : [])].join('\n')
              : '';
            return (
              <details key={name} className="call-step" open={failed > 0}>
                <summary>
                  <MethodTag method={def?.method ?? list[0].request.method} />
                  <span className="mono call-step-name" title={name}>
                    {name}
                  </span>
                  {st && (
                    <span className="faint">
                      {fmt.num(st.count)} calls · {fmt.num(st.errors)} failed · avg {fmt.ms(st.avgMs)}
                    </span>
                  )}
                  <span className="chip">{list.length - failed} ok kept</span>
                  {failed > 0 && <span className="badge bad">{failed} failed kept</span>}
                </summary>
                <div className="stack" style={{ gap: 8, padding: '10px 12px' }}>
                  {def && (
                    <details className="call-def">
                      <summary>Configured request (variables not yet filled in)</summary>
                      <pre className="call-pre">{defText}</pre>
                    </details>
                  )}
                  <CallList calls={[...list].sort((a, b) => Number(b.outcome === 'error') - Number(a.outcome === 'error') || a.at - b.at)} />
                </div>
              </details>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function StepsTable({ stats }: { stats: RunStats }) {
  const row = (s: StepStats, cls = '', label?: string) => (
    <tr key={label ?? s.name} className={cls}>
      <td className="mono" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>
        {label ?? s.name}
      </td>
      <td className="r">{fmt.num(s.count)}</td>
      <td className="r" style={s.errors ? { color: 'var(--critical-text)', fontWeight: 600 } : undefined}>
        {fmt.num(s.errors)} <span className="faint">({fmt.pct(s.errorRate, 1)})</span>
      </td>
      <td className="r">{fmt.rps(s.rps)}</td>
      <td className="r">{fmt.ms(s.avgMs)}</td>
      <td className="r">{fmt.ms(s.p50)}</td>
      <td className="r">{fmt.ms(s.p90)}</td>
      <td className="r">{fmt.ms(s.p95)}</td>
      <td className="r">{fmt.ms(s.p99)}</td>
      <td className="r">{fmt.ms(s.maxMs)}</td>
      <td className="faint mono" style={{ fontSize: 11.5 }}>
        {Object.entries(s.statuses)
          .map(([k, v]) => `${k === '0' ? 'network' : k}×${v}`)
          .join(' ')}
      </td>
    </tr>
  );
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Step</th>
            <th className="r">Requests</th>
            <th className="r">Errors</th>
            <th className="r">req/s</th>
            <th className="r">Avg</th>
            <th className="r">p50</th>
            <th className="r">p90</th>
            <th className="r">p95</th>
            <th className="r">p99</th>
            <th className="r">Max</th>
            <th>Status codes</th>
          </tr>
        </thead>
        <tbody>
          {stats.steps.map((s) => row(s))}
          {row(stats.total, 'total', 'All requests')}
          {stats.iteration && row(stats.iteration, 'total', 'Full iteration (end-to-end)')}
        </tbody>
      </table>
    </div>
  );
}

export function RunPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const { data, error, loading, reload, setData } = useAsync(() => api.getRun(id), [id]);
  const [progress, setProgress] = useState<RunProgress | null>(null);

  const active = data ? ACTIVE.includes(data.status) : false;
  useEventStream<RunEvent>(data && active ? api.runEventsUrl(id) : null, (e) => {
    if (e.type === 'progress') setProgress(e.progress);
    else if (e.type === 'status') setData((d) => (d ? { ...d, status: e.status } : d));
    else if (e.type === 'finished') void reload();
  });

  const stats: RunStats | null = (active ? (progress?.stats ?? data?.progress?.stats) : data?.stats) ?? null;
  const live = active ? (progress ?? data?.progress ?? null) : null;

  const charts = useMemo(() => {
    // While live, the newest second is still being filled: plotting it would show a false dip.
    const all = stats?.timeline ?? [];
    const tl = active ? all.slice(0, -1) : all;
    const t0 = tl[0]?.t ?? 0;
    return {
      rps: tl.map((p) => ({ x: p.t - t0, y: p.requests })),
      lat: tl.map((p) => ({ x: p.t - t0, y: p.avgMs })),
      err: tl.map((p) => ({ x: p.t - t0, y: p.errors })),
    };
  }, [stats, active]);

  if (error) return <div className="page"><ErrorBox error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (!data) return null;

  const r: RunDetails = data;
  const cfg = r.config;
  const thresholdResults = active ? (stats ? evaluate(stats, r.settings.thresholds) : []) : (r.thresholds ?? []);
  const totalSec = r.settings.mode === 'duration' ? r.settings.durationSec : null;
  const elapsed = live?.elapsedSec ?? 0;

  const stop = async () => {
    if (!confirm('Stop this run? Results collected so far are kept.')) return;
    await run(() => api.stopRun(id), 'Stop signal sent to all workers');
    void reload();
  };
  const remove = async () => {
    if (!confirm('Delete this run and its results?')) return;
    const ok = await run(() => api.deleteRun(id), 'Run deleted');
    if (ok !== undefined) nav(`/tests/${r.testId}/runs`);
  };

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/tests">Tests</Link> / <Link to={`/tests/${r.testId}/runs`}>{r.testName}</Link> / <span className="mono">{r.id}</span>
      </div>
      <div className="page-header">
        <div>
          <div className="row" style={{ gap: 12 }}>
            <h1>{r.testName}</h1>
            <StatusBadge status={r.status} />
          </div>
          <div className="sub muted">
            {fmt.date(r.startedAt ?? r.createdAt)} · {r.settings.vus} VUs · ramp-up {fmt.dur(r.settings.rampUpSec)} ·{' '}
            {r.settings.mode === 'duration' ? fmt.dur(r.settings.durationSec) : `${r.settings.iterations} iterations/VU`} · users mode {r.settings.usersMode} · triggered by {r.triggeredBy}
          </div>
        </div>
        <div className="row">
          {active ? (
            <button className="btn danger solid" onClick={stop} disabled={busy || r.status === 'stopping'}>
              ■ {r.status === 'stopping' ? 'Stopping…' : 'Stop test'}
            </button>
          ) : (
            <>
              <VerdictBadge verdict={r.verdict} large />
              {r.stats && (
                <>
                  <a className="btn" href={api.reportUrl(id, 'report.html')} target="_blank" rel="noreferrer">
                    HTML report
                  </a>
                  <a className="btn" href={api.reportUrl(id, 'junit.xml')} download>
                    JUnit XML
                  </a>
                  <a className="btn" href={api.reportUrl(id, 'report.json')} download>
                    JSON
                  </a>
                </>
              )}
              <button className="btn ghost danger" onClick={remove} disabled={busy}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      <div className="stack">
        {r.error && <div className="callout bad">{r.error}</div>}

        {active && (
          <Card>
            <div className="row between" style={{ marginBottom: 8 }}>
              <span>
                <b>{live?.phase === 'starting' ? 'Starting — workers are picking up virtual users' : live?.phase === 'stopping' ? 'Stopping — virtual users are finishing' : live?.phase === 'finishing' ? 'Finishing — waiting for the last iterations' : 'Running'}</b>
                <span className="muted"> · {fmt.dur(elapsed)} elapsed{totalSec ? ` of ${fmt.dur(totalSec)}` : ''}</span>
              </span>
              <span className="muted">
                {stats?.vus.active ?? 0} / {r.settings.vus} VUs active · {stats?.vus.done ?? 0} finished
              </span>
            </div>
            <div className="progress">
              <div
                style={{
                  width: `${totalSec ? Math.min(100, (elapsed / totalSec) * 100) : Math.min(100, ((stats?.vus.done ?? 0) / r.settings.vus) * 100)}%`,
                }}
              />
            </div>
          </Card>
        )}

        {stats ? (
          <>
            <div className="kpis">
              <Kpi label="Requests" value={fmt.num(stats.total.count)} sub={`${fmt.num(live?.iterations ?? r.summary?.iterations ?? stats.iteration?.count ?? 0)} iterations completed`} />
              <Kpi label={active ? 'Throughput now' : 'Throughput'} value={`${fmt.rps(active ? (live?.currentRps ?? 0) : stats.total.rps)}/s`} sub={active ? `avg ${fmt.rps(stats.total.rps)}/s` : undefined} />
              <Kpi label="Error rate" value={fmt.pct(stats.total.errorRate)} sub={`${fmt.num(stats.total.errors)} failed`} tone={stats.total.errors ? 'bad' : undefined} />
              <Kpi label="p95 response" value={fmt.ms(stats.total.p95)} sub={`avg ${fmt.ms(stats.total.avgMs)} · max ${fmt.ms(stats.total.maxMs)}`} />
              <Kpi label="Virtual users" value={active ? `${stats.vus.active}` : `${stats.vus.started}`} sub={active ? `of ${r.settings.vus} configured` : 'started'} />
              <Kpi label="Duration" value={fmt.dur(stats.durationSec)} sub={cfg ? `${cfg.usersCount} test users` : undefined} />
            </div>

            <Card
              bodyless
              title={active ? 'Pass / fail criteria (live)' : 'Pass / fail criteria'}
              hint={active ? 'Evaluated continuously; the final verdict is decided when the run ends.' : undefined}
            >
              {thresholdResults.length ? (
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Criterion</th>
                        <th className="r">Actual</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {thresholdResults.map((t, i) => (
                        <tr key={i}>
                          <td>{describe(t)}</td>
                          <td className="r num">{Number.isNaN(t.actual) || t.actual === null ? 'no data' : t.actual}</td>
                          <td>{t.passed ? <span className="badge good">✓ Pass</span> : <span className="badge bad">✕ Fail</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="card-body faint">No criteria defined for this run.</div>
              )}
            </Card>

            <div className="grid-2">
              <TimeChart title="Throughput" unit="req/s" points={charts.rps} color="var(--series-1)" format={(v) => fmt.rps(v)} />
              <TimeChart title="Average response time" unit="ms" points={charts.lat} color="var(--series-1)" format={(v) => `${Math.round(v)}`} />
            </div>
            <TimeChart title="Errors" unit="errors/s" points={charts.err} color="var(--critical)" format={(v) => `${Math.round(v * 10) / 10}`} height={140} />

            <Card bodyless title="Response times by step">
              <StepsTable stats={stats} />
            </Card>

            <Card bodyless title="Errors" hint={stats.errors.length ? 'Grouped by step and message.' : undefined}>
              {stats.errors.length ? (
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Step</th>
                        <th>Message</th>
                        <th className="r">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.errors.slice(0, 100).map((e, i) => (
                        <tr key={i}>
                          <td className="mono">{e.step}</td>
                          <td>{e.message}</td>
                          <td className="r">{fmt.num(e.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="card-body faint">No errors 🎉</div>
              )}
            </Card>
            <CallDetails runId={id} status={r.status} stats={stats} />
          </>
        ) : (
          <Card>
            <div className="empty">{active ? 'Waiting for the first results…' : 'This run produced no results.'}</div>
          </Card>
        )}
      </div>
    </div>
  );
}
