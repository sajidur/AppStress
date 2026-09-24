import { useNavigate } from 'react-router-dom';
import type { RunRow } from '../types';
import { fmt, StatusBadge, VerdictBadge } from './ui';

const ACTIVE = ['starting', 'running', 'stopping'];

export function RunsTable({
  runs,
  showTest,
  selection,
}: {
  runs: RunRow[];
  showTest?: boolean;
  /** shows a checkbox per run; active runs cannot be selected */
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void };
}) {
  const nav = useNavigate();
  const selectable = runs.filter((r) => !ACTIVE.includes(r.status));
  const allOn = !!selection && selectable.length > 0 && selectable.every((r) => selection.selected.has(r.id));
  const toggle = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (!next.delete(id)) next.add(id);
    selection.onChange(next);
  };
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {selection && (
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  aria-label="Select all finished runs"
                  checked={allOn}
                  disabled={selectable.length === 0}
                  onChange={(e) => selection.onChange(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())}
                />
              </th>
            )}
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
              {selection && (
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select run ${r.id}`}
                    checked={selection.selected.has(r.id)}
                    disabled={ACTIVE.includes(r.status)}
                    title={ACTIVE.includes(r.status) ? 'Stop the run before deleting it' : undefined}
                    onChange={() => toggle(r.id)}
                  />
                </td>
              )}
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
