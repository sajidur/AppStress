import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Backend, JobDelivery, StateBackend } from '../backend/types.js';
import { config } from '../config.js';
import { VirtualUser, type SharedCache } from '../engine/executor.js';
import { MetricsCollector } from '../metrics/collector.js';
import type { RunConfig, VuJob, Workflow } from '../types.js';
import { errorMessage, log, sleep, sleepInterruptible } from '../util.js';

export interface WorkerOptions {
  concurrency: number;
  id?: string;
  /** label shown in the UI, e.g. "embedded" */
  kind?: string;
}

/** State shared by all VUs of one run on this worker. */
interface RunContext {
  runId: string;
  config: RunConfig;
  workflow: Workflow;
  collector: MetricsCollector;
  cache: SharedCache;
  stopped: boolean;
  refs: number;
  /** VUs of this run currently executing on this worker */
  active: number;
  timer: NodeJS.Timeout;
}

type Outcome = 'done' | 'requeue' | 'lost';

/**
 * Load generator: takes virtual-user jobs from the job queue and executes them.
 * Works with either backend (in-memory, or RabbitMQ + Redis for a worker fleet).
 *
 * Resilience (distributed mode):
 *  - a VU job is acked only when the VU finishes; if this worker dies the broker
 *    redelivers it to another worker
 *  - on a broker connection loss, running VUs are aborted (their jobs are redelivered)
 *    and the queue reconnects with backoff
 *  - stop() drains gracefully and hands unfinished VUs back to the queue
 */
export class LoadWorker {
  readonly id: string;
  private readonly state: StateBackend;
  private consumer?: { cancel(): Promise<void> };
  private runs = new Map<string, Promise<RunContext | null>>();
  private activeVus = 0;
  private stopping = false;
  private hbTimer?: NodeJS.Timeout;
  private connected = false;
  /** metrics batching: Redis round-trips are batched per second; in-process merging is cheap */
  private readonly flushMs: number;

  constructor(
    private readonly backend: Backend,
    private readonly opts: WorkerOptions,
  ) {
    this.id = opts.id ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 4)}`;
    this.state = backend.state;
    this.flushMs = backend.mode === 'memory' ? Math.min(250, config.metricsFlushMs) : config.metricsFlushMs;
  }

  get status() {
    return { id: this.id, connected: this.connected, activeVus: this.activeVus, concurrency: this.opts.concurrency };
  }

  async start(): Promise<void> {
    this.hbTimer = setInterval(() => void this.heartbeat(), config.heartbeatMs);
    await this.heartbeat();
    this.consumer = await this.backend.queue.consume(this.opts.concurrency, (d) => void this.onJob(d), {
      name: `lt-worker ${this.id}`,
      onStatus: (c) => {
        this.connected = c;
        void this.heartbeat();
      },
    });
    log('worker', `${this.id} ready: concurrency=${this.opts.concurrency}, queue=${this.backend.queue.kind}`);
  }

  /** Graceful stop: stop taking jobs, abort running VUs (their jobs are requeued). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.activeVus) log('worker', `${this.id}: stopping, handing ${this.activeVus} VU(s) back to the queue...`);
    await this.consumer?.cancel();
    const deadline = Date.now() + 15_000;
    while (this.activeVus > 0 && Date.now() < deadline) await sleep(200);
    if (this.hbTimer) clearInterval(this.hbTimer);
    await this.state.removeWorker(this.id).catch(() => undefined);
  }

  private async heartbeat(): Promise<void> {
    await this.state
      .heartbeat({
        id: this.id,
        kind: this.opts.kind ?? 'standalone',
        host: hostname(),
        pid: process.pid,
        concurrency: this.opts.concurrency,
        activeVus: this.activeVus,
        connected: this.connected,
        ts: Date.now(),
      })
      .catch(() => undefined);
  }

  /* ---------------------------------------------------------------- jobs */

  private async onJob(d: JobDelivery): Promise<void> {
    this.activeVus++;
    let outcome: Outcome = 'done';
    try {
      outcome = await this.runVu(d.job, d.lost);
    } catch (e) {
      log('worker', `VU ${d.job.vuIndex} of ${d.job.runId} crashed: ${errorMessage(e)}`);
    } finally {
      this.activeVus--;
    }
    if (outcome === 'lost' || d.lost()) return; // the queue redelivers it elsewhere
    if (outcome === 'requeue') d.requeue();
    else {
      await this.state.markVuDone(d.job.runId).catch(() => undefined);
      d.ack();
    }
  }

  private async runVu(job: VuJob, lost: () => boolean): Promise<Outcome> {
    const ctx = await this.acquireRun(job.runId);
    if (!ctx) {
      log('worker', `run ${job.runId} not found, dropping VU ${job.vuIndex}`);
      return 'done';
    }
    const cfg = ctx.config;
    // stopped / shutting down / connection lost: nothing more should be sent, not even a logout
    const aborted = () => ctx.stopped || this.stopping || lost();
    const shouldStop = () => aborted() || Date.now() >= cfg.endAt;
    const interrupted = (): Outcome => (lost() ? 'lost' : this.stopping ? 'requeue' : 'done');
    try {
      await sleepInterruptible(cfg.startAt + job.startDelayMs - Date.now(), shouldStop);
      if (shouldStop()) return interrupted();

      await this.state.markVuStarted(job.runId);
      ctx.active++;
      await this.reportActive(ctx);
      try {
        const vu = new VirtualUser({
          workflow: ctx.workflow,
          user: await this.pickUser(ctx, job.vuIndex),
          vuIndex: job.vuIndex,
          metrics: ctx.collector,
          sampler: ctx.collector,
          cache: ctx.cache,
          requestTimeoutMs: cfg.requestTimeoutMs,
          thinkTimeScale: cfg.thinkTimeScale,
          shouldStop,
          shouldAbort: aborted,
        });
        let setupDone = false;
        // end the current session: log out, if the workflow has logout steps
        const endSession = async () => {
          if (setupDone && ctx.workflow.teardown?.length && !aborted()) await vu.runTeardown().catch(() => undefined);
          setupDone = false;
        };
        for (let i = 0; !shouldStop() && (cfg.iterations === undefined || i < cfg.iterations); i++) {
          if (i > 0 && (cfg.usersMode === 'per-iteration' || cfg.freshSession)) {
            await endSession();
            // a new user, or the same user with a clean session: the old cookies must not leak into the new login
            if (cfg.usersMode === 'per-iteration') vu.setUser(await this.pickUser(ctx, job.vuIndex));
            else vu.resetSession();
            if (shouldStop()) break;
          }
          if (!setupDone) {
            setupDone = await vu.runSetup();
            if (!setupDone) {
              // login failed: back off a little; counts as a failed iteration
              await sleepInterruptible(1000, shouldStop);
              continue;
            }
          }
          if (await vu.runIteration(i)) await this.state.markIterationDone(job.runId);
          // failed iteration (e.g. target down): back off instead of hammering in a tight error loop
          else await sleepInterruptible(1000, shouldStop);
        }
        await endSession();
      } finally {
        ctx.active--;
        await this.reportActive(ctx);
      }
      return interrupted();
    } finally {
      await this.releaseRun(ctx);
    }
  }

  private async pickUser(ctx: RunContext, vuIndex: number): Promise<Record<string, string>> {
    if (!ctx.config.usersCount) return {};
    const index = ctx.config.usersMode === 'per-iteration' ? await this.state.nextUserIndex(ctx.runId) : vuIndex;
    return this.state.getUser(ctx.runId, index);
  }

  private async reportActive(ctx: RunContext): Promise<void> {
    await this.state.reportActive(ctx.runId, this.id, ctx.active).catch(() => undefined);
  }

  private async flush(ctx: RunContext): Promise<void> {
    const snap = ctx.collector.drain();
    if (snap) await this.state.flushMetrics(ctx.runId, snap).catch((e) => log('worker', 'metrics flush failed', errorMessage(e)));
  }

  private acquireRun(runId: string): Promise<RunContext | null> {
    let p = this.runs.get(runId);
    if (!p) {
      p = (async () => {
        const run = await this.state.loadRun(runId);
        if (!run) return null;
        const ctx: RunContext = {
          runId,
          ...run,
          collector: new MetricsCollector(run.config.capture),
          cache: this.state.sharedCache(runId),
          stopped: await this.state.isStopped(runId),
          refs: 0,
          active: 0,
          timer: setInterval(async () => {
            await this.flush(ctx);
            await this.reportActive(ctx);
            if (await this.state.isStopped(runId).catch(() => false)) ctx.stopped = true;
          }, this.flushMs),
        };
        log('worker', `${this.id}: joined run ${runId} (${run.workflow.name})`);
        return ctx;
      })();
      this.runs.set(runId, p);
    }
    return p.then((ctx) => {
      if (ctx) ctx.refs++;
      else this.runs.delete(runId);
      return ctx;
    });
  }

  private async releaseRun(ctx: RunContext): Promise<void> {
    if (--ctx.refs > 0) return;
    // detach synchronously so a VU arriving during the flush gets a fresh context
    clearInterval(ctx.timer);
    this.runs.delete(ctx.runId);
    await this.flush(ctx);
  }
}

/** Standalone worker process (CLI). */
export async function startWorker(backend: Backend, opts: WorkerOptions): Promise<void> {
  const worker = new LoadWorker(backend, opts);
  let signals = 0;
  const shutdown = async (signal: string) => {
    if (++signals > 1) process.exit(1);
    log('worker', `${signal} received (press again to force)`);
    await worker.stop();
    await backend.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await worker.start();
}
