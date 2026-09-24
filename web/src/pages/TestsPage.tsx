import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, ErrorBox, Field, fmt, Loading, Modal, useAction, VerdictBadge } from '../components/ui';
import { useAsync } from '../hooks';

export function NewTestModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const valid = name.trim() && /^https?:\/\/.+/.test(url.trim());
  const submit = async () => {
    const t = await run(() => api.createTest({ name: name.trim(), startUrl: url.trim() }));
    if (t) nav(`/tests/${t.id}/record`);
  };
  return (
    <Modal
      title="New load test"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={submit}>
            Create and start recording
          </button>
        </>
      }
    >
      <Field label="Test name" htmlFor="tn">
        <input id="tn" type="text" autoFocus placeholder="e.g. Checkout flow" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Application URL" htmlFor="tu" help="The page where the recorded user journey starts.">
        <input id="tu" type="url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && submit()} />
      </Field>
    </Modal>
  );
}

export function TestsPage() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useAsync(() => api.listTests(), []);
  const [creating, setCreating] = useState(false);
  const { run } = useAction();

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete test "${name}" and all its runs? This cannot be undone.`)) return;
    await run(() => api.deleteTest(id), 'Test deleted');
    void reload();
  };
  const duplicate = async (id: string) => {
    const copy = await run(() => api.duplicateTest(id), 'Test duplicated');
    if (copy) nav(`/tests/${copy.id}/workflow`);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Load tests</h1>
          <div className="sub muted">Record a user journey, attach test users, configure the load and run it on the distributed workers.</div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          + New test
        </button>
      </div>
      {creating && <NewTestModal onClose={() => setCreating(false)} />}
      {error && <ErrorBox error={error} retry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : data && data.length === 0 ? (
        <Card>
          <Empty title="No tests yet" action={<button className="btn primary" onClick={() => setCreating(true)}>Create your first test</button>}>
            A test captures a real browser journey and replays its API calls with many virtual users.
          </Empty>
        </Card>
      ) : (
        data && (
          <Card bodyless>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th className="r">Recorded requests</th>
                    <th className="r">Workflow steps</th>
                    <th className="r">Test users</th>
                    <th>Last result</th>
                    <th className="r">Runs</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => nav(`/tests/${t.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.name}</div>
                        <div className="faint url-cell" style={{ maxWidth: 360 }}>
                          {t.startUrl}
                        </div>
                      </td>
                      <td className="r">{t.recordedRequests || <span className="faint">—</span>}</td>
                      <td className="r">{t.stepCount || <span className="faint">—</span>}</td>
                      <td className="r">{t.users ? fmt.num(t.users) : <span className="faint">—</span>}</td>
                      <td>
                        <VerdictBadge verdict={t.lastVerdict} />
                      </td>
                      <td className="r">{t.runCount}</td>
                      <td className="muted">{fmt.ago(t.updatedAt)}</td>
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn small ghost" onClick={() => duplicate(t.id)}>
                            Duplicate
                          </button>
                          <button className="btn small ghost danger" onClick={() => remove(t.id, t.name)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      )}
    </div>
  );
}
