import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card, Field, fmt, useAction } from '../../components/ui';
import { useAsync } from '../../hooks';
import { METRICS, metricInfo } from '../../thresholds';
import type { CaptureSettings, TestSettings, Threshold, ThresholdOp, UsersMode } from '../../types';

const DEFAULT_CAPTURE: CaptureSettings = { okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true, keepAll: true, maxCalls: 100_000 };
import type { TabProps } from '../TestPage';

const USERS_MODES: { value: UsersMode; label: string; help: string }[] = [
  { value: 'per-vu', label: 'One user per virtual user', help: 'VU #n logs in as user #n; the list wraps around if there are more VUs than users.' },
  { value: 'unique', label: 'Unique users (strict)', help: 'Every VU gets a different user; the run refuses to start if the file has fewer users than VUs.' },
  { value: 'per-iteration', label: 'New user every iteration', help: 'Each iteration logs in again as the next user in the list (session churn).' },
];

function NumberField({ label, help, value, onChange, min = 0, step = 1 }: { label: string; help?: string; value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  const id = useId();
  return (
    <Field label={label} help={help} htmlFor={id}>
      <input id={id} type="number" min={min} step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
    </Field>
  );
}

export function SettingsTab({ test, reload }: TabProps) {
  const { busy, run } = useAction();
  const [s, setS] = useState<TestSettings>(test.settings);
  const [vars, setVars] = useState<[string, string][]>(Object.entries(test.settings.variables ?? {}));
  const system = useAsync(() => api.system(), []);
  useEffect(() => {
    setS(test.settings);
    setVars(Object.entries(test.settings.variables ?? {}));
  }, [test.settings]);

  const set = (patch: Partial<TestSettings>) => setS({ ...s, ...patch });
  /** secondary hosts recorded in the workflow, e.g. ${apiUrl} for api.example.com */
  const hostVars = Object.keys(test.workflow?.variables ?? {}).filter((k) => k !== 'baseUrl' && /Url\d*$/.test(k));
  const setHostVar = (name: string, value: string) => {
    const rest = vars.filter(([k]) => k !== name);
    setVars(value.trim() ? [...rest, [name, value.trim().replace(/\/+$/, '')]] : rest);
  };
  const current: TestSettings = { ...s, variables: Object.fromEntries(vars.filter(([k]) => k.trim())) };
  const dirty = JSON.stringify(current) !== JSON.stringify({ ...test.settings, variables: test.settings.variables ?? {} });
  const stepNames = useMemo(() => [...(test.workflow?.setup ?? []), ...(test.workflow?.steps ?? []), ...(test.workflow?.teardown ?? [])].map((x) => x.name), [test.workflow]);

  const warnings: string[] = [];
  const capacity = system.data?.capacity ?? 0;
  if (system.data && capacity < s.vus) warnings.push(`Connected workers can run ${capacity} virtual users, but ${s.vus} are configured. Add workers or lower the VU count; extra VUs would wait in the queue.`);
  if (s.usersMode === 'unique' && (test.dataset?.rowCount ?? 0) < s.vus) warnings.push(`Unique mode needs ${s.vus} users but the users file has ${test.dataset?.rowCount ?? 0}.`);
  if (s.mode === 'duration' && s.rampUpSec >= s.durationSec) warnings.push('Ramp-up is as long as the whole test; the full load is never held.');

  const save = async () => {
    const payload = { ...current, baseUrl: current.baseUrl?.trim() || undefined };
    const r = await run(() => api.saveSettings(test.id, payload), 'Settings saved');
    if (r) await reload();
  };

  const setThreshold = (i: number, patch: Partial<Threshold>) => set({ thresholds: s.thresholds.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <div className="stack">
      <Card title="4. Load profile" hint="How many concurrent virtual users (threads) to simulate and for how long.">
        <div className="stack">
          <div className="grid-3">
            <NumberField label="Virtual users (threads)" value={s.vus} min={1} onChange={(v) => set({ vus: v })} help="Concurrent simulated users across all workers." />
            <NumberField label="Ramp-up (seconds)" value={s.rampUpSec} onChange={(v) => set({ rampUpSec: v })} help="Time to start all VUs, evenly spread." />
            <Field label="Stop condition">
              <div className="seg">
                <button className={s.mode === 'duration' ? 'on' : ''} onClick={() => set({ mode: 'duration' })}>
                  Duration
                </button>
                <button className={s.mode === 'iterations' ? 'on' : ''} onClick={() => set({ mode: 'iterations' })}>
                  Iterations
                </button>
              </div>
            </Field>
          </div>
          <div className="grid-3">
            {s.mode === 'duration' ? (
              <NumberField label="Test duration (seconds)" value={s.durationSec} min={1} onChange={(v) => set({ durationSec: v })} help={`Includes ramp-up · ${fmt.dur(s.durationSec)}`} />
            ) : (
              <NumberField label="Iterations per virtual user" value={s.iterations} min={1} onChange={(v) => set({ iterations: v })} help={`${fmt.num(s.iterations * s.vus)} flows in total`} />
            )}
            <NumberField label="Think-time multiplier" value={s.thinkTimeScale} step={0.1} onChange={(v) => set({ thinkTimeScale: v })} help="1 = recorded pauses, 0 = no pauses (maximum pressure)." />
            <NumberField label="Request timeout (ms)" value={s.requestTimeoutMs} min={100} step={1000} onChange={(v) => set({ requestTimeoutMs: v })} />
          </div>
          <Field label="How virtual users pick test users">
            <div className="stack" style={{ gap: 6 }}>
              {USERS_MODES.map((m) => (
                <label key={m.value} className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="radio" name="usersMode" checked={s.usersMode === m.value} onChange={() => set({ usersMode: m.value })} style={{ marginTop: 3 }} />
                  <span>
                    <b>{m.label}</b> <span className="faint">— {m.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {warnings.map((w) => (
            <div key={w} className="callout warn">
              ⚠ {w}
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Sessions and logout"
        hint="Your application keeps the login in a cookie. While that cookie is valid the server treats every request as the same user, and may ignore a second login. Every virtual user has its own cookies, so users never share a session. These options control what happens when a user's session should end."
      >
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={!!s.freshSession || s.usersMode === 'per-iteration'} disabled={s.usersMode === 'per-iteration'} onChange={(e) => set({ freshSession: e.target.checked || undefined })} />
            <span>
              <b>Log in again at the start of every iteration</b>, with a clean session (cookies and saved values cleared)
              {s.usersMode === 'per-iteration' && <span className="faint"> — already the case: "New user every iteration" starts a clean session for every user</span>}
            </span>
          </label>
          <div className="faint" style={{ fontSize: 13 }}>
            Without it, a virtual user logs in once and keeps that session for all its iterations. Users mode (above) decides <i>which</i> user logs in: one per virtual user, or the next one in the file every iteration.
          </div>
          {(test.workflow?.teardown?.length ?? 0) > 0 ? (
            <div className="callout good">
              ✓ The workflow has {test.workflow!.teardown!.length} logout step{test.workflow!.teardown!.length === 1 ? '' : 's'} ({test.workflow!.teardown!.map((t) => t.name).join(', ')}). They run when a user's session ends: after the last iteration, and before the next login when a new session starts.
              A run you stop does not send them.
            </div>
          ) : (
            <div className="callout warn">
              The workflow has no logout step, so users stay signed in on the server after their session ends
              {s.freshSession || s.usersMode === 'per-iteration' ? ' and every new session adds another open one' : ''}. Add your logout call under <b>Teardown</b> on the <Link to="../workflow">Workflow</Link> tab.
            </div>
          )}
        </div>
      </Card>

      <Card title="Environment" hint="Point the same test at another environment without re-recording.">
        <div className="stack">
          <Field label="Base URL override" help={`Recorded: ${test.workflow?.variables.baseUrl ?? '—'}. Leave empty to use the recorded one.`}>
            <input type="url" placeholder={test.workflow?.variables.baseUrl ?? 'https://staging.example.com'} value={s.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} />
          </Field>
          {hostVars.map((name) => (
            <Field key={name} label={<>Override <code>{`\${${name}}`}</code></>} help={`Another host used by the app. Recorded: ${test.workflow?.variables[name]}.`}>
              <input type="url" placeholder={test.workflow?.variables[name]} value={vars.find(([k]) => k === name)?.[1] ?? ''} onChange={(e) => setHostVar(name, e.target.value)} />
            </Field>
          ))}
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Extra variables <span className="faint" style={{ fontWeight: 400 }}>— available as {'${name}'} in steps</span>
            </div>
            {vars.map(([k, v], i) => hostVars.includes(k) ? null : (
              <div key={i} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
                <input type="text" className="mono" placeholder="name" style={{ maxWidth: 220 }} value={k} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                <input type="text" placeholder="value" value={v} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                <button className="btn icon ghost" aria-label="Remove variable" onClick={() => setVars(vars.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn small ghost" onClick={() => setVars([...vars, ['', '']])}>
              + Add variable
            </button>
          </div>
        </div>
      </Card>

      <Card
        title="Call details in reports"
        hint="Every request is counted in the numbers. By default the full details of every call (URL, headers, body, response) are kept too. For very long or very busy runs you can keep only a few calls per step instead."
      >
        {(() => {
          const cap = s.capture ?? DEFAULT_CAPTURE;
          // settings saved before "every call" existed have no keepAll: they keep every call now
          const keepAll = cap.keepAll ?? !(cap.okSamples === 0 && cap.errorSamples === 0);
          const setCap = (patch: Partial<CaptureSettings>) => set({ capture: { ...cap, ...patch } });
          const maxCalls = cap.maxCalls ?? 100_000;
          // a call holds two headers blocks and two bodies (each cut at bodyKb) plus some overhead
          const perCallKb = Math.max(2, cap.bodyKb * 2 + 2);
          return (
            <div className="stack">
              <div className="seg" role="radiogroup" aria-label="How many calls to keep" style={{ alignSelf: 'flex-start' }}>
                <button role="radio" aria-checked={keepAll} className={keepAll ? 'on' : ''} onClick={() => setCap({ keepAll: true })}>
                  Every call
                </button>
                <button role="radio" aria-checked={!keepAll} className={!keepAll ? 'on' : ''} onClick={() => setCap({ keepAll: false })}>
                  A few per step
                </button>
              </div>
              {keepAll && (
                <div className="stack" style={{ gap: 8 }}>
                  <NumberField label="Stop keeping details after this many calls" help="A safety limit. Every request is still counted in the numbers after it is reached." value={maxCalls} min={1} onChange={(v) => setCap({ maxCalls: Math.min(1_000_000, Math.max(1, Math.round(v) || 1)) })} />
                  <div className={maxCalls * perCallKb > 500 * 1024 ? 'callout warn' : 'callout'}>
                    Every call keeps its full request and response, up to {cap.bodyKb} KB per body. That is at most about <b>{fmt.bytes(maxCalls * perCallKb * 1024)}</b> for {fmt.num(maxCalls)} calls, kept in memory during the run and saved with its results.
                    Long runs with a high request rate are better served by a few calls per step, or by a lower body size.
                  </div>
                </div>
              )}
              <div className="grid-3" style={keepAll ? { opacity: 0.55 } : undefined}>
                <NumberField label="Successful calls kept per step" help={keepAll ? 'Not used while every call is kept.' : 'The first ones of each step. 0 = none.'} value={cap.okSamples} onChange={(v) => setCap({ okSamples: v })} />
                <NumberField label="Failed calls kept per step" help="Failures are what you debug, so keep more of them." value={cap.errorSamples} onChange={(v) => setCap({ errorSamples: v })} />
                <NumberField label="Cut bodies after (KB)" help="Long request and response bodies are cut here." value={cap.bodyKb} min={1} onChange={(v) => setCap({ bodyKb: v })} />
              </div>
              <label className="check">
                <input type="checkbox" checked={cap.maskSecrets} onChange={(e) => setCap({ maskSecrets: e.target.checked })} />
                Mask credentials (Authorization and Cookie headers, password and token fields)
              </label>
              {!cap.maskSecrets && <div className="callout warn">Passwords, tokens and cookies will be stored in the results and included in downloaded reports. Share those reports with care.</div>}
            </div>
          );
        })()}
      </Card>

      <Card
        title="Pass / fail criteria"
        hint="Service-level thresholds. The run's verdict is PASSED only if every threshold holds; CI pipelines use this verdict (and the JUnit report)."
      >
        <div className="stack" style={{ gap: 8 }}>
          {s.thresholds.map((t, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <select value={t.step ?? ''} onChange={(e) => setThreshold(i, { step: e.target.value || undefined })} style={{ maxWidth: 260 }}>
                <option value="">All requests</option>
                {stepNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <select value={t.metric} onChange={(e) => setThreshold(i, { metric: e.target.value as Threshold['metric'] })} style={{ maxWidth: 220 }}>
                {METRICS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select value={t.op} onChange={(e) => setThreshold(i, { op: e.target.value as ThresholdOp })} style={{ width: 70 }}>
                {['<', '<=', '>', '>='].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              <input type="number" min={0} value={t.value} onChange={(e) => setThreshold(i, { value: Number(e.target.value) })} style={{ width: 110 }} />
              <span className="faint" style={{ width: 44 }}>
                {metricInfo(t.metric).unit}
              </span>
              <button className="btn icon ghost" aria-label="Remove threshold" onClick={() => set({ thresholds: s.thresholds.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          {s.thresholds.length === 0 && <div className="faint">No criteria: every completed run counts as passed.</div>}
          <div>
            <button className="btn small ghost" onClick={() => set({ thresholds: [...s.thresholds, { metric: 'p95', op: '<', value: 1000 }] })}>
              + Add threshold
            </button>
          </div>
        </div>
      </Card>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {dirty && (
          <button className="btn" onClick={() => setS(test.settings)} disabled={busy}>
            Discard
          </button>
        )}
        <button className="btn primary" onClick={save} disabled={busy || !dirty}>
          Save settings
        </button>
        {!dirty && (
          <Link className="btn primary" to="../runs">
            Next: run the test →
          </Link>
        )}
      </div>
    </div>
  );
}
