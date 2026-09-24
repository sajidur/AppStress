import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import {
  availableVars,
  extractorVarNames,
  filterFor,
  placeholder,
  sameExtractor,
  newParamName,
  stepsBefore,
  suggestVarName,
  uniqueVarName,
  type JsonField,
  type Param,
  type StepRef,
  type VarInfo,
} from '../bindings';
import { useAsync } from '../hooks';
import type { Extractor, Workflow } from '../types';
import { Modal, Spinner } from './ui';

/** Everything the value pickers need to know about where they are in the workflow. */
export interface BindContext {
  testId: string;
  workflow: Workflow;
  /** the step being edited; index === list length means "after every step" (used by the authentication panel) */
  ref: StepRef;
  userColumns: string[];
  extraVars: string[];
  /** add an extractor to an earlier step so its value becomes available as ${var} */
  addExtractor: (source: StepRef, ex: Extractor) => void;
}

/* ================================================================= recorded response picker */

interface Picked {
  extractor: Omit<Extractor, 'var'>;
  /** name hint for the variable */
  hint: string;
  /** human description, e.g. "JSON $.user.id" */
  describe: string;
  preview: string;
}

type Tab = 'json' | 'headers' | 'cookies' | 'page' | 'manual';

function SamplePicker({ testId, sourceId, picked, onPick }: { testId: string; sourceId?: number; picked: Picked | null; onPick: (p: Picked) => void }) {
  const sample = useAsync(() => (sourceId === undefined ? Promise.resolve(null) : api.responseSample(testId, sourceId)), [testId, sourceId]);
  const [tab, setTab] = useState<Tab>('json');
  const [q, setQ] = useState('');
  const [manual, setManual] = useState<{ from: 'body' | 'header' | 'cookie' | 'regex'; value: string }>({ from: 'body', value: '$.' });

  const s = sample.data;
  const tabs: [Tab, string, number][] = [
    ['json', 'JSON fields', s?.jsonPaths.length ?? 0],
    ['headers', 'Headers', s?.headers.length ?? 0],
    ['cookies', 'Cookies', s?.cookies.length ?? 0],
    ['page', 'Page fields', s?.htmlFields.length ?? 0],
  ];
  // land on the first tab that has something
  useEffect(() => {
    if (!s) return;
    const first = tabs.find(([, , n]) => n > 0);
    setTab(first ? first[0] : 'manual');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id]);

  const rows: { key: string; label: string; value: string; pick: Picked }[] = useMemo(() => {
    if (!s) return [];
    if (tab === 'json') return s.jsonPaths.map((p) => ({ key: p.path, label: p.path, value: p.value, pick: { extractor: { from: 'body', path: p.path }, hint: p.path, describe: `JSON ${p.path}`, preview: p.value } }));
    if (tab === 'headers') return s.headers.map((h) => ({ key: h.name, label: h.name, value: h.value, pick: { extractor: { from: 'header', name: h.name }, hint: h.name, describe: `header ${h.name}`, preview: h.value } }));
    if (tab === 'cookies') return s.cookies.map((c) => ({ key: c.name, label: c.name, value: c.value, pick: { extractor: { from: 'cookie', name: c.name }, hint: c.name, describe: `cookie ${c.name}`, preview: c.value } }));
    if (tab === 'page') return s.htmlFields.map((f) => ({ key: f.name, label: f.name, value: f.value, pick: { extractor: { from: 'regex', regex: f.regex, group: 1 }, hint: f.name, describe: `page field ${f.name}`, preview: f.value } }));
    return [];
  }, [s, tab]);
  const filtered = rows.filter((r) => !q || `${r.label} ${r.value}`.toLowerCase().includes(q.toLowerCase()));

  const setManualPick = (from: typeof manual.from, value: string) => {
    setManual({ from, value });
    const v = value.trim();
    if (!v || v === '$.') return;
    const extractor: Omit<Extractor, 'var'> = from === 'body' ? { from, path: v } : from === 'regex' ? { from, regex: v, group: 1 } : { from, name: v };
    onPick({ extractor, hint: v, describe: `${from === 'body' ? 'JSON' : from} ${v}`, preview: '' });
  };

  if (sourceId !== undefined && sample.loading) return <div className="row faint"><Spinner /> Loading the recorded response…</div>;

  return (
    <div className="stack" style={{ gap: 8 }}>
      {sourceId === undefined && <div className="callout warn">This step was not recorded, so there is no sample response to browse. Enter where the value is located below.</div>}
      {sample.error && <div className="callout bad">{sample.error.message}. You can still enter the location manually.</div>}
      {s && (
        <div className="faint" style={{ fontSize: 12.5 }}>
          Recorded response of <b className="mono">{s.method} {s.url.replace(/^https?:\/\/[^/]+/, '')}</b> · status {s.status ?? '—'}
        </div>
      )}
      <div className="seg" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
        {tabs.map(([id, label, n]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} disabled={!s || n === 0} title={n === 0 ? 'Nothing to pick here' : undefined}>
            {label}
            {n > 0 ? ` (${n})` : ''}
          </button>
        ))}
        <button className={tab === 'manual' ? 'on' : ''} onClick={() => setTab('manual')}>
          Type it
        </button>
      </div>

      {tab === 'manual' ? (
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select style={{ maxWidth: 150 }} value={manual.from} onChange={(e) => setManualPick(e.target.value as typeof manual.from, manual.value)}>
            <option value="body">JSON path</option>
            <option value="header">Header</option>
            <option value="cookie">Cookie</option>
            <option value="regex">Regex</option>
          </select>
          <input
            type="text"
            className="mono"
            placeholder={manual.from === 'body' ? '$.data.token' : manual.from === 'regex' ? 'id="(\\d+)"' : 'name'}
            value={manual.value}
            onChange={(e) => setManualPick(manual.from, e.target.value)}
          />
        </div>
      ) : (
        <>
          <input type="text" placeholder="Search fields and values…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pick-list" role="listbox">
            {filtered.length === 0 && <div className="faint" style={{ padding: 10 }}>Nothing matches.</div>}
            {filtered.slice(0, 200).map((r) => {
              const on = picked?.describe === r.pick.describe;
              return (
                <button key={r.key} role="option" aria-selected={on} className={`pick-row${on ? ' on' : ''}`} onClick={() => onPick(r.pick)}>
                  <span className="mono pick-key">{r.label}</span>
                  <span className="pick-val">{r.value}</span>
                </button>
              );
            })}
            {filtered.length > 200 && <div className="faint" style={{ padding: 8 }}>Showing the first 200 — narrow the search.</div>}
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================= "use a value from an earlier step" dialog */

const stepLabel = (s: { name: string; request: { method: string } }, n: number) => `#${n} ${s.name}`;

export function BindDialog({ ctx, onDone, onClose }: { ctx: BindContext; onDone: (variable: string) => void; onClose: () => void }) {
  const before = useMemo(() => stepsBefore(ctx.workflow, ctx.ref), [ctx.workflow, ctx.ref]);
  const [sel, setSel] = useState(Math.max(0, before.length - 1));
  const [picked, setPicked] = useState<Picked | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const source = before[sel];

  const pick = (p: Picked) => {
    setPicked(p);
    setError(null);
    const taken = new Set([...extractorVarNames(ctx.workflow), ...Object.keys(ctx.workflow.variables)]);
    setName(uniqueVarName(suggestVarName(p.extractor.from, p.hint), taken));
  };

  const submit = () => {
    if (!source || !picked) return;
    const existing = (source.step.extract ?? []).find((e) => sameExtractor(e, { var: '', ...picked.extractor }));
    if (existing) {
      onDone(existing.var);
      return;
    }
    const v = name.trim();
    if (!/^[A-Za-z_][\w]*$/.test(v)) return setError('Use letters, digits and _ (not starting with a digit).');
    if (extractorVarNames(ctx.workflow).has(v) || v in ctx.workflow.variables) return setError(`"${v}" is already used. Pick another name.`);
    ctx.addExtractor(source.ref, { var: v, ...picked.extractor });
    onDone(v);
  };

  return (
    <Modal
      wide
      title="Use a value from an earlier step"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!picked || !name.trim()}>
            Use this value
          </button>
        </>
      }
    >
      {before.length === 0 ? (
        <div className="callout warn">There is no earlier step. Move this request below the one that returns the value, or add the value as a workflow variable.</div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="bind-src">Take the value from the response of</label>
            <select
              id="bind-src"
              value={sel}
              onChange={(e) => {
                setSel(Number(e.target.value));
                setPicked(null);
              }}
            >
              {before.map((b, i) => (
                <option key={i} value={i}>
                  {stepLabel(b.step, i + 1)} — {b.step.request.method} {b.step.request.url.replace('${baseUrl}', '').slice(0, 70)}
                </option>
              ))}
            </select>
          </div>
          {source && <SamplePicker key={`${source.ref.phase}-${source.ref.index}`} testId={ctx.testId} sourceId={source.step.sourceId} picked={picked} onPick={pick} />}
          {picked && (
            <div className="callout">
              <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
                <div className="field" style={{ width: 220 }}>
                  <label htmlFor="bind-name">Variable name</label>
                  <input id="bind-name" type="text" className="mono" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="faint" style={{ fontSize: 12.5, minWidth: 0 }}>
                  <div>
                    Will insert <code>{placeholder(name || 'name')}</code>
                  </div>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    read from {picked.describe}
                    {picked.preview ? ` (recorded: ${picked.preview})` : ''}
                  </div>
                </div>
              </div>
              {error && <div style={{ color: 'var(--critical-text)', marginTop: 6 }}>{error}</div>}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** Pick where an extractor of `sourceId`'s own response should read from (used by the "Pick…" button on a step). */
export function PickExtractorDialog({
  testId,
  sourceId,
  onPick,
  onClose,
}: {
  testId: string;
  sourceId: number;
  onPick: (e: Extractor) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  return (
    <Modal
      wide
      title="Pick a value from the recorded response"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked} onClick={() => picked && onPick({ var: suggestVarName(picked.extractor.from, picked.hint), ...picked.extractor })}>
            Use this location
          </button>
        </>
      }
    >
      <SamplePicker testId={testId} sourceId={sourceId} picked={picked} onPick={setPicked} />
    </Modal>
  );
}

/* ================================================================= variable menu */

const GROUPS: { kind: VarInfo['kind']; title: string }[] = [
  { kind: 'step', title: 'From earlier steps' },
  { kind: 'user', title: 'User data (users file)' },
  { kind: 'variable', title: 'Workflow variables' },
  { kind: 'builtin', title: 'Generated' },
];

/** Small "{ }" button that lists the values available at this point and inserts the chosen one. */
export function VarMenu({ ctx, filter, onInsert }: { ctx: BindContext; filter?: string; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const vars = useMemo(() => availableVars(ctx.workflow, ctx.ref, ctx.userColumns, ctx.extraVars), [ctx.workflow, ctx.ref, ctx.userColumns, ctx.extraVars]);
  const canBind = stepsBefore(ctx.workflow, ctx.ref).length > 0;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="var-menu" ref={box}>
      <button type="button" className="btn small" title="Insert a value from another step, the users file or a generator" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {'{ }'}
      </button>
      {open && (
        <div className="var-pop" role="listbox">
          {GROUPS.map((g) => {
            const list = vars.filter((v) => v.kind === g.kind);
            if (!list.length) return null;
            return (
              <div key={g.kind}>
                <div className="var-group">{g.title}</div>
                {list.map((v) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    key={v.name}
                    className="var-item"
                    onClick={() => {
                      onInsert(placeholder(v.name, filter));
                      setOpen(false);
                    }}
                  >
                    <span className="mono">{v.name}</span>
                    <span className="faint">{v.source}</span>
                  </button>
                ))}
              </div>
            );
          })}
          <button
            type="button"
            className="var-item bind-more"
            disabled={!canBind}
            title={canBind ? undefined : 'There is no earlier step to take a value from'}
            onClick={() => {
              setOpen(false);
              setDialog(true);
            }}
          >
            ＋ From an earlier step's response…
          </button>
        </div>
      )}
      {dialog && (
        <BindDialog
          ctx={ctx}
          onClose={() => setDialog(false)}
          onDone={(v) => {
            setDialog(false);
            onInsert(placeholder(v, filter));
          }}
        />
      )}
    </div>
  );
}

/* ================================================================= bindable inputs */

/** Text input / textarea with a "{ }" button that inserts a value at the caret. */
export function BindField({
  value,
  onChange,
  ctx,
  filter,
  replace,
  rows,
  placeholder: ph,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  ctx: BindContext;
  /** filter appended to inserted placeholders, e.g. urlencode */
  filter?: string;
  /** picking a value binds the whole field (replacing what is there) unless part of the text is selected */
  replace?: boolean;
  /** set for a multi-line textarea */
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const sel = useRef<[number, number] | null>(null);
  const remember = () => {
    if (el.current) sel.current = [el.current.selectionStart ?? value.length, el.current.selectionEnd ?? value.length];
  };
  const insert = (text: string) => {
    const selected = sel.current && sel.current[0] !== sel.current[1] ? sel.current : null;
    const [a, b] = selected ?? (replace ? [0, value.length] : (sel.current ?? [value.length, value.length]));
    const next = value.slice(0, a) + text + value.slice(b);
    onChange(next);
    const caret = a + text.length;
    sel.current = [caret, caret];
    requestAnimationFrame(() => {
      el.current?.focus();
      el.current?.setSelectionRange(caret, caret);
    });
  };
  const common = { ref: el, value, 'aria-label': ariaLabel, placeholder: ph, onChange: (e: { target: { value: string } }) => onChange(e.target.value), onSelect: remember, onBlur: remember, onKeyUp: remember, onClick: remember };
  return (
    <div className="bind-field" style={{ alignItems: rows ? 'flex-start' : 'center' }}>
      {rows ? (
        <textarea rows={rows} spellCheck={false} className={className} {...common} />
      ) : (
        <input type="text" className={`mono ${className ?? ''}`} spellCheck={false} {...common} />
      )}
      <VarMenu ctx={ctx} filter={filter} onInsert={insert} />
    </div>
  );
}

/** Table of key/value pairs (query parameters or form fields) whose values can be bound. */
export function ParamTable({
  params,
  onChange,
  ctx,
  what,
  editableKeys = true,
}: {
  params: Param[];
  onChange: (p: Param[]) => void;
  ctx: BindContext;
  what: string;
  editableKeys?: boolean;
}) {
  const set = (i: number, patch: Partial<Param>) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {params.length === 0 && <div className="faint">No {what}.</div>}
      {params.map((p, i) => (
        <div className="row" key={i} style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
          <input type="text" className="mono" style={{ width: 170, flex: 'none' }} aria-label={`${what} name`} value={p.key} readOnly={!editableKeys} onChange={(e) => set(i, { key: e.target.value })} />
          <span className="faint">=</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <BindField value={p.value} onChange={(v) => set(i, { value: v, bare: undefined })} ctx={ctx} filter={filterFor('url')} replace ariaLabel={`${p.key} value`} />
          </div>
          <button className="btn icon ghost" aria-label={`Remove ${p.key}`} onClick={() => onChange(params.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div>
        <button className="btn small ghost" onClick={() => onChange([...params, { key: newParamName(params), value: '' }])}>
          + Add {what}
        </button>
      </div>
    </div>
  );
}

/** One row per leaf of a JSON body, each bindable. */
export function JsonFieldTable({ fields, onSet, ctx }: { fields: JsonField[]; onSet: (f: JsonField, value: string) => void; ctx: BindContext }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {fields.length === 0 && <div className="faint">The body has no fields.</div>}
      {fields.map((f) => (
        <div className="row" key={f.label} style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
          <span className="mono json-key" title={f.label}>
            {f.label}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <BindField value={f.value} onChange={(v) => onSet(f, v)} ctx={ctx} filter={filterFor(f.raw ? 'json-raw' : 'json-string')} replace ariaLabel={`${f.label} value`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="section-title">{title}</div>
      {hint && (
        <div className="faint" style={{ fontSize: 12.5, margin: '-4px 0 8px' }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

