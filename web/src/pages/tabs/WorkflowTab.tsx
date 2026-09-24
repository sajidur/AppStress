import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import {
  BindField,
  JsonFieldTable,
  ParamTable,
  PickExtractorDialog,
  Section,
  type BindContext,
} from '../../components/bindings';
import { Card, Empty, Field, fmt, MethodTag, useAction, useToast } from '../../components/ui';
import {
  availableVars,
  detectAuth,
  detectBodyKind,
  formFields,
  joinForm,
  joinUrl,
  jsonFields,
  placeholdersIn,
  setJsonField,
  splitUrl,
  stripAuthorization,
  unresolvedVars,
  usedStepVars,
  type StepRef,
} from '../../bindings';
import { CallDetail } from '../../components/CallDetail';
import { useAsync } from '../../hooks';
import type { AuthConfig, BuildOptionsInput, Extractor, Step, ValidationResult, Workflow } from '../../types';
import type { TabProps } from '../TestPage';

/* ================================================================= which recorded requests count as steps */

interface RequestKind {
  id: string;
  label: string;
  help: string;
  /** Playwright resource types covered by this checkbox */
  types: string[];
}

const REQUEST_KINDS: RequestKind[] = [
  { id: 'document', label: 'Pages (document)', help: 'HTML page loads and form posts', types: ['document'] },
  { id: 'xhr', label: 'API calls (XHR / fetch)', help: 'JSON / AJAX requests made by the page', types: ['xhr', 'fetch'] },
  { id: 'script', label: 'JavaScript (js)', help: 'Script files', types: ['script'] },
  { id: 'stylesheet', label: 'CSS', help: 'Stylesheets', types: ['stylesheet'] },
  { id: 'image', label: 'Images', help: 'Pictures and icons', types: ['image'] },
  { id: 'font', label: 'Fonts', help: 'Web fonts', types: ['font'] },
  { id: 'media', label: 'Media', help: 'Audio / video', types: ['media'] },
  { id: 'other', label: 'Other', help: 'Everything else (manifest, websocket, ...)', types: ['other', 'manifest', 'eventsource', 'texttrack', 'websocket'] },
];

const DEFAULT_TYPES = ['document', 'xhr', 'fetch'];

const DEFAULT_OPTIONS: BuildOptionsInput = {
  userFields: {},
  includeDocuments: true,
  resourceTypes: DEFAULT_TYPES,
  domains: [],
  exclude: [],
  minThinkMs: 500,
  maxThinkMs: 10_000,
  correlate: true,
};

/** Options saved before request types existed only have includeDocuments. */
function initialOptions(saved: BuildOptionsInput | null): BuildOptionsInput {
  if (!saved) return DEFAULT_OPTIONS;
  return { ...saved, resourceTypes: saved.resourceTypes ?? (saved.includeDocuments === false ? ['xhr', 'fetch'] : DEFAULT_TYPES) };
}

/* ================================================================= build panel */

function BuildPanel({ test, reload, dirty }: TabProps & { dirty: boolean }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [opts, setOpts] = useState<BuildOptionsInput>(() => initialOptions(test.buildOptions));
  const [fields, setFields] = useState<[string, string][]>(() => Object.entries(test.buildOptions?.userFields ?? {}));
  const [advanced, setAdvanced] = useState(false);
  const columns = test.dataset?.columns ?? [];
  const recorded = useAsync(() => api.getRecording(test.id), [test.id, test.recording?.createdAt]);

  const selected = new Set(opts.resourceTypes ?? DEFAULT_TYPES);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of recorded.data?.recording?.exchanges ?? []) c.set(e.resourceType, (c.get(e.resourceType) ?? 0) + 1);
    return c;
  }, [recorded.data]);
  const countOf = (k: RequestKind) => k.types.reduce((n, t) => n + (counts.get(t) ?? 0), 0);
  const toggleKind = (k: RequestKind, on: boolean) => {
    const next = new Set(selected);
    for (const t of k.types) (on ? next.add(t) : next.delete(t));
    setOpts({ ...opts, resourceTypes: [...next], includeDocuments: next.has('document') });
  };

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
    if (selected.size === 0) {
      toast('Select at least one request type to test.', 'error');
      return;
    }
    if ((test.workflow || dirty) && !confirm('Rebuilding replaces the current workflow, including your manual edits. Continue?')) return;
    const userFields = Object.fromEntries(fields.filter(([k, v]) => k.trim() && v !== ''));
    const r = await run(() => api.buildWorkflow(test.id, { ...opts, includeDocuments: selected.has('document'), userFields }));
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
      hint="Recorded requests become steps. Dynamic values (tokens, IDs, CSRF) are correlated automatically, and the values you typed are replaced with columns from the users file."
    >
      <div className="stack">
        <div>
          <div className="label">Request types that count as test steps</div>
          <div className="help faint" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>
            Only the checked types of recorded requests become steps in the test. The number is how many of each were recorded.
          </div>
          <div className="kind-grid">
            {REQUEST_KINDS.map((k) => {
              const n = countOf(k);
              return (
                <label className="check kind" key={k.id} title={k.help}>
                  <input type="checkbox" checked={k.types.some((t) => selected.has(t))} onChange={(e) => toggleKind(k, e.target.checked)} />
                  <span>{k.label}</span>
                  {recorded.data && <span className="chip">{n}</span>}
                </label>
              );
            })}
          </div>
          {selected.size === 0 && <div className="callout warn" style={{ marginTop: 8 }}>Select at least one request type.</div>}
        </div>

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
          <button className="btn primary" onClick={build} disabled={busy || selected.size === 0}>
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

/* ================================================================= authentication */

const AUTH_LABELS: Record<AuthConfig['type'], string> = {
  bearer: 'Bearer token (Authorization: Bearer …)',
  basic: 'Basic (username and password)',
  header: 'API key in a header',
  query: 'API key in the URL',
};

function AuthPanel({ draft, setDraft, ctx }: { draft: Workflow; setDraft: (fn: (d: Workflow | null) => Workflow | null) => void; ctx: BindContext }) {
  const toast = useToast();
  const auth = draft.auth;
  const set = (patch: Partial<AuthConfig>) => setDraft((d) => (d && d.auth ? { ...d, auth: { ...d.auth, ...patch } } : d));
  const detected = useMemo(() => (auth ? null : detectAuth(draft)), [draft, auth]);

  const known = new Set(availableVars(ctx.workflow, ctx.ref, ctx.userColumns, ctx.extraVars).map((v) => v.name));
  const used = auth ? [auth.token, auth.username, auth.password, auth.value].flatMap((t) => placeholdersIn(t)) : [];
  const missing = [...new Set(used.filter((n) => !n.startsWith('$') && !known.has(n)))];

  const useDetected = () => {
    if (!detected) return;
    setDraft((d) => (d ? { ...stripAuthorization(d, detected.headerValue), auth: detected.auth } : d));
    toast(`Authentication moved out of ${detected.steps} step(s) into the workflow settings`);
  };

  return (
    <Card
      title="Authentication"
      hint="Added to every request. Use a value from your login step, e.g. Bearer ${token}. A request is sent without it until that value exists, so the login itself needs no exception."
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Method" htmlFor="auth-type">
            <select
              id="auth-type"
              value={auth?.type ?? ''}
              onChange={(e) => {
                const type = e.target.value as AuthConfig['type'] | '';
                setDraft((d) => {
                  if (!d) return d;
                  if (!type) {
                    const { auth: _drop, ...rest } = d;
                    return rest;
                  }
                  const seed: AuthConfig = type === 'bearer' ? { type, token: '${token}' } : type === 'basic' ? { type, username: '${user.username}', password: '${user.password}' } : { type, name: type === 'header' ? 'X-API-Key' : 'api_key', value: '' };
                  return { ...d, auth: seed };
                });
              }}
            >
              <option value="">None: only what each request already carries</option>
              {(Object.keys(AUTH_LABELS) as AuthConfig['type'][]).map((t) => (
                <option key={t} value={t}>
                  {AUTH_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          {detected && (
            <div className="callout" style={{ alignSelf: 'end' }}>
              <div>
                {detected.steps} step(s) send the same <code>Authorization</code> header.
              </div>
              <button className="btn small" style={{ marginTop: 6 }} onClick={useDetected}>
                Use it as the workflow authentication
              </button>
            </div>
          )}
        </div>

        {auth?.type === 'bearer' && (
          <Field label="Token" help={<>Usually a value extracted from the login response, e.g. <code>{'${token}'}</code>. “Bearer ” is added for you.</>}>
            <BindField value={auth.token ?? ''} onChange={(v) => set({ token: v })} ctx={ctx} replace ariaLabel="Bearer token" />
          </Field>
        )}
        {auth?.type === 'basic' && (
          <div className="grid-2">
            <Field label="Username">
              <BindField value={auth.username ?? ''} onChange={(v) => set({ username: v })} ctx={ctx} replace ariaLabel="Basic auth username" />
            </Field>
            <Field label="Password">
              <BindField value={auth.password ?? ''} onChange={(v) => set({ password: v })} ctx={ctx} replace ariaLabel="Basic auth password" />
            </Field>
          </div>
        )}
        {(auth?.type === 'header' || auth?.type === 'query') && (
          <div className="grid-2">
            <Field label={auth.type === 'header' ? 'Header name' : 'Parameter name'}>
              <input type="text" className="mono" value={auth.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Value">
              <BindField value={auth.value ?? ''} onChange={(v) => set({ value: v })} ctx={ctx} replace ariaLabel="API key value" />
            </Field>
          </div>
        )}

        {missing.length > 0 && (
          <div className="callout warn">
            Nothing in the workflow produces <b>{missing.map((m) => `\${${m}}`).join(', ')}</b>, so requests will go out without authentication. Extract it in your login step
            (Extract variables → JSON path / header / cookie), or pick it with the <code>{'{ }'}</code> button.
          </div>
        )}
        {auth && <div className="faint" style={{ fontSize: 12.5 }}>Tip: on a step, tick “Do not add authentication” to exclude it. Validate below shows which requests carried it.</div>}
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

function StepEditor({ step, ctx, hasAuth, onChange }: { step: Step; ctx: BindContext; hasAuth: boolean; onChange: (s: Step) => void }) {
  const [headersText, setHeadersText] = useState(headersToText(step.request.headers));
  const [rawBody, setRawBody] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch });
  const setReq = (patch: Partial<Step['request']>) => onChange({ ...step, request: { ...step.request, ...patch } });
  const extractors = step.extract ?? [];
  const setEx = (i: number, patch: Partial<Extractor>) => set({ extract: extractors.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  const url = splitUrl(step.request.url);
  const body = step.request.body;
  const kind = detectBodyKind(body, step.request.headers);
  const jFields = kind === 'json' && body !== undefined ? jsonFields(body) : null;
  const missing = unresolvedVars(ctx.workflow, ctx.ref, ctx.userColumns, ctx.extraVars);

  return (
    <div className="step-edit">
      {missing.length > 0 && (
        <div className="callout warn">
          This request uses <b>{missing.map((m) => `\${${m}}`).join(', ')}</b>, which no earlier step provides. Extract it from an earlier response (use the <code>{'{ }'}</code> button on a field), or fix the name.
        </div>
      )}
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <Field label="URL">
            <BindField value={step.request.url} onChange={(v) => setReq({ url: v })} ctx={ctx} ariaLabel="URL" />
          </Field>
        </div>
      </div>

      <Section title="Query parameters" hint="Each value can be typed, or taken from an earlier step's response, the users file or a generator.">
        <ParamTable
          what="parameter"
          ctx={ctx}
          params={url.params}
          onChange={(params) => setReq({ url: joinUrl(url.base, params, url.hash) })}
        />
      </Section>

      <Section title="Body">
        {kind === 'json' && jFields && !rawBody ? (
          <JsonFieldTable
            ctx={ctx}
            fields={jFields}
            onSet={(f, v) => setReq({ body: setJsonField(body ?? '', f.tokens, v) })}
          />
        ) : kind === 'form' && !rawBody ? (
          <ParamTable what="field" ctx={ctx} params={formFields(body ?? '')} onChange={(p) => setReq({ body: joinForm(p) || undefined })} />
        ) : (
          <BindField rows={6} value={body ?? ''} onChange={(v) => setReq({ body: v || undefined })} ctx={ctx} ariaLabel="Request body" />
        )}
        {(kind === 'json' || kind === 'form') && (
          <div style={{ marginTop: 6 }}>
            <button className="btn small ghost" onClick={() => setRawBody(!rawBody)}>
              {rawBody ? 'Edit as fields' : 'Edit as text'}
            </button>
          </div>
        )}
      </Section>

      <Field label="Headers" help="One per line: Name: value. Use { } to insert a value from another step.">
        <BindField
          rows={5}
          value={headersText}
          onChange={(v) => {
            setHeadersText(v);
            setReq({ headers: textToHeaders(v) });
          }}
          ctx={ctx}
          ariaLabel="Headers"
        />
      </Field>

      {hasAuth && (
        <label className="check">
          <input type="checkbox" checked={!!step.skipAuth} onChange={(e) => set({ skipAuth: e.target.checked || undefined })} />
          Do not add the workflow authentication to this step
        </label>
      )}

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
        <div className="section-title">Save values from this response for later steps</div>
        <div className="faint" style={{ fontSize: 12.5, margin: '-4px 0 8px' }}>
          Later steps can then use them as <code>{'${name}'}</code>: in the URL, parameters, body, headers or authentication.
        </div>
        {extractors.map((ex, i) => (
          <div className="row" key={i} style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
            <input type="text" className="mono" style={{ maxWidth: 150 }} placeholder="variable" aria-label="Variable name" value={ex.var} onChange={(e) => setEx(i, { var: e.target.value })} />
            <select style={{ maxWidth: 130 }} aria-label="Where to read it" value={ex.from} onChange={(e) => setEx(i, { from: e.target.value as Extractor['from'] })}>
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
                aria-label="Location"
                value={(ex.from === 'body' ? ex.path : ex.from === 'regex' ? ex.regex : ex.name) ?? ''}
                onChange={(e) => setEx(i, ex.from === 'body' ? { path: e.target.value } : ex.from === 'regex' ? { regex: e.target.value } : { name: e.target.value })}
              />
            )}
            <button className="btn small" title="Choose from the recorded response of this step" onClick={() => setPicking(i)} disabled={step.sourceId === undefined}>
              Pick…
            </button>
            <label className="check" title="Do not fail the step when nothing matches">
              <input type="checkbox" checked={!!ex.optional} onChange={(e) => setEx(i, { optional: e.target.checked || undefined })} /> optional
            </label>
            <button className="btn icon ghost" aria-label="Remove extractor" onClick={() => set({ extract: extractors.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn small ghost" onClick={() => set({ extract: [...extractors, { var: '', from: 'body', path: '$.' }] })}>
          + Add value to save
        </button>
      </div>

      {picking !== null && step.sourceId !== undefined && (
        <PickExtractorDialog
          testId={ctx.testId}
          sourceId={step.sourceId}
          onClose={() => setPicking(null)}
          onPick={(e) => {
            const cur = extractors[picking];
            const { var: suggested, ...where } = e;
            const patch: Partial<Extractor> = { path: undefined, name: undefined, regex: undefined, group: undefined, ...where };
            if (cur && !cur.var.trim()) patch.var = suggested;
            setEx(picking, patch);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function StepList({
  title,
  hint,
  steps,
  phase,
  wf,
  ctxFor,
  onChange,
  onEdit,
  onMovePhase,
}: {
  title: string;
  hint: string;
  steps: Step[];
  phase: 'setup' | 'steps';
  wf: Workflow;
  ctxFor: (ref: StepRef) => BindContext;
  onChange: (steps: Step[]) => void;
  onEdit: (index: number, step: Step) => void;
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
  const first = ctxFor({ phase, index: 0 });
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
      {steps.map((s, i) => {
        const ref: StepRef = { phase, index: i };
        const uses = usedStepVars(wf, s);
        const unresolved = unresolvedVars(wf, ref, first.userColumns, first.extraVars);
        return (
          <div className="step-row" key={i}>
            <div className="step-head" onClick={() => setOpen(open === i ? null : i)}>
              <span className="faint num" style={{ width: 20 }}>
                {i + 1}
              </span>
              <MethodTag method={s.request.method} />
              <span className="name" title={s.request.url}>
                {s.name.startsWith(`${s.request.method.toUpperCase()} `) ? s.name.slice(s.request.method.length + 1) : s.name}
              </span>
              {s.resourceType && !['xhr', 'fetch'].includes(s.resourceType) && <span className="chip">{s.resourceType === 'script' ? 'js' : s.resourceType}</span>}
              {(s.thinkTimeMs ?? 0) > 0 && <span className="chip">⏱ {fmt.ms(s.thinkTimeMs)}</span>}
              {uses.length > 0 && <span className="chip" title="Values this request takes from earlier steps">⇠ {uses.join(', ')}</span>}
              {(s.extract?.length ?? 0) > 0 && <span className="chip" title="Values saved for later steps">⇢ {s.extract!.map((e) => e.var).join(', ')}</span>}
              {unresolved.length > 0 && (
                <span className="badge warn" title={`No earlier step provides ${unresolved.join(', ')}`}>
                  ⚠ {unresolved.length} missing
                </span>
              )}
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
            {open === i && <StepEditor step={s} ctx={ctxFor(ref)} hasAuth={!!wf.auth} onChange={(ns) => onEdit(i, ns)} />}
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================= validation */

function ValidatePanel({ test, dirty }: TabProps & { dirty: boolean }) {
  const { busy, run } = useAction();
  const [openCall, setOpenCall] = useState<Set<number>>(new Set());
  const [userIndex, setUserIndex] = useState(0);
  const [iterations, setIterations] = useState(1);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const hasAuth = !!test.workflow?.auth;

  const go = async () => {
    const r = await run(() => api.validateWorkflow(test.id, { userIndex, iterations }));
    if (r) {
      setResult(r);
      setOpenCall(new Set(r.traces.flatMap((t, i) => (t.error ? [i] : []))));
    }
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
              <div className="row" style={{ flexWrap: 'nowrap', cursor: t.call ? 'pointer' : undefined }} onClick={() => t.call && setOpenCall((s) => { const n = new Set(s); if (!n.delete(i)) n.add(i); return n; })}>
                <span className="faint" style={{ width: 80, fontSize: 12 }}>
                  {t.phase}
                </span>
                <span className={`badge ${t.cached ? 'info' : t.error ? 'bad' : 'good'}`}>{t.cached ? 'cache' : t.status || 'ERR'}</span>
                <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.step}
                </span>
                {hasAuth && t.auth === 'applied' && <span className="badge info" title="The workflow authentication was sent with this request">🔑 auth</span>}
                {hasAuth && t.auth === 'skipped' && (
                  <span className="badge warn" title="The authentication value was not available yet (e.g. before the login step) so nothing was added">
                    no auth yet
                  </span>
                )}
                {hasAuth && t.auth === 'own' && <span className="badge" title="This request sets its own credentials">own auth</span>}
                <span className="muted num">{fmt.ms(t.durationMs)}</span>
                {t.call && <span className="faint">{openCall.has(i) ? '▾ details' : '▸ details'}</span>}
              </div>
              {t.call && openCall.has(i) && (
                <div style={{ marginLeft: 88, marginTop: 6 }}>
                  <CallDetail call={t.call} />
                </div>
              )}
              {!openCall.has(i) && Object.keys(t.extracted).length > 0 && (
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

const mapStep = (wf: Workflow, ref: StepRef, fn: (s: Step) => Step): Workflow => ({
  ...wf,
  [ref.phase]: wf[ref.phase].map((s, i) => (i === ref.index ? fn(s) : s)),
});

export function WorkflowTab(props: TabProps) {
  const { test, reload } = props;
  const toast = useToast();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Workflow | null>(test.workflow);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const saved = JSON.stringify(test.workflow);
  const dirty = useMemo(() => (jsonMode ? jsonText !== JSON.stringify(test.workflow, null, 2) : JSON.stringify(draft) !== saved), [draft, saved, jsonMode, jsonText, test.workflow]);
  const userColumns = useMemo(() => test.dataset?.columns ?? [], [test.dataset]);
  const extraVars = useMemo(() => Object.keys(test.settings.variables ?? {}), [test.settings.variables]);

  useEffect(() => {
    setDraft(test.workflow);
    setJsonText(JSON.stringify(test.workflow, null, 2));
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  // All draft updates are functional so a binding (which edits two steps at once) never overwrites itself.
  const editStep = (ref: StepRef, ns: Step) => setDraft((d) => (d ? mapStep(d, ref, () => ns) : d));
  const addExtractor = (source: StepRef, ex: Extractor) =>
    setDraft((d) => (d ? mapStep(d, source, (s) => ((s.extract ?? []).some((e) => e.var === ex.var) ? s : { ...s, extract: [...(s.extract ?? []), ex] })) : d));
  const ctxFor = (ref: StepRef): BindContext => ({ testId: test.id, workflow: draft!, ref, userColumns, extraVars, addExtractor });

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
      {draft && !jsonMode && <AuthPanel draft={draft} setDraft={setDraft} ctx={ctxFor({ phase: 'steps', index: draft.steps.length })} />}
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
                wf={draft}
                ctxFor={ctxFor}
                onChange={(setup) => setDraft({ ...draft, setup })}
                onEdit={(i, s) => editStep({ phase: 'setup', index: i }, s)}
                onMovePhase={(i) => setDraft({ ...draft, setup: draft.setup.filter((_, j) => j !== i), steps: [draft.setup[i], ...draft.steps] })}
              />
              <StepList
                title="Iteration — repeats for the whole test"
                hint="The business transaction each virtual user performs over and over."
                steps={draft.steps}
                phase="steps"
                wf={draft}
                ctxFor={ctxFor}
                onChange={(steps) => setDraft({ ...draft, steps })}
                onEdit={(i, s) => editStep({ phase: 'steps', index: i }, s)}
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
