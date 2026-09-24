import { useNavigate } from 'react-router-dom';
import type { RunRow } from '../types';
import { fmt, StatusBadge, VerdictBadge } from './ui';

export function RunsTable({ runs, showTest }: { runs: RunRow[]; showTest?: boolean }) {
  const nav = useNavigate();
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Started</th>
            {showTest && <th>Test</th>}
            <th>Status</th>
            <th>Verdict</th>
            <th className="r">VUs</th>
            <th className="r">Duration</th>
            <th className="r">Requests</th>
            <th className="r">Errors</th>
            <th className="r">p95</th>
            <th className="r">Throughput</th>
            <th>Trigger</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => nav(`/runs/${r.id}`)}>
              <td>
                <div>{fmt.date(r.startedAt ?? r.createdAt)}</div>
                <div className="faint mono" style={{ fontSize: 11.5 }}>
                  {r.id}
                </div>
              </td>
              {showTest && <td style={{ fontWeight: 600 }}>{r.testName}</td>}
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td>
                <VerdictBadge verdict={r.verdict} />
              </td>
              <td className="r">{r.settings.vus}</td>
              <td className="r">{fmt.dur(r.summary?.durationSec)}</td>
              <td className="r">{fmt.num(r.summary?.requests)}</td>
              <td className="r">{r.summary ? fmt.pct(r.summary.errorRate) : '—'}</td>
              <td className="r">{fmt.ms(r.summary?.p95)}</td>
              <td className="r">{r.summary ? `${fmt.rps(r.summary.rps)}/s` : '—'}</td>
              <td className="muted">{r.triggeredBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
