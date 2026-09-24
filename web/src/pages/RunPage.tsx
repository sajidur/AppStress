import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { CallList } from '../components/CallDetail';
import { TimeChart } from '../components/TimeChart';
import { Card, ErrorBox, fmt, Loading, MethodTag, StatusBadge, useAction, VerdictBadge } from '../components/ui';
import { useAsync, useEventStream } from '../hooks';
import { describe, evaluate } from '../thresholds';
import type { CallSample, RunDetails, RunProgress, RunRow, RunStats, RunStatus, StepRequest, StepStats } from '../types';

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

/** One step's calls: the first few at a glance, or every kept call in pages with an outcome filter. */
function StepCalls({
  runId,
  name,
  def,
  stat,
  groups,
  initial,
}: {
  runId: string;
  name: string;
  def?: StepRequest;
  stat?: StepStats;
  groups: { step: string; outcome: 'ok' | 'error'; count: number }[];
  initial: CallSample[];
}) {
  const okKept = groups.find((g) => g.step === name && g.outcome === 'ok')?.count ?? 0;
  const failedKept = groups.find((g) => g.step === name && g.outcome === 'error')?.count ?? 0;
  const total = okKept + failedKept;
  const [paged, setPaged] = useState(false);
  const [filter, setFilter] = useState<'' | 'ok' | 'error'>('');
  const [list, setList] = useState<CallSample[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = async (outcome: '' | 'ok' | 'error', offset: number) => {
    setLoading(true);
    setProblem(null);
    try {
      const r = await api.runCalls(runId, { step: name, outcome: outcome || undefined, offset, limit: 25 });
      setList((l) => (offset ? [...l, ...r.calls] : r.calls));
      setCount(r.total);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const browse = () => {
    setPaged(true);
    void load(filter, 0);
  };
  const changeFilter = (f: '' | 'ok' | 'error') => {
    setFilter(f);
    void load(f, 0);
  };

  const defText = def
    ? [`${def.method} ${def.url}`, ...Object.entries(def.headers ?? {}).map(([k, v]) => `${k}: ${v}`), ...(def.body !== undefined ? ['', def.body] : [])].join('\n')
    : '';
  const glance = [...initial].sort((a, b) => Number(b.outcome === 'error') - Number(a.outcome === 'error') || a.at - b.at);

  return (
    <details className="call-step" open={failedKept > 0}>
      <summary>
        <MethodTag method={def?.method ?? initial[0]?.request.method ?? 'GET'} />
        <span className="mono call-step-name" title={name}>
          {name}
        </span>
        {stat && (
          <span className="faint">
            {fmt.num(stat.count)} calls · {fmt.num(stat.errors)} failed · avg {fmt.ms(stat.avgMs)}
          </span>
        )}
        <span className="chip">{fmt.num(okKept)} ok kept</span>
        {failedKept > 0 && <span className="badge bad">{fmt.num(failedKept)} failed kept</span>}
      </summary>
      <div className="stack" style={{ gap: 8, padding: '10px 12px' }}>
        {def && (
          <details className="call-def">
            <summary>Configured request (variables not yet filled in)</summary>
            <pre className="call-pre">{defText}</pre>
          </details>
        )}
        {paged ? (
          <>
            <div className="row" style={{ gap: 10 }}>
              <label className="row" style={{ gap: 6 }}>
                <span className="muted">Show</span>
                <select aria-label="Which calls to show" value={filter} onChange={(e) => changeFilter(e.target.value as typeof filter)} style={{ width: 170 }}>
                  <option value="">all kept calls</option>
                  <option value="error">only failed calls</option>
                  <option value="ok">only successful calls</option>
                </select>
              </label>
              <span className="muted">
                {fmt.num(list.length)} of {fmt.num(count)}
              </span>
              <button className="btn small ghost" onClick={() => setPaged(false)}>
                Back to the first few
              </button>
            </div>
            {problem && <div className="callout bad">{problem}</div>}
            <CallList calls={list} empty={loading ? <Loading what="Loading calls" /> : <div className="faint">No calls match.</div>} />
            {list.length < count && (
              <div>
                <button className="btn small" onClick={() => void load(filter, list.length)} disabled={loading}>
                  {loading ? 'Loading…' : `Load ${Math.min(25, count - list.length)} more`}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <CallList calls={glance} />
            {total > initial.length && (
              <div className="row">
                <span className="muted">
                  Showing {fmt.num(initial.length)} of {fmt.num(total)} kept calls.
                </span>
                <button className="btn small" onClick={browse}>
                  Browse all {fmt.num(total)}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/** Full request/response details of the calls kept for each step. */
function CallDetails({ runId, status, stats }: { runId: string; status: RunStatus; stats: RunStats }) {
  const { busy, run } = useAction();
  const calls = useAsync(() => api.runSamples(runId), [runId, status]);
  const d = calls.data;
  const byStep = useMemo(() => {
    const m = new Map<string, CallSample[]>();
    for (const s of d?.samples ?? []) m.set(s.step, [...(m.get(s.step) ?? []), s]);
    return m;
  }, [d]);
  const keptStep = (n: string) => (d?.groups ?? []).some((g) => g.step === n);
  const names = [...new Set([...(d?.steps.map((s) => s.name) ?? []), ...stats.steps.map((s) => s.name), ...byStep.keys()])].filter(keptStep);
  const cap = d?.capture;
  const keptTotal = (d?.groups ?? []).reduce((n, g) => n + g.count, 0);
  const off = cap && !cap.keepAll && cap.okSamples + cap.errorSamples === 0;
  const running = status === 'starting' || status === 'running' || status === 'stopping';
  const hint = cap
    ? cap.keepAll
      ? `Every call is kept in full, up to ${fmt.num(cap.maxCalls ?? 100_000)} per run: what was sent, what came back and what was saved. ${cap.maskSecrets ? 'Credentials are masked.' : 'Credentials are shown.'}`
      : `The numbers above count every request. For each step the run keeps the first ${cap.okSamples} successful and ${cap.errorSamples} failed calls in full. ${cap.maskSecrets ? 'Credentials are masked.' : 'Credentials are shown.'}`
    : 'Full request and response of the calls kept for each step.';
  const removeAll = async () => {
    if (!confirm(`Delete the stored request and response details of this run (${fmt.num(keptTotal)} calls)? The run and its statistics stay.`)) return;
    const r = await run(() => api.deleteRunCalls(runId), 'Call details deleted');
    if (r) await calls.reload();
  };

  return (
    <Card
      title="Call details"
      hint={hint}
      actions={
        <>
          <button className="btn small" onClick={() => void calls.reload()} disabled={calls.loading}>
            Refresh
          </button>
          {!running && keptTotal > 0 && (
            <button className="btn small danger" onClick={removeAll} disabled={busy}>
              Delete call details
            </button>
          )}
        </>
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
              : 'No call details are stored for this run. They were deleted, never kept, or the run started before this feature existed.'}
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {cap?.keepAll && !running && keptTotal < stats.total.count && (
            <div className="callout warn">
              Details were kept for {fmt.num(keptTotal)} of the {fmt.num(stats.total.count)} requests: the limit of {fmt.num(cap.maxCalls ?? 100_000)} kept calls (or the memory budget) was reached, so later calls are counted but not kept. Raise the limit under Load &amp; criteria → Call details in reports.
            </div>
          )}
          {names.map((name) => (
            <StepCalls
              key={name}
              runId={runId}
              name={name}
              def={d.steps.find((s) => s.name === name)?.request}
              stat={stats.steps.find((s) => s.name === name)}
              groups={d.groups}
              initial={byStep.get(name) ?? []}
            />
          ))}
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
    const ok = await run(async () => (await api.deleteRun(id), true), 'Run deleted');
    if (ok) nav(`/tests/${r.testId}/runs`);
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
