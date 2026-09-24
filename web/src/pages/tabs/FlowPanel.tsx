import { useMemo } from 'react';
import { analyzeFlow, type FlowInput, type FlowIssue, type FlowStep } from '../../../../src/builder/flow';
import { Card, MethodTag } from '../../components/ui';
import type { BuildReport, Workflow } from '../../types';

function Origin({ input }: { input: FlowInput }) {
  if (input.origin === 'user') return <span className="flow-chip user" title={input.how}>👤 {input.how.replace('users file, column ', 'users file · ').replace(/"/g, '')}</span>;
  if (input.origin === 'generated') {
    return (
      <span className="flow-chip gen" title={input.how}>
        ⚙ {input.from ? `made up in ${input.from}` : input.how}
      </span>
    );
  }
  return (
    <span className={`flow-chip step${input.ordered ? '' : ' bad'}`} title={input.how}>
      ↩ {input.from} · <code>{input.how}</code>
    </span>
  );
}

function StepCard({ s, n, onPick, onRemove }: { s: FlowStep; n: number; onPick: (step: string, variable: string) => void; onRemove: (step: string, variable: string) => void }) {
  return (
    <div className="flow-step">
      <div className="flow-head">
        <span className="flow-n">{n}</span>
        <MethodTag method={s.method} />
        <span className="mono flow-path" title={s.name}>
          {s.path}
        </span>
        <span className="chip">{s.phase === 'setup' ? 'once per user' : s.phase === 'teardown' ? 'when the session ends' : 'every iteration'}</span>
      </div>
      <div className="flow-body">
        {s.inputs.length === 0 && s.generates.length === 0 && s.outputs.length === 0 && s.fixedDynamic.length === 0 && <div className="faint">Nothing flows in or out. This request is the same for every user.</div>}

        {s.inputs.length > 0 && (
          <div className="flow-block">
            <div className="flow-label">takes</div>
            <div className="flow-rows">
              {s.inputs.map((i, k) => (
                <div className="flow-row" key={k}>
                  <span className="flow-where">{i.where}</span>
                  <span className="faint">←</span>
                  <Origin input={i} />
                  <code className="faint">{i.text}</code>
                </div>
              ))}
            </div>
          </div>
        )}

        {s.fixedDynamic.length > 0 && (
          <div className="flow-block">
            <div className="flow-label warn">fixed</div>
            <div className="flow-rows">
              {s.fixedDynamic.map((f, k) => (
                <div className="flow-row" key={k}>
                  <span className="flow-where">{f.where}</span>
                  <span className="faint">=</span>
                  <span className="flow-chip bad" title="Recorded value that looks dynamic, sent unchanged to every user">
                    same for every user · <code>{f.value}</code>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(s.generates.length > 0 || s.outputs.length > 0) && (
          <div className="flow-block">
            <div className="flow-label out">saves</div>
            <div className="flow-rows">
              {s.generates.map((g) => (
                <div className="flow-row" key={g.variable}>
                  <code>{'${' + g.variable + '}'}</code>
                  <span className="faint">=</span>
                  <span className="flow-chip gen">⚙ new value, {g.how.replace(/\$\{|\}/g, '')}</span>
                </div>
              ))}
              {s.outputs.map((o) => (
                <div className="flow-row" key={o.variable}>
                  <code>{'${' + o.variable + '}'}</code>
                  <span className="faint">=</span>
                  <code className="flow-how">{o.how}</code>
                  {o.usedBy.length > 0 ? (
                    <>
                      <span className="faint">→</span>
                      {o.usedBy.map((u) => (
                        <span className="chip" key={u}>
                          {u}
                        </span>
                      ))}
                    </>
                  ) : (
                    <>
                      <span className="faint">→ not used</span>
                      <button className="btn small ghost" onClick={() => onRemove(s.name, o.variable)}>
                        Remove
                      </button>
                    </>
                  )}
                  {o.fixedPosition && (
                    <button className="btn small" title="Fixed list position: choose first, random, or an item that matches a condition" onClick={() => onPick(s.name, o.variable)}>
                      Make dynamic…
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Issue({ i, onPick, onRemove }: { i: FlowIssue; onPick: (step: string, variable: string) => void; onRemove: (step: string, variable: string) => void }) {
  return (
    <div className={`callout ${i.level === 'warn' ? 'warn' : ''}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span aria-hidden>{i.level === 'warn' ? '⚠' : 'ℹ'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{i.message}</div>
        {i.hint && <div className="faint" style={{ fontSize: 12.5 }}>{i.hint}</div>}
      </div>
      {i.kind === 'fixed-position' && i.step && i.variable && (
        <button className="btn small" onClick={() => onPick(i.step!, i.variable!)}>
          Make dynamic…
        </button>
      )}
      {i.kind === 'unused' && i.step && i.variable && (
        <button className="btn small ghost" onClick={() => onRemove(i.step!, i.variable!)}>
          Remove
        </button>
      )}
    </div>
  );
}

/**
 * How data moves through the workflow for one user: what each request takes (and from where) and what it saves for
 * later requests, computed live from the workflow being edited. Problems are listed first.
 */
export function FlowPanel({
  workflow,
  userColumns,
  report,
  onPick,
  onRemove,
}: {
  workflow: Workflow;
  userColumns: string[];
  report: BuildReport | null;
  onPick: (step: string, variable: string) => void;
  onRemove: (step: string, variable: string) => void;
}) {
  const flow = useMemo(() => analyzeFlow(workflow, { userColumns }), [workflow, userColumns]);
  // problems found while recording (typed values the page transforms) do not show up in the workflow itself
  const recorded = (report?.flow?.issues ?? []).filter((i) => i.kind === 'encrypted');
  const issues = [...recorded, ...flow.issues.filter((i) => i.level === 'warn'), ...flow.issues.filter((i) => i.level === 'info')];
  const total = workflow.setup.length + workflow.steps.length + (workflow.teardown?.length ?? 0);

  return (
    <Card
      title="Data flow"
      hint={
        <>
          Every virtual user takes <b>one row of the users file</b>
          {userColumns.length ? ` (${userColumns.join(', ')})` : ''} and runs these {total} steps in order, in parallel with the others. Values a step saves are that user's own, so each user carries their own
          token and data through the flow.
        </>
      }
    >
      <div className="stack">
        <div className="flow-legend">
          <span className="flow-chip user">👤 users file</span>
          <span className="flow-chip step">↩ from an earlier response</span>
          <span className="flow-chip gen">⚙ generated for every call</span>
          <span className="flow-chip bad">same for every user</span>
          <span className="faint">
            · {flow.links} value{flow.links === 1 ? '' : 's'} handed from one step to another
          </span>
        </div>

        {issues.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            {issues.map((i, k) => (
              <Issue key={k} i={i} onPick={onPick} onRemove={onRemove} />
            ))}
          </div>
        )}

        <div className="stack" style={{ gap: 8 }}>
          {flow.steps.map((s, k) => (
            <StepCard key={s.name} s={s} n={k + 1} onPick={onPick} onRemove={onRemove} />
          ))}
        </div>

        {report?.generated && report.generated.length > 0 && (
          <div>
            <div className="section-title">Made up by the browser, now generated for every call</div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Where</th>
                    <th>Recorded value</th>
                    <th>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {report.generated.map((g, i) => (
                    <tr key={i}>
                      <td className="mono">{g.step}</td>
                      <td>{g.where}</td>
                      <td className="mono faint">{g.recorded}</td>
                      <td>
                        <code>{g.kind === 'uuid' ? '${$uuid}' : g.kind === 'timestamp' ? '${$timestamp}' : g.kind === 'timestamp-seconds' ? '${$timestampSec}' : '${$isoDate}'}</code>
                        {g.variable && <span className="faint"> saved as ${'{' + g.variable + '}'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {report?.typed && report.typed.length > 0 && (
          <div>
            <div className="section-title">What was typed while recording</div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Typed</th>
                    <th>Now comes from</th>
                    <th>Sent in</th>
                  </tr>
                </thead>
                <tbody>
                  {report.typed.map((t, i) => (
                    <tr key={i}>
                      <td>
                        {t.label || t.field} {t.label && t.field && <span className="faint mono">({t.field})</span>}
                      </td>
                      <td className="mono">{t.value}</td>
                      <td>{t.column ? <span className="flow-chip user">👤 users file · {t.column}</span> : <span className="faint">recorded value (not mapped)</span>}</td>
                      <td>
                        {t.sentIn.length ? t.sentIn.map((s) => <span key={s} className="chip">{s}</span>) : <span className="badge warn">not found in any request</span>}
                        {t.encoding && <span className="badge info" title="Each user's own value is encoded the same way">sent as {t.encoding.join(', ')}</span>}
                      </td>
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

