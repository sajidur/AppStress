import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { RunsManager } from '../../components/RunsManager';
import { Card, Empty, ErrorBox, fmt, Loading, useAction } from '../../components/ui';
import { useAsync } from '../../hooks';
import { describe } from '../../thresholds';
import type { TabProps } from '../TestPage';

export function RunsTab({ test }: TabProps) {
  const nav = useNavigate();
  const { busy, run } = useAction();
  const runs = useAsync(() => api.listTestRuns(test.id), [test.id]);
  const s = test.settings;

  const blockers: { text: string; to: string }[] = [];
  if (!test.workflow) blockers.push({ text: 'Build the workflow', to: '../workflow' });
  if (test.workflow && JSON.stringify(test.workflow).includes('${user.') && !test.dataset) blockers.push({ text: 'Upload the test users file (the workflow uses ${user.*})', to: '../users' });

  const start = async () => {
    const r = await run(() => api.startRun(test.id));
    if (r) nav(`/runs/${r.id}`);
  };

  return (
    <div className="stack">
      <Card title="5. Run the load test">
        <div className="grid-2">
          <dl className="kv">
            <dt>Virtual users</dt>
            <dd>
              <b>{s.vus}</b> (ramp-up {fmt.dur(s.rampUpSec)})
            </dd>
            <dt>Stops after</dt>
            <dd>{s.mode === 'duration' ? fmt.dur(s.durationSec) : `${s.iterations} iteration(s) per VU`}</dd>
            <dt>Test users</dt>
            <dd>{test.dataset ? `${fmt.num(test.dataset.rowCount)} (${s.usersMode})` : 'none'}</dd>
            <dt>Target</dt>
            <dd className="url-cell">{s.baseUrl || test.workflow?.variables.baseUrl || '—'}</dd>
            <dt>Think time</dt>
            <dd>×{s.thinkTimeScale}</dd>
          </dl>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Pass / fail criteria
            </div>
            {s.thresholds.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {s.thresholds.map((t, i) => (
                  <li key={i}>{describe(t)}</li>
                ))}
              </ul>
            ) : (
              <div className="faint">None — every completed run passes.</div>
            )}
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary large" onClick={start} disabled={busy || blockers.length > 0 || test.activeRuns.length > 0}>
            ▶ Start load test
          </button>
          <Link className="btn" to="../settings">
            Change settings
          </Link>
          {test.activeRuns.length > 0 && (
            <Link to={`/runs/${test.activeRuns[0]}`} className="btn">
              A run is in progress — view it
            </Link>
          )}
        </div>
        {blockers.map((b) => (
          <div key={b.text} className="callout warn" style={{ marginTop: 10 }}>
            ⚠ <Link to={b.to}>{b.text}</Link> before running.
          </div>
        ))}
      </Card>

      <Card bodyless title="Run history" hint="Click a run for its full report.">
        {runs.error ? (
          <div className="card-body">
            <ErrorBox error={runs.error} retry={runs.reload} />
          </div>
        ) : runs.loading && !runs.data ? (
          <Loading />
        ) : runs.data && runs.data.length ? (
          <RunsManager runs={runs.data} reload={runs.reload} />
        ) : (
          <Empty title="No runs yet">Start the first run above.</Empty>
        )}
      </Card>
    </div>
  );
}
