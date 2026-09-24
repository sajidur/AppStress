import { useState } from 'react';
import { api } from '../api';
import type { RunRow } from '../types';
import { RunsTable } from './RunsTable';
import { useAction } from './ui';

const ACTIVE = ['starting', 'running', 'stopping'];

/** A run list with checkboxes and the actions to clear run results (whole runs, or only their call details). */
export function RunsManager({ runs, showTest, reload }: { runs: RunRow[]; showTest?: boolean; reload: () => void | Promise<unknown> }) {
  const { busy, run } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const finished = runs.filter((r) => !ACTIVE.includes(r.status));
  const chosen = [...selected].filter((id) => runs.some((r) => r.id === id));
  const chosenFinished = chosen.filter((id) => finished.some((r) => r.id === id));

  const afterDelete = async (message: string) => {
    setSelected(new Set());
    await reload();
    return message;
  };
  const deleteSelected = async () => {
    if (!confirm(`Delete ${chosenFinished.length} run${chosenFinished.length === 1 ? '' : 's'} with their results and call details? This cannot be undone.`)) return;
    const r = await run(() => api.deleteRuns({ ids: chosenFinished }));
    if (r) await afterDelete('');
  };
  const deleteCalls = async () => {
    if (!confirm(`Delete the stored request and response details of ${chosenFinished.length} run${chosenFinished.length === 1 ? '' : 's'}? The runs and their statistics stay.`)) return;
    const r = await run(() => api.deleteRuns({ ids: chosenFinished, only: 'calls' }));
    if (r) await afterDelete('');
  };
  const deleteAll = async () => {
    if (!confirm(`Delete ALL ${finished.length} finished run${finished.length === 1 ? '' : 's'} listed here, with their results and call details? This cannot be undone.`)) return;
    const r = await run(() => api.deleteRuns({ ids: finished.map((x) => x.id) }));
    if (r) await afterDelete('');
  };

  return (
    <>
      <div className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {chosen.length ? `${chosen.length} selected` : 'Tick runs to delete them, or clear everything that has finished.'}
        </span>
        <div className="row">
          <button className="btn small" onClick={deleteCalls} disabled={busy || chosenFinished.length === 0} title="Keeps the runs and their numbers">
            Delete call details
          </button>
          <button className="btn small danger" onClick={deleteSelected} disabled={busy || chosenFinished.length === 0}>
            Delete selected
          </button>
          <button className="btn small danger" onClick={deleteAll} disabled={busy || finished.length === 0}>
            Delete all finished ({finished.length})
          </button>
        </div>
      </div>
      <RunsTable runs={runs} showTest={showTest} selection={{ selected, onChange: setSelected }} />
    </>
  );
}
