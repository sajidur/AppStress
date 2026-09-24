import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Card, ErrorBox, fmt, Loading, useAction } from '../../components/ui';
import { useAsync } from '../../hooks';
import type { TabProps } from '../TestPage';

type Clear = Parameters<typeof api.clearTestData>[1];

function Row({ title, detail, empty, onDelete, label, disabled, hint }: { title: string; detail: ReactNode; empty: boolean; onDelete: () => void; label: string; disabled?: boolean; hint?: string }) {
  return (
    <div className="data-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className={empty ? 'faint' : 'muted'} style={{ fontSize: 13 }}>
          {detail}
        </div>
      </div>
      <button className="btn small danger" onClick={onDelete} disabled={disabled || empty} title={hint}>
        {label}
      </button>
    </div>
  );
}

/** What is stored for this test, and buttons to clear each part (or everything). */
export function DataTab({ test, reload }: TabProps) {
  const nav = useNavigate();
  const { busy, run } = useAction();
  const data = useAsync(() => api.testData(test.id), [test.id]);
  const d = data.data;

  const clear = async (what: Clear, question: string, done: string) => {
    if (!confirm(question)) return;
    const r = await run(() => api.clearTestData(test.id, what), done);
    if (r) {
      await Promise.all([data.reload(), reload()]);
    }
  };
  const deleteTest = async () => {
    if (!confirm(`Delete the test "${test.name}" with its recording, workflow, users, settings and every run? This cannot be undone.`)) return;
    // a delete returns no body, so report success explicitly (run() returns undefined on failure)
    const ok = await run(async () => (await api.deleteTest(test.id), true), 'Test deleted');
    if (ok) nav('/tests');
  };

  if (data.error) return <ErrorBox error={data.error} retry={data.reload} />;
  if (!d) return <Loading />;
  const activeRun = d.runs.active > 0;

  return (
    <div className="stack">
      <Card title="Stored data" hint="Everything kept for this test, and roughly how much space it takes. Deleting is permanent. The test itself, its name and its settings stay unless you delete the whole test.">
        <div className="stack" style={{ gap: 0 }}>
          <Row
            title="Recording"
            detail={d.recording ? `${fmt.num(d.recording.exchanges)} recorded request${d.recording.exchanges === 1 ? '' : 's'} · ${fmt.bytes(d.recording.bytes)}` : 'Nothing recorded'}
            empty={!d.recording}
            label="Delete recording"
            disabled={busy || d.recordingActive}
            hint={d.recordingActive ? 'Stop the active recording first' : 'The workflow built from it stays'}
            onDelete={() => clear({ recording: true }, 'Delete the recorded requests? The workflow built from them stays, but you can no longer rebuild it or browse the recorded responses.', 'Recording deleted')}
          />
          <Row
            title="Workflow"
            detail={d.workflow ? `${d.workflow.steps} steps` : 'Not built'}
            empty={!d.workflow}
            label="Delete workflow"
            disabled={busy}
            hint="Includes your manual step edits"
            onDelete={() => clear({ workflow: true }, 'Delete the workflow, including your manual step edits? You can build it again from the recording.', 'Workflow deleted')}
          />
          <Row
            title="Test users"
            detail={d.users ? `${fmt.num(d.users.rows)} user${d.users.rows === 1 ? '' : 's'} · ${fmt.bytes(d.users.bytes)}` : 'No users file'}
            empty={!d.users}
            label="Delete users"
            disabled={busy}
            onDelete={() => clear({ users: true }, 'Delete the users file?', 'Users deleted')}
          />
          <Row
            title="Request and response details"
            detail={d.calls.count ? `${fmt.num(d.calls.count)} stored calls across the runs · ${fmt.bytes(d.calls.bytes)}` : 'None stored'}
            empty={d.calls.count === 0}
            label="Delete call details"
            disabled={busy || activeRun}
            hint={activeRun ? 'Stop the active run first' : 'The runs and their numbers stay'}
            onDelete={() => clear({ calls: true }, 'Delete the stored request and response details of every run of this test? The runs and their statistics stay.', 'Call details deleted')}
          />
          <Row
            title="Run results"
            detail={d.runs.count ? `${fmt.num(d.runs.count)} run${d.runs.count === 1 ? '' : 's'}${activeRun ? ` (${d.runs.active} still running)` : ''} · ${fmt.bytes(d.runs.bytes + d.calls.bytes)} with their call details` : 'No runs'}
            empty={d.runs.count === 0}
            label="Delete all runs"
            disabled={busy || activeRun}
            hint={activeRun ? 'Stop the active run first' : undefined}
            onDelete={() => clear({ runs: true }, `Delete all ${d.runs.count} runs of this test with their results, reports and call details?`, 'Runs deleted')}
          />
        </div>
      </Card>

      <Card title="Start over" hint="For when you want a clean slate.">
        <div className="row">
          <button
            className="btn danger"
            disabled={busy || activeRun || d.recordingActive}
            onClick={() =>
              clear(
                { recording: true, workflow: true, users: true, runs: true },
                'Clear ALL data of this test: the recording, workflow, users file and every run? Its name and settings stay. This cannot be undone.',
                'Test data cleared',
              )
            }
          >
            Clear all data, keep the test
          </button>
          <button className="btn danger solid" disabled={busy || activeRun || d.recordingActive} onClick={deleteTest}>
            Delete the whole test
          </button>
        </div>
        {(activeRun || d.recordingActive) && <div className="callout warn" style={{ marginTop: 10 }}>{d.recordingActive ? 'A recording is in progress.' : 'A run is in progress.'} Stop it before clearing this data.</div>}
      </Card>
    </div>
  );
}
