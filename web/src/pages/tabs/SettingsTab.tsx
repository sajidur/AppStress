import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card, Field, fmt, useAction } from '../../components/ui';
import { useAsync } from '../../hooks';
import { METRICS, metricInfo } from '../../thresholds';
import type { TestSettings, Threshold, ThresholdOp, UsersMode } from '../../types';
import type { TabProps } from '../TestPage';

const USERS_MODES: { value: UsersMode; label: string; help: string }[] = [
  { value: 'per-vu', label: 'One user per virtual user', help: 'VU #n logs in as user #n; the list wraps around if there are more VUs than users.' },
  { value: 'unique', label: 'Unique users (strict)', help: 'Every VU gets a different user; the run refuses to start if the file has fewer users than VUs.' },
  { value: 'per-iteration', label: 'New user every iteration', help: 'Each iteration logs in again as the next user in the list (session churn).' },
];

function NumberField({ label, help, value, onChange, min = 0, step = 1 }: { label: string; help?: string; value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  return (
    <Field label={label} help={help}>
      <input type="number" min={min} step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
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
  const stepNames = useMemo(() => [...(test.workflow?.setup ?? []), ...(test.workflow?.steps ?? [])].map((x) => x.name), [test.workflow]);

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
