import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card, Field, fmt, MethodTag, Spinner, useAction, useToast } from '../../components/ui';
import { useAsync, useEventStream } from '../../hooks';
import type { ExchangeSummary } from '../../types';
import type { TabProps } from '../TestPage';

type RecEvent =
  | { type: 'idle' }
  | { type: 'started' }
  | { type: 'exchange'; exchange: ExchangeSummary }
  | { type: 'finished'; exchangeCount: number; apiCount: number }
  | { type: 'failed'; error: string };

const API_TYPES = ['xhr', 'fetch', 'document'];

function ExchangeTable({ rows, apiOnly }: { rows: ExchangeSummary[]; apiOnly: boolean }) {
  const shown = apiOnly ? rows.filter((r) => API_TYPES.includes(r.resourceType)) : rows;
  if (!shown.length) return <div className="empty faint">No requests captured yet.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 460 }}>
      <table className="t">
        <thead>
          <tr>
            <th>Method</th>
            <th>URL</th>
            <th>Type</th>
            <th className="r">Status</th>
            <th className="r">Time</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td>
                <MethodTag method={r.method} />
              </td>
              <td className="url-cell" title={r.url}>
                {r.url}
              </td>
              <td className="muted">{r.resourceType}</td>
              <td className="r">
                {r.failure ? (
                  <span className="badge bad">failed</span>
                ) : (
                  <span className={`badge ${(r.status ?? 0) >= 400 ? 'bad' : (r.status ?? 0) >= 300 ? 'warn' : 'good'}`}>{r.status}</span>
                )}
              </td>
              <td className="r muted">{fmt.ms(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RecordTab({ test, reload }: TabProps) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [url, setUrl] = useState(test.startUrl);
  const [timeoutSec, setTimeoutSec] = useState('');
  const [live, setLive] = useState<ExchangeSummary[]>([]);
  const [recording, setRecording] = useState(test.recordingActive);
  const [apiOnly, setApiOnly] = useState(true);
  const saved = useAsync(() => api.getRecording(test.id), [test.id, test.recording?.createdAt]);
  const fileInput = useRef<HTMLInputElement>(null);
  const system = useAsync(() => api.system(), []);
  const recorderEnabled = system.data?.recorderEnabled !== false;

  useEventStream<RecEvent>(api.recordingEventsUrl(test.id), (e) => {
    if (e.type === 'started') {
      setRecording(true);
      setLive([]);
    } else if (e.type === 'exchange') setLive((l) => (l.some((x) => x.id === e.exchange.id) ? l : [...l, e.exchange]));
    else if (e.type === 'finished') {
      setRecording(false);
      toast(`Recording saved: ${e.apiCount} API/page requests captured`);
      void reload();
    } else if (e.type === 'failed') {
      setRecording(false);
      toast(`Recording failed: ${e.error}`, 'error');
    } else if (e.type === 'idle') setRecording(false);
  });

  useEffect(() => setUrl(test.startUrl), [test.startUrl]);

  const start = () =>
    run(async () => {
      await api.startRecording(test.id, { url, timeoutSec: timeoutSec ? Number(timeoutSec) : undefined });
      setLive([]);
      setRecording(true);
    });
  const stop = () => run(() => api.stopRecording(test.id));

  const importFile = async (file: File) => {
    const content = await file.text();
    const r = await run(() => api.importRecording(test.id, content), `Imported ${file.name}`);
    if (r) await reload();
  };

  const rows = recording ? live : (saved.data?.recording?.exchanges ?? []);
  const apiCount = useMemo(() => rows.filter((r) => API_TYPES.includes(r.resourceType)).length, [rows]);

  return (
    <div className="stack">
      <Card
        title="1. Record the user journey"
        hint="A Chromium window opens on the machine running Load Test Studio. Perform the business flow exactly as a real user would (log in, navigate, submit forms), then close the window or press Stop."
      >
        <div className="stack">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <Field label="Start URL" htmlFor="rurl">
                <input id="rurl" type="url" value={url} disabled={recording} onChange={(e) => setUrl(e.target.value)} />
              </Field>
            </div>
            <div style={{ width: 170 }}>
              <Field label="Auto-stop after (s)" htmlFor="rto">
                <input id="rto" type="number" min={5} placeholder="off" value={timeoutSec} disabled={recording} onChange={(e) => setTimeoutSec(e.target.value)} />
              </Field>
            </div>
            {recording ? (
              <button className="btn danger solid large" onClick={stop} disabled={busy}>
                ■ Stop &amp; save
              </button>
            ) : (
              <button className="btn primary large" onClick={start} disabled={busy || !recorderEnabled || !/^https?:\/\//.test(url)}>
                ● {test.recording ? 'Re-record' : 'Start recording'}
              </button>
            )}
          </div>
          {!recorderEnabled && (
            <div className="callout warn">
              Live recording is disabled on this server (no display). Record the journey in your browser's DevTools and import the HAR file below, or run{' '}
              <code>npx lt record &lt;url&gt;</code> on your machine and import the resulting file.
            </div>
          )}
          {recording && (
            <div className="callout row">
              <Spinner /> <b>Recording…</b> {apiCount} API/page requests captured so far. Use the browser window that just opened.
            </div>
          )}
          {!recording && test.recording && (
            <div className="callout good row between">
              <span>
                ✓ Recording saved {fmt.ago(test.recording.createdAt)} ({test.recording.source}): <b>{test.recording.apiCount}</b> API/page requests out of{' '}
                {test.recording.exchangeCount} total.
              </span>
              <Link className="btn small primary" to="../users">
                Next: test users →
              </Link>
            </div>
          )}
          <div className="row faint" style={{ fontSize: 13 }}>
            Recording on a remote server without a display? Record in your browser's DevTools (Network → Save all as HAR) and
            <button className="btn small" onClick={() => fileInput.current?.click()} disabled={recording || busy}>
              Import HAR / recording file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".har,.json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </Card>

      {(rows.length > 0 || recording) && (
        <Card
          bodyless
          title={recording ? 'Live capture' : 'Captured requests'}
          hint={`${apiCount} API/page requests · ${rows.length} total including static assets`}
          actions={
            <label className="check">
              <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} /> API &amp; page requests only
            </label>
          }
        >
          <ExchangeTable rows={rows} apiOnly={apiOnly} />
        </Card>
      )}
    </div>
  );
}
