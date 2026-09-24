import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card, Empty, Field, fmt, MethodTag, useAction, useToast } from '../../components/ui';
import type { BuildOptionsInput, Extractor, Step, ValidationResult, Workflow } from '../../types';
import type { TabProps } from '../TestPage';

const DEFAULT_OPTIONS: BuildOptionsInput = {
  userFields: {},
  includeDocuments: true,
  domains: [],
  exclude: [],
  minThinkMs: 500,
  maxThinkMs: 10_000,
  correlate: true,
};

/* ================================================================= build panel */

function BuildPanel({ test, reload, dirty }: TabProps & { dirty: boolean }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [opts, setOpts] = useState<BuildOptionsInput>(test.buildOptions ?? DEFAULT_OPTIONS);
  const [fields, setFields] = useState<[string, string][]>(() => Object.entries(test.buildOptions?.userFields ?? {}));
  const [advanced, setAdvanced] = useState(false);
  const columns = test.dataset?.columns ?? [];

  const detect = async () => {
    const r = await run(() => api.suggestUserFields(test.id));
    if (!r) return;
    const entries = Object.entries(r.userFields);
    if (!entries.length) toast('No users-file values were found in the recorded requests. Map them manually.', 'error');
    else {
      setFields(entries);
      toast(`Detected ${entries.map(([k]) => k).join(', ')}`);
    }
  };

  // Auto-detect once when a recording and a users file exist and nothing is mapped yet.
  useEffect(() => {
    if (!test.buildOptions && test.recording && test.dataset && fields.length === 0) void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const build = async () => {
    if ((test.workflow || dirty) && !confirm('Rebuilding replaces the current workflow, including your manual edits. Continue?')) return;
    const userFields = Object.fromEntries(fields.filter(([k, v]) => k.trim() && v !== ''));
    const r = await run(() => api.buildWorkflow(test.id, { ...opts, userFields }));
    if (r) {
      toast(`Workflow built: ${r.workflow.setup.length + r.workflow.steps.length} steps, ${r.report.correlations.length} dynamic values correlated`);
      await reload();
    }
  };

  if (!test.recording) {
    return (
      <Card>
        <Empty title="Nothing recorded yet" action={<Link className="btn primary" to="../record">Record the journey</Link>}>
          The workflow is generated from the recorded browser traffic.
        </Empty>
      </Card>
    );
  }

  return (
    <Card
      title="3. Build the workflow from the recording"
      hint="Recorded API calls become steps. Dynamic values (tokens, IDs, CSRF) are correlated automatically, and the values you typed are replaced with columns from the users file."
    >
      <div className="stack">
        <div>
          <div className="row between">
            <div className="label">Values typed during recording → users-file columns</div>
            <button className="btn small" onClick={detect} disabled={busy || !test.dataset}>
              Auto-detect
            </button>
          </div>
          <div className="help faint" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>
            e.g. column <code>username</code> ← recorded value <code>user001</code>. Every virtual user then sends its own value.
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {fields.map(([col, val], i) => (
              <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
                {columns.length ? (
                  <select value={col} onChange={(e) => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} style={{ maxWidth: 200 }}>
                    <option value="">column…</option>
                    {columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <input type="text" placeholder="column" value={col} onChange={(e) => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} style={{ maxWidth: 200 }} />
                )}
                <span className="faint">←</span>
                <input type="text" placeholder="value typed while recording" value={val} onChange={(e) => setFields(fields.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
                <button className="btn icon ghost" aria-label="Remove mapping" onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <div>
              <button className="btn small ghost" onClick={() => setFields([...fields, ['', '']])}>
                + Add mapping
              </button>
            </div>
          </div>
        </div>

        <div>
          <button className="btn small ghost" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾' : '▸'} Advanced options
          </button>
          {advanced && (
            <div className="grid-2" style={{ marginTop: 10 }}>
              <div className="stack" style={{ gap: 10 }}>
                <label className="check">
                  <input type="checkbox" checked={opts.includeDocuments} onChange={(e) => setOpts({ ...opts, includeDocuments: e.target.checked })} />
                  Include HTML page loads (not only XHR/fetch API calls)
                </label>
                <label className="check">
                  <input type="checkbox" checked={opts.correlate} onChange={(e) => setOpts({ ...opts, correlate: e.target.checked })} />
                  Correlate dynamic values automatically
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!opts.keepTracking} onChange={(e) => setOpts({ ...opts, keepTracking: e.target.checked })} />
                  Keep analytics / telemetry beacons (normally dropped)
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!opts.cacheLoginTtlSec}
                    onChange={(e) => setOpts({ ...opts, cacheLoginTtlSec: e.target.checked ? 600 : undefined })}
                  />
                  Share each user's login token across workers (Redis)
                </label>
                {opts.cacheLoginTtlSec !== undefined && (
                  <Field label="Token cache TTL (seconds)" help="Only for token-based logins; session-cookie logins must not be shared.">
                    <input type="number" min={1} value={opts.cacheLoginTtlSec} onChange={(e) => setOpts({ ...opts, cacheLoginTtlSec: Number(e.target.value) || 1 })} />
                  </Field>
                )}
                <div className="grid-2">
                  <Field label="Ignore pauses under (ms)">
                    <input type="number" min={0} value={opts.minThinkMs} onChange={(e) => setOpts({ ...opts, minThinkMs: Number(e.target.value) })} />
                  </Field>
                  <Field label="Cap think time at (ms)">
                    <input type="number" min={0} value={opts.maxThinkMs} onChange={(e) => setOpts({ ...opts, maxThinkMs: Number(e.target.value) })} />
                  </Field>
                </div>
              </div>
              <div className="stack" style={{ gap: 10 }}>
                <Field label="Only keep these hosts" help="One per line (suffix match). Empty = the start URL's site domain and all its subdomains.">
                  <textarea rows={3} value={opts.domains.join('\n')} onChange={(e) => setOpts({ ...opts, domains: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
                </Field>
                <Field label="Exclude URLs matching" help="Regular expressions, one per line (e.g. analytics|telemetry).">
                  <textarea rows={3} value={opts.exclude.join('\n')} onChange={(e) => setOpts({ ...opts, exclude: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
                </Field>
              </div>
            </div>
          )}
        </div>

        <div className="row">
          <button className="btn primary" onClick={build} disabled={busy}>
            {test.workflow ? 'Rebuild workflow' : 'Build workflow'}
          </button>
          {test.workflow && <span className="faint">Rebuilding discards manual step edits.</span>}
        </div>

        {test.buildReport && test.buildReport.correlations.length > 0 && (
          <div>
            <div className="section-title">Correlated dynamic values</div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Extracted from</th>
                    <th>How</th>
                    <th>Used in</th>
                  </tr>
                </thead>
                <tbody>
                  {test.buildReport.correlations.map((c) => (
                    <tr key={c.variable}>
                      <td>
                        <code>{`\${${c.variable}}`}</code>
                      </td>
                      <td className="mono">{c.source}</td>
                      <td className="url-cell" style={{ maxWidth: 280 }} title={c.extractor}>
                        {c.extractor}
                      </td>
                      <td className="muted">{c.usedIn.length} step(s)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ================================================================= step editor */

const headersToText = (h?: Record<string, string>) => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const textToHeaders = (t: string) => {
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

function StepEditor({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  const [headersText, setHeadersText] = useState(headersToText(step.request.headers));
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch });
  const setReq = (patch: Partial<Step['request']>) => onChange({ ...step, request: { ...step.request, ...patch } });
  const extractors = step.extract ?? [];
  const setEx = (i: number, patch: Partial<Extractor>) => set({ extract: extractors.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  return (
    <div className="step-edit">
      <div className="grid-2">
        <Field label="Step name">
          <input type="text" value={step.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Think time before this step (ms)">
          <input type="number" min={0} value={step.thinkTimeMs ?? 0} onChange={(e) => set({ thinkTimeMs: Number(e.target.value) || undefined })} />
        </Field>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
        <div style={{ width: 120 }}>
          <Field label="Method">
            <select value={step.request.method} onChange={(e) => setReq({ method: e.target.value })}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="URL">
            <input type="text" className="mono" value={step.request.url} onChange={(e) => setReq({ url: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="grid-2">
        <Field label="Headers" help="One per line: Name: value">
          <textarea
            rows={5}
            value={headersText}
            onChange={(e) => {
              setHeadersText(e.target.value);
              setReq({ headers: textToHeaders(e.target.value) });
            }}
          />
        </Field>
        <Field label="Body">
          <textarea rows={5} value={step.request.body ?? ''} onChange={(e) => setReq({ body: e.target.value || undefined })} />
        </Field>
      </div>

      <div>
        <div className="section-title">Assertions</div>
        <div className="grid-2">
          <Field label="Expected status codes" help="Comma separated. Empty = any status below 400.">
            <input
              type="text"
              placeholder="200, 201"
              value={step.expect?.status?.join(', ') ?? ''}
              onChange={(e) => {
                const status = e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => n >= 100 && n <= 599);
                set({ expect: { ...step.expect, status: status.length ? status : undefined } });
              }}
            />
          </Field>
          <Field label="Response body must contain">
            <input type="text" value={step.expect?.bodyContains ?? ''} onChange={(e) => set({ expect: { ...step.expect, bodyContains: e.target.value || undefined } })} />
          </Field>
        </div>
      </div>

      <div>
        <div className="section-title">Extract variables from the response</div>
        {extractors.map((ex, i) => (
          <div className="row" key={i} style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
            <input type="text" className="mono" style={{ maxWidth: 150 }} placeholder="variable" value={ex.var} onChange={(e) => setEx(i, { var: e.target.value })} />
            <select style={{ maxWidth: 130 }} value={ex.from} onChange={(e) => setEx(i, { from: e.target.value as Extractor['from'] })}>
              <option value="body">JSON path</option>
              <option value="header">Header</option>
              <option value="cookie">Cookie</option>
              <option value="regex">Regex</option>
              <option value="status">Status</option>
            </select>
            {ex.from !== 'status' && (
              <input
                type="text"
                className="mono"
                placeholder={ex.from === 'body' ? '$.data.token' : ex.from === 'regex' ? 'id="(\\d+)"' : 'name'}
                value={(ex.from === 'body' ? ex.path : ex.from === 'regex' ? ex.regex : ex.name) ?? ''}
                onChange={(e) => setEx(i, ex.from === 'body' ? { path: e.target.value } : ex.from === 'regex' ? { regex: e.target.value } : { name: e.target.value })}
              />
            )}
            <label className="check" title="Do not fail the step when nothing matches">
              <input type="checkbox" checked={!!ex.optional} onChange={(e) => setEx(i, { optional: e.target.checked || undefined })} /> optional
            </label>
            <button className="btn icon ghost" aria-label="Remove extractor" onClick={() => set({ extract: extractors.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn small ghost" onClick={() => set({ extract: [...extractors, { var: '', from: 'body', path: '$.' }] })}>
          + Add extractor
        </button>
      </div>
    </div>
  );
}

function StepList({
  title,
  hint,
  steps,
  phase,
  onChange,
  onMovePhase,
}: {
  title: string;
  hint: string;
  steps: Step[];
  phase: 'setup' | 'steps';
  onChange: (steps: Step[]) => void;
  onMovePhase: (index: number) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const copy = [...steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
    setOpen(open === i ? j : open);
  };
  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div>
          <h3>{title}</h3>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {hint}
          </div>
        </div>
      </div>
      {steps.length === 0 && <div className="faint" style={{ padding: '8px 0' }}>No steps.</div>}
      {steps.map((s, i) => (
        <div className="step-row" key={i}>
          <div className="step-head" onClick={() => setOpen(open === i ? null : i)}>
            <span className="faint num" style={{ width: 20 }}>
              {i + 1}
            </span>
            <MethodTag method={s.request.method} />
            <span className="name" title={s.request.url}>
              {s.name.startsWith(`${s.request.method.toUpperCase()} `) ? s.name.slice(s.request.method.length + 1) : s.name}
            </span>
            {(s.thinkTimeMs ?? 0) > 0 && <span className="chip">⏱ {fmt.ms(s.thinkTimeMs)}</span>}
            {(s.extract?.length ?? 0) > 0 && <span className="chip">⇢ {s.extract!.map((e) => e.var).join(', ')}</span>}
            {s.expect && (s.expect.status || s.expect.bodyContains) && <span className="chip">✓ assert</span>}
            {s.cache && <span className="chip">shared</span>}
            <div className="row" style={{ flexWrap: 'nowrap', gap: 2 }} onClick={(e) => e.stopPropagation()}>
              <button className="btn icon ghost" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button className="btn icon ghost" title="Move down" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>
                ↓
              </button>
              <button className="btn small ghost" title={phase === 'setup' ? 'Run every iteration instead' : 'Run once per virtual user instead'} onClick={() => onMovePhase(i)}>
                {phase === 'setup' ? '→ iteration' : '→ setup'}
              </button>
              <button
                className="btn icon ghost danger"
                title="Delete step"
                onClick={() => {
                  onChange(steps.filter((_, j) => j !== i));
                  setOpen(null);
                }}
              >
                ✕
              </button>
            </div>
          </div>
          {open === i && <StepEditor step={s} onChange={(ns) => onChange(steps.map((x, j) => (j === i ? ns : x)))} />}
        </div>
      ))}
    </div>
  );
}

/* ================================================================= validation */

function ValidatePanel({ test, dirty }: TabProps & { dirty: boolean }) {
  const { busy, run } = useAction();
  const [userIndex, setUserIndex] = useState(0);
  const [iterations, setIterations] = useState(1);
  const [result, setResult] = useState<ValidationResult | null>(null);

  const go = async () => {
    const r = await run(() => api.validateWorkflow(test.id, { userIndex, iterations }));
    if (r) setResult(r);
  };

  return (
    <Card
      title="Validate with one user"
      hint="Runs the saved workflow once, with no load, and shows every request, assertion and extracted value. Fix failures here before running a load test."
      actions={
        <>
          {test.dataset && (
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">User #</span>
              <input type="number" min={0} max={test.dataset.rowCount - 1} value={userIndex} onChange={(e) => setUserIndex(Number(e.target.value))} style={{ width: 90 }} />
            </label>
          )}
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">Iterations</span>
            <input type="number" min={1} max={5} value={iterations} onChange={(e) => setIterations(Number(e.target.value))} style={{ width: 70 }} />
          </label>
          <button className="btn primary" onClick={go} disabled={busy || dirty} title={dirty ? 'Save your changes first' : undefined}>
            {busy ? 'Running…' : '▶ Validate'}
          </button>
        </>
      }
    >
      {!result ? (
        <div className="faint">{dirty ? 'Save your changes, then validate.' : 'Not validated yet.'}</div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className={`callout ${result.passed ? 'good' : 'bad'}`}>
            {result.passed ? '✓ All steps passed' : '✕ Validation failed'}
            {result.user && (
              <span className="muted">
                {' '}
                — as user #{result.userIndex}: {Object.entries(result.user).map(([k, v]) => `${k}=${v}`).join(', ')}
              </span>
            )}
          </div>
          {result.traces.map((t, i) => (
            <div key={i} className={`trace ${t.error ? 'fail' : 'ok'}`}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span className="faint" style={{ width: 80, fontSize: 12 }}>
                  {t.phase}
                </span>
                <span className={`badge ${t.cached ? 'info' : t.error ? 'bad' : 'good'}`}>{t.cached ? 'cache' : t.status || 'ERR'}</span>
                <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.step}
                </span>
                <span className="muted num">{fmt.ms(t.durationMs)}</span>
              </div>
              {Object.keys(t.extracted).length > 0 && (
                <div className="mono faint" style={{ marginLeft: 88, fontSize: 12 }}>
                  {Object.entries(t.extracted).map(([k, v]) => (
                    <div key={k}>
                      {k} = {v.length > 90 ? `${v.slice(0, 87)}…` : v}
                    </div>
                  ))}
                </div>
              )}
              {t.error && (
                <div style={{ marginLeft: 88, fontSize: 13 }}>
                  <div style={{ color: 'var(--critical-text)', fontWeight: 600 }}>{t.error}</div>
                  <div className="mono faint">
                    {t.method} {t.url}
                  </div>
                  {t.responseSnippet && <div className="mono faint">response: {t.responseSnippet.slice(0, 240)}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ================================================================= tab */

export function WorkflowTab(props: TabProps) {
  const { test, reload } = props;
  const toast = useToast();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Workflow | null>(test.workflow);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const saved = JSON.stringify(test.workflow);
  const dirty = useMemo(() => (jsonMode ? jsonText !== JSON.stringify(test.workflow, null, 2) : JSON.stringify(draft) !== saved), [draft, saved, jsonMode, jsonText, test.workflow]);

  useEffect(() => {
    setDraft(test.workflow);
    setJsonText(JSON.stringify(test.workflow, null, 2));
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    let wf = draft;
    if (jsonMode) {
      try {
        wf = JSON.parse(jsonText);
      } catch (e) {
        toast(`Invalid JSON: ${(e as Error).message}`, 'error');
        return;
      }
    }
    if (!wf) return;
    const r = await run(() => api.saveWorkflow(test.id, wf!), 'Workflow saved');
    if (r) await reload();
  };
  const discard = () => {
    setDraft(test.workflow);
    setJsonText(JSON.stringify(test.workflow, null, 2));
  };
  const toggleJson = () => {
    if (jsonMode) {
      try {
        setDraft(JSON.parse(jsonText));
      } catch (e) {
        toast(`Invalid JSON: ${(e as Error).message}`, 'error');
        return;
      }
    } else setJsonText(JSON.stringify(draft, null, 2));
    setJsonMode(!jsonMode);
  };

  return (
    <div className="stack">
      <BuildPanel {...props} dirty={dirty} />
      {draft && (
        <Card
          title="Steps"
          hint={`${draft.setup.length + draft.steps.length} requests · variables: ${Object.keys(draft.variables).join(', ') || 'none'}`}
          actions={
            <>
              <button className="btn small ghost" onClick={toggleJson}>
                {jsonMode ? 'Visual editor' : 'Edit JSON'}
              </button>
              {dirty && (
                <button className="btn small" onClick={discard} disabled={busy}>
                  Discard
                </button>
              )}
              <button className="btn small primary" onClick={save} disabled={busy || !dirty}>
                Save changes
              </button>
            </>
          }
        >
          {jsonMode ? (
            <textarea rows={28} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
          ) : (
            <div className="stack">
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.onError === 'continue'}
                  onChange={(e) => setDraft({ ...draft, onError: e.target.checked ? 'continue' : 'abortIteration' })}
                />
                Continue the iteration after a failed step (default: abort the iteration, since later steps usually depend on earlier ones)
              </label>
              <StepList
                title="Setup — runs once per virtual user"
                hint="Typically the login. Values extracted here (tokens, session) are reused by every iteration."
                steps={draft.setup}
                phase="setup"
                onChange={(setup) => setDraft({ ...draft, setup })}
                onMovePhase={(i) => setDraft({ ...draft, setup: draft.setup.filter((_, j) => j !== i), steps: [draft.setup[i], ...draft.steps] })}
              />
              <StepList
                title="Iteration — repeats for the whole test"
                hint="The business transaction each virtual user performs over and over."
                steps={draft.steps}
                phase="steps"
                onChange={(steps) => setDraft({ ...draft, steps })}
                onMovePhase={(i) => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i), setup: [...draft.setup, draft.steps[i]] })}
              />
              <div>
                <button
                  className="btn small ghost"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      steps: [...draft.steps, { name: `New request ${draft.steps.length + 1}`, request: { method: 'GET', url: '${baseUrl}/' } }],
                    })
                  }
                >
                  + Add request
                </button>
              </div>
            </div>
          )}
        </Card>
      )}
      {test.workflow && <ValidatePanel {...props} dirty={dirty} />}
      {test.workflow && !dirty && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Link className="btn primary" to="../settings">
            Next: load &amp; pass/fail criteria →
          </Link>
        </div>
      )}
    </div>
  );
}
