import type { FastifyBaseLogger } from 'fastify';
import type { Backend } from '../../backend/types.js';
import { launchRun, LaunchValidationError, monitorRun, newRunId, type RunProgress } from '../../distributed/controller.js';
import type { RunStats } from '../../metrics/stats.js';
import { evaluateThresholds } from '../../metrics/thresholds.js';
import type { TestSettings, Workflow } from '../../types.js';
import { errorMessage } from '../../util.js';
import { ACTIVE_STATUSES, type RunRow, type RunStatus, type RunSummary, type Store } from '../db.js';
import type { EventHub } from '../events.js';
import { applySettings, HttpError } from './helpers.js';

export const runTopic = (runId: string) => `run:${runId}`;

function summarize(s: RunStats, iterations: number): RunSummary {
  return {
    requests: s.total.count,
    errors: s.total.errors,
    errorRate: s.total.errorRate,
    rps: s.total.rps,
    avgMs: s.total.avgMs,
    p95: s.total.p95,
    iterations,
    durationSec: s.durationSec,
  };
}

/**
 * Orchestrates test runs from the web app: launches them on the distributed
 * infrastructure, streams progress, evaluates thresholds into a verdict and
 * persists results. Runs survive a server restart (state lives in Redis).
 */
export class RunService {
  private latest = new Map<string, RunProgress>();
  private monitoring = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly backend: Backend,
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
    private readonly stateTtlSec: number,
  ) {}

  latestProgress(runId: string): RunProgress | undefined {
    return this.latest.get(runId);
  }

  async start(testId: string, triggeredBy: string, overrides: Partial<TestSettings> = {}): Promise<RunRow> {
    const test = this.store.getTest(testId);
    if (!test) throw new HttpError(404, 'Test not found');
    if (!test.workflow) throw new HttpError(400, 'Build the workflow before running the test');
    const settings: TestSettings = { ...test.settings, ...overrides };
    const workflow = applySettings(test.workflow, settings);
    const users = this.store.getDatasetRows(testId);

    const runId = newRunId();
    const run = this.store.createRun({ id: runId, testId, settings, workflow, triggeredBy });
    try {
      const cfg = await launchRun(this.backend, {
        runId,
        workflow,
        users,
        vus: settings.vus,
        rampUpSec: settings.rampUpSec,
        durationSec: settings.mode === 'duration' ? settings.durationSec : undefined,
        iterations: settings.mode === 'iterations' ? settings.iterations : undefined,
        usersMode: settings.usersMode,
        thinkTimeScale: settings.thinkTimeScale,
        requestTimeoutMs: settings.requestTimeoutMs,
      });
      this.store.updateRun(runId, { status: 'running', config: cfg, startedAt: cfg.startAt });
      this.log.info({ runId, testId, vus: settings.vus }, 'run launched');
    } catch (e) {
      const message = errorMessage(e);
      this.store.updateRun(runId, { status: 'failed', verdict: 'error', error: message, finishedAt: Date.now() });
      this.log.error({ runId, err: message }, 'run launch failed');
      const status = e instanceof LaunchValidationError ? 400 : 503;
      throw new HttpError(status, status === 503 && this.backend.mode === 'distributed' ? `Could not start the run (is RabbitMQ/Redis reachable?): ${message}` : message);
    }
    this.monitor(runId, workflow);
    return this.store.getRun(run.id)!;
  }

  async stop(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new HttpError(404, 'Run not found');
    if (!ACTIVE_STATUSES.includes(run.status)) throw new HttpError(409, `Run is already ${run.status}`);
    await this.backend.state.requestStop(runId);
    this.store.updateRun(runId, { status: 'stopping' });
    this.hub.publish(runTopic(runId), { type: 'status', status: 'stopping' });
  }

  /** Re-attach to runs that were in flight when the server stopped. */
  async resume(): Promise<void> {
    for (const run of this.store.listRuns({ statuses: ACTIVE_STATUSES, limit: 1000 })) {
      const state = await this.backend.state.loadRun(run.id).catch(() => null);
      if (!state) {
        const error =
          this.backend.mode === 'memory'
            ? 'The server restarted during the run (in-memory mode keeps no run state across restarts)'
            : 'Run state was lost (Redis data missing after restart)';
        this.store.updateRun(run.id, { status: 'failed', verdict: 'error', error, finishedAt: Date.now() });
        continue;
      }
      this.log.info({ runId: run.id }, 'resuming run monitor');
      this.monitor(run.id, this.store.getRunDetails(run.id)!.workflow);
    }
  }

  private monitor(runId: string, workflow: Workflow): void {
    if (this.monitoring.has(runId)) return;
    this.monitoring.add(runId);
    const stepOrder = [...workflow.setup, ...workflow.steps].map((s) => s.name);
    const topic = runTopic(runId);

    (async () => {
      const state = await this.backend.state.loadRun(runId);
      if (!state) throw new Error('run state not found');
      const { stats, outcome } = await monitorRun(this.backend.state, state.config, stepOrder, (p) => {
        this.latest.set(runId, p);
        const current = this.store.getRun(runId);
        if (p.phase === 'stopping' && current?.status === 'running') this.store.updateRun(runId, { status: 'stopping' });
        this.hub.publish(topic, { type: 'progress', progress: p });
      });

      const run = this.store.getRun(runId)!;
      const iterations = await this.backend.state.getIterations(runId);
      const { verdict, results } = evaluateThresholds(stats, run.settings.thresholds ?? []);
      const status: RunStatus = outcome === 'completed' ? 'completed' : outcome;
      this.store.updateRun(runId, {
        status,
        verdict: outcome === 'timeout' ? 'error' : verdict,
        stats,
        summary: summarize(stats, iterations),
        thresholds: results,
        finishedAt: Date.now(),
        ...(outcome === 'timeout' ? { error: 'Some virtual users never finished (workers lost?). Results are partial.' } : {}),
      });
      this.log.info({ runId, status, verdict, requests: stats.total.count }, 'run finished');
      this.hub.publish(topic, { type: 'finished', run: this.store.getRun(runId) });
      await this.backend.state.expireRun(runId, this.stateTtlSec).catch(() => undefined);
    })()
      .catch((e) => {
        const message = errorMessage(e);
        this.log.error({ runId, err: message }, 'run monitor failed');
        this.store.updateRun(runId, { status: 'failed', verdict: 'error', error: message, finishedAt: Date.now() });
        this.hub.publish(topic, { type: 'finished', run: this.store.getRun(runId) });
      })
      .finally(() => {
        this.monitoring.delete(runId);
        this.latest.delete(runId);
      });
  }
}
