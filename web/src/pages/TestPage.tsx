import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Loading, useAction } from '../components/ui';
import { useAsync } from '../hooks';
import type { TestDetails } from '../types';
import { DataTab } from './tabs/DataTab';
import { RecordTab } from './tabs/RecordTab';
import { RunsTab } from './tabs/RunsTab';
import { SettingsTab } from './tabs/SettingsTab';
import { UsersTab } from './tabs/UsersTab';
import { WorkflowTab } from './tabs/WorkflowTab';

export interface TabProps {
  test: TestDetails;
  reload: () => Promise<void>;
}

function EditableTitle({ test, reload }: TabProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(test.name);
  const { run } = useAction();
  const save = async () => {
    setEditing(false);
    if (name.trim() && name !== test.name) {
      await run(() => api.updateTest(test.id, { name: name.trim() }));
      await reload();
    }
  };
  return editing ? (
    <input
      type="text"
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
      style={{ fontSize: 20, fontWeight: 650, maxWidth: 480 }}
    />
  ) : (
    <h1 onClick={() => setEditing(true)} title="Click to rename" style={{ cursor: 'text' }}>
      {test.name}
    </h1>
  );
}

export function TestPage() {
  const { id = '' } = useParams();
  const { data: test, error, loading, reload } = useAsync(() => api.getTest(id), [id]);

  if (error) return <div className="page"><ErrorBox error={error} retry={reload} /></div>;
  if (loading && !test) return <div className="page"><Loading /></div>;
  if (!test) return null;

  const steps = [
    { path: 'record', label: 'Record', done: !!test.recording },
    { path: 'users', label: 'Test users', done: !!test.dataset },
    { path: 'workflow', label: 'Workflow', done: !!test.workflow },
    { path: 'settings', label: 'Load & criteria', done: !!test.workflow },
    { path: 'runs', label: 'Run & reports', done: false },
  ];
  const next = steps.find((s) => !s.done)?.path ?? 'runs';
  const props: TabProps = { test, reload };

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/tests">Tests</Link> / {test.name}
      </div>
      <div className="page-header">
        <div>
          <EditableTitle key={test.name} {...props} />
          <div className="sub muted url-cell">{test.startUrl}</div>
        </div>
        {test.activeRuns.length > 0 && (
          <Link className="btn primary" to={`/runs/${test.activeRuns[0]}`}>
            ● Run in progress — view live
          </Link>
        )}
      </div>
      <nav className="stepper">
        {steps.map((s, i) => (
          <NavLink key={s.path} to={s.path}>
            <span className={`n ${s.done ? 'done' : ''}`}>{s.done ? '✓' : i + 1}</span>
            {s.label}
          </NavLink>
        ))}
        <NavLink to="data" className="stepper-extra">
          Data &amp; cleanup
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<Navigate to={next} replace />} />
        <Route path="record" element={<RecordTab {...props} />} />
        <Route path="users" element={<UsersTab {...props} />} />
        <Route path="workflow" element={<WorkflowTab {...props} />} />
        <Route path="settings" element={<SettingsTab {...props} />} />
        <Route path="runs" element={<RunsTab {...props} />} />
        <Route path="data" element={<DataTab {...props} />} />
      </Routes>
    </div>
  );
}
