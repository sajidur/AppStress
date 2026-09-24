import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card, Empty, fmt, Loading, useAction } from '../../components/ui';
import { useAsync } from '../../hooks';
import type { TabProps } from '../TestPage';

const SAMPLE = 'username,password,email\nuser001,Passw0rd!,user001@example.com\nuser002,Passw0rd!,user002@example.com\n';

export function UsersTab({ test, reload }: TabProps) {
  const { busy, run } = useAction();
  const users = useAsync(() => api.getUsers(test.id, 50), [test.id, test.dataset?.createdAt]);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const upload = async (file: File) => {
    const content = await file.text();
    const r = await run(() => api.uploadUsers(test.id, file.name, content), `Loaded ${file.name}`);
    if (r) await reload();
  };
  const remove = async () => {
    if (!confirm('Remove the users file from this test?')) return;
    await run(() => api.deleteUsers(test.id), 'Users removed');
    await reload();
  };
  const downloadSample = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/csv' }));
    a.download = 'users-sample.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const ds = users.data?.dataset;

  return (
    <div className="stack">
      <Card
        title="2. Test users"
        hint="Every virtual user logs in as a different user from this file. The first row is the header; column names become ${user.<column>} variables (e.g. ${user.username})."
        actions={
          <button className="btn small ghost" onClick={downloadSample}>
            Download sample CSV
          </button>
        }
      >
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            if (f) void upload(f);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
        >
          {busy ? (
            'Uploading…'
          ) : (
            <>
              <b>{ds ? 'Replace the users file' : 'Upload a users file'}</b>
              <div>Drop a .csv or .json file here, or click to choose</div>
            </>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </Card>

      {users.loading && !users.data ? (
        <Loading />
      ) : ds ? (
        <Card
          bodyless
          title={`${ds.filename} — ${fmt.num(ds.rowCount)} users`}
          hint={`Columns: ${ds.columns.join(', ')} · uploaded ${fmt.ago(ds.createdAt)} · sensitive columns are masked`}
          actions={
            <>
              <button className="btn small danger" onClick={remove} disabled={busy}>
                Remove
              </button>
              <Link className="btn small primary" to="../workflow">
                Next: workflow →
              </Link>
            </>
          }
        >
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table className="t">
              <thead>
                <tr>
                  <th className="r">#</th>
                  {ds.columns.map((c) => (
                    <th key={c}>
                      <code>{`\${user.${c}}`}</code>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ds.preview.map((row, i) => (
                  <tr key={i}>
                    <td className="r faint">{i}</td>
                    {ds.columns.map((c) => (
                      <td key={c}>{row[c]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ds.rowCount > ds.preview.length && (
            <div className="card-body faint" style={{ fontSize: 13 }}>
              Showing the first {ds.preview.length} of {fmt.num(ds.rowCount)} users.
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <Empty title="No users file">
            Optional if your flow needs no login; required when the workflow uses <code>{'${user.*}'}</code> values.
          </Empty>
        </Card>
      )}
    </div>
  );
}
