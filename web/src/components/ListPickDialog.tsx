import { useMemo, useState } from 'react';
import { api } from '../api';
import { getPathAll, isMultiPath } from '../../../src/engine/jsonpath';
import { applyListPick, conditionText, describePick, OPS, siblingFields, splitListPath, type Condition, type ListPick, type PickMode } from '../listpick';
import { useAsync } from '../hooks';
import type { Extractor, Step } from '../types';
import { Field, Modal, Spinner } from './ui';

const MODES: { id: PickMode; label: string; help: string }[] = [
  { id: 'position', label: 'The same position', help: 'Always the recorded item, e.g. the 2nd. Every user and iteration gets that position.' },
  { id: 'first', label: 'The first item', help: 'Whatever is first in the list this user receives.' },
  { id: 'last', label: 'The last item', help: 'Whatever is last in the list this user receives.' },
  { id: 'random', label: 'A random item', help: 'A different item each time: spreads users across the data.' },
  { id: 'where', label: 'An item that matches a condition', help: 'For example the first item whose status is OPEN.' },
];

/**
 * Choose which item of a list a saved value comes from: an exact position, first, last, random, or the first item
 * matching conditions. Shows what the choice would pick from the recorded response.
 */
export function ListPickDialog({
  testId,
  step,
  extractor,
  onApply,
  onClose,
}: {
  testId: string;
  step: Step;
  extractor: Extractor;
  onApply: (patch: Pick<Extractor, 'path' | 'select' | 'default'>) => void;
  onClose: () => void;
}) {
  const parts = splitListPath(extractor.path ?? '');
  const existingMulti = extractor.path ? isMultiPath(extractor.path) : false;
  const sample = useAsync(() => (step.sourceId === undefined ? Promise.resolve(null) : api.responseSample(testId, step.sourceId)), [testId, step.sourceId]);

  const [mode, setMode] = useState<PickMode>(parts ? 'position' : 'where');
  const [where, setWhere] = useState<Condition[]>([]);
  const [select, setSelect] = useState<NonNullable<Extractor['select']>>(extractor.select ?? 'first');
  const [fallback, setFallback] = useState<string | undefined>(extractor.default);
  const [manualPath, setManualPath] = useState(extractor.path ?? '');

  // the list position is unknown when the path is already a wildcard/condition: edit the path directly
  const manual = !parts;
  const suggestions = useMemo(() => (parts && sample.data ? siblingFields(sample.data.jsonPaths, parts).slice(0, 12) : []), [parts, sample.data]);

  const result: Pick<Extractor, 'path' | 'select'> = manual
    ? { path: manualPath, select }
    : applyListPick(parts!, { mode, where, select } as ListPick);

  // what the choice would pick from the recorded response
  const preview = useMemo(() => {
    const s = sample.data;
    if (!s || s.truncated || !result.path) return null;
    try {
      const all = getPathAll(JSON.parse(s.bodyPreview), result.path);
      return { count: all.length, values: all.slice(0, 6).map((v) => String(v)) };
    } catch (e) {
      return { count: -1, values: [(e as Error).message] };
    }
  }, [sample.data, result.path]);

  const addCondition = (field = '', value = '') => setWhere([...where, { field, op: '==', value }]);
  const setCond = (i: number, patch: Partial<Condition>) => setWhere(where.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const multi = manual ? existingMulti : mode !== 'position';

  return (
    <Modal
      wide
      title="Which item should this value come from?"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!result.path || preview?.count === -1} onClick={() => onApply({ path: result.path, select: multi ? result.select : undefined, default: fallback })}>
            Use this
          </button>
        </>
      }
    >
      <div className="faint" style={{ fontSize: 12.5 }}>
        Currently: <code>{extractor.path}</code> ({describePick(extractor)})
      </div>

      {manual ? (
        <Field label="JSON path" help="Use [*] for every item, or [?(@.status=='OPEN')] for the items that match a condition.">
          <input type="text" className="mono" value={manualPath} onChange={(e) => setManualPath(e.target.value)} />
        </Field>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {MODES.map((m) => (
            <label key={m.id} className="pick-mode">
              <input type="radio" name="pick-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <span>
                <b>{m.id === 'position' ? `${m.label} (#${parts!.index + 1})` : m.label}</b>
                <span className="faint"> — {m.help}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      {!manual && mode === 'where' && (
        <div className="stack" style={{ gap: 8 }}>
          {where.map((c, i) => (
            <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
              <span className="faint" style={{ width: 34 }}>{i === 0 ? 'where' : 'and'}</span>
              <input type="text" className="mono" placeholder="field, e.g. status" aria-label="Field" style={{ maxWidth: 170 }} value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} />
              <select aria-label="Comparison" style={{ maxWidth: 160 }} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Condition['op'] })}>
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input type="text" className="mono" placeholder="value" aria-label="Value" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />
              <button className="btn icon ghost" aria-label="Remove condition" onClick={() => setWhere(where.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <div className="row">
            <button className="btn small ghost" onClick={() => addCondition()}>
              + Add condition
            </button>
            {suggestions.length > 0 && <span className="faint" style={{ fontSize: 12.5 }}>The item you recorded had:</span>}
            {suggestions.map((s) => (
              <button key={s.field} className="chip pick-chip" title="Use as a condition" onClick={() => addCondition(s.field, s.value)}>
                {s.field} = {s.value}
              </button>
            ))}
          </div>
          <Field label="If several items match, use">
            <select value={select} onChange={(e) => setSelect(e.target.value as typeof select)} style={{ maxWidth: 220 }}>
              <option value="first">the first one</option>
              <option value="last">the last one</option>
              <option value="random">a random one</option>
            </select>
          </Field>
        </div>
      )}

      {manual && (
        <Field label="If several items match, use">
          <select value={select} onChange={(e) => setSelect(e.target.value as typeof select)} style={{ maxWidth: 220 }}>
            <option value="first">the first one</option>
            <option value="last">the last one</option>
            <option value="random">a random one</option>
          </select>
        </Field>
      )}

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="check">
          <input type="checkbox" checked={fallback !== undefined} onChange={(e) => setFallback(e.target.checked ? '' : undefined)} />
          If nothing matches, use a fallback value instead of failing the step
        </label>
        {fallback !== undefined && <input type="text" className="mono" style={{ maxWidth: 220 }} aria-label="Fallback value" placeholder="value" value={fallback} onChange={(e) => setFallback(e.target.value)} />}
      </div>

      <div className="callout">
        <div className="faint" style={{ fontSize: 12.5 }}>Result</div>
        <code style={{ wordBreak: 'break-all' }}>{result.path}</code>
        {multi && <span className="faint"> · {select === 'first' ? 'first' : select} match</span>}
        {sample.loading && step.sourceId !== undefined ? (
          <div className="row faint" style={{ marginTop: 6 }}>
            <Spinner /> Checking against the recorded response…
          </div>
        ) : preview ? (
          <div style={{ marginTop: 6, fontSize: 13 }}>
            {preview.count === -1 ? (
              <span style={{ color: 'var(--critical-text)' }}>{preview.values[0]}</span>
            ) : preview.count === 0 ? (
              <span style={{ color: 'var(--warning-text)' }}>In the recorded response nothing matches this{fallback !== undefined ? ', so the fallback would be used' : ' (the step would fail)'}.</span>
            ) : (
              <>
                In the recorded response it matches <b>{preview.count}</b> item{preview.count === 1 ? '' : 's'}: <code>{preview.values.join(', ')}</code>
                {preview.count > preview.values.length ? ', …' : ''}
              </>
            )}
          </div>
        ) : (
          <div className="faint" style={{ marginTop: 6, fontSize: 12.5 }}>
            {step.sourceId === undefined ? 'This step was not recorded, so the choice cannot be previewed.' : 'The recorded response is too long to preview here.'}
          </div>
        )}
      </div>
      {where.length > 0 && <div className="faint" style={{ fontSize: 12.5 }}>Condition: <code>{where.map(conditionText).join(' && ')}</code></div>}
    </Modal>
  );
}
