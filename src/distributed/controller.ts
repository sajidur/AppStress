import { randomBytes } from 'node:crypto';
import type { Backend, StateBackend } from '../backend/types.js';
import { config } from '../config.js';
import { printSummary, writeReports } from '../metrics/report.js';
import type { RunStats } from '../metrics/stats.js';
import { DEFAULT_CAPTURE, type CallSample, type CaptureSettings, type RunConfig, UsersMode, VuJob, Workflow } from '../types.js';
import { log, sleep } from '../util.js';

export type { WorkerInfo } from '../backend/types.js';

export interface LaunchOptions {
  workflow: Workflow;
  users: Record<string, string>[];
  vus: number;
  rampUpSec: number;
  durationSec?: number;
  iterations?: number;
  usersMode: UsersMode;
  thinkTimeScale: number;
  requestTimeoutMs: number;
  /** how many calls per step keep full request/response details (default: DEFAULT_CAPTURE) */
  capture?: CaptureSettings;
  runId?: string;
  /** seconds between VU job publication and the start of VU #0 */
  startDelaySec?: number;
}

export interface RunProgress {
  runId: string;
  phase: 'starting' | 'running' | 'stopping' | 'finishing';
  elapsedSec: number;
  currentRps: number;
  iterations: number;
  stats: RunStats;
}

export type RunOutcome = 'completed' | 'stopped' | 'timeout';

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

/** Invalid run settings (as opposed to infrastructure failures). */
export class LaunchValidationError extends Error {}

export function validateLaunch(o: LaunchOptions): void {
  const fail = (m: string) => {
    throw new LaunchValidationError(m);
  };
  if (!(o.vus >= 1)) fail('At least 1 virtual user is required');
  if (!o.durationSec && !o.iterations) fail('Specify a duration and/or iterations');
  if (!o.workflow.steps.length && !o.workflow.setup.length) fail('The workflow has no steps');
  if (o.usersMode === 'unique' && o.users.length < o.vus) {
    fail(`Users mode "unique" needs at least ${o.vus} users, but the users file has ${o.users.length}`);
  }
  if (JSON.stringify(o.workflow).includes('${user.') && !o.users.length) {
    fail('The workflow uses ${user.*} values but no users file was provided');
  }
}

/** Store the run (workflow, users, config) and queue one job per virtual user with its ramp-up offset. */
export async function launchRun(backend: Backend, o: LaunchOptions): Promise<RunConfig> {
  validateLaunch(o);
  const runId = o.runId ?? newRunId();
  const startAt = Date.now() + (o.startDelaySec ?? (backend.mode === 'memory' ? 1 : 3)) * 1000;
  const endAt = o.durationSec ? startAt + o.durationSec * 1000 : startAt + 7 * 24 * 3600 * 1000;
  const runConfig: RunConfig = {
    runId,
    vus: o.vus,
    rampUpSec: o.rampUpSec,
    durationSec: o.durationSec,
    iterations: o.iterations,
    usersMode: o.usersMode,
    usersCount: o.users.length,
    thinkTimeScale: o.thinkTimeScale,
    requestTimeoutMs: o.requestTimeoutMs,
    capture: o.capture ?? DEFAULT_CAPTURE,
    startAt,
    endAt,
    createdAt: Date.now(),
  };
  await backend.state.saveRun(runConfig, o.workflow, o.users);
  const jobs: VuJob[] = [];
  for (let vu = 0; vu < o.vus; vu++) {
    jobs.push({ runId, vuIndex: vu, startDelayMs: o.vus > 1 ? Math.round((o.rampUpSec * 1000 * vu) / (o.vus - 1)) : 0 });
  }
  await backend.queue.publish(jobs);
  return runConfig;
}

/**
 * Poll the run state until every VU has finished (or a stop/timeout), reporting progress.
 * Safe to call again after a restart in distributed mode: all state lives in Redis.
 */
export async function monitorRun(
  state: StateBackend,
  cfg: RunConfig,
  stepOrder: string[],
  onProgress: (p: RunProgress) => void,
  intervalMs = 2000,
): Promise<{ stats: RunStats; outcome: RunOutcome }> {
  let stoppedAt: number | undefined;
  let lastReq = -1;
  let lastT = Date.now();
  let outcome: RunOutcome = 'completed';
  let failures = 0;
  for (;;) {
    await sleep(intervalMs);
    let s: RunStats;
    try {
      s = await state.loadStats(cfg.runId, stepOrder);
      if (!stoppedAt && (await state.isStopped(cfg.runId))) stoppedAt = Date.now();
      failures = 0;
    } catch (e) {
      // tolerate short state-store outages; workers keep generating load meanwhile
      if (++failures >= 60) throw e;
      continue;
    }
    const now = Date.now();
    const currentRps = lastReq < 0 ? 0 : ((s.total.count - lastReq) * 1000) / (now - lastT);
    lastReq = s.total.count;
    lastT = now;
    const iterations = await state.getIterations(cfg.runId).catch(() => 0);
    const phase: RunProgress['phase'] = now < cfg.startAt ? 'starting' : stoppedAt ? 'stopping' : now > cfg.endAt ? 'finishing' : 'running';
    onProgress({ runId: cfg.runId, phase, elapsedSec: Math.max(0, Math.round((now - cfg.startAt) / 1000)), currentRps, iterations, stats: s });

    if (s.vus.done >= cfg.vus) {
      if (stoppedAt) outcome = 'stopped';
      break;
    }
    // Safety net: VUs of dead workers are redelivered by the queue; give up after a grace period.
    const deadline = Math.min(cfg.endAt, stoppedAt ?? Infinity) + 60_000;
    if (now > deadline) {
      await state.requestStop(cfg.runId);
      outcome = stoppedAt ? 'stopped' : 'timeout';
      break;
    }
  }
  await sleep(config.metricsFlushMs + 1000); // let the last metric flushes land
  return { stats: await state.loadStats(cfg.runId, stepOrder), outcome };
}

/* ------------------------------------------------------------------ CLI */

/** Launch a run, print live progress, write reports. */
export async function runAndReport(backend: Backend, o: LaunchOptions & { reportDir: string }): Promise<RunStats> {
  const workers = await backend.state.listWorkers();
  const capacity = workers.reduce((s, w) => s + w.concurrency, 0);
  if (!workers.length) log('controller', 'WARNING: no live workers found. Jobs will wait in the queue until workers start.');
  else if (capacity < o.vus) log('controller', `WARNING: ${o.vus} VUs requested but workers only have capacity for ${capacity}.`);
  else log('controller', `${workers.length} worker(s), total capacity ${capacity} VUs (${backend.mode} mode)`);

  const cfg = await launchRun(backend, o);
  log('controller', `Run ${cfg.runId}: ${o.vus} VUs; ramp-up ${o.rampUpSec}s, ` +
    (o.durationSec ? `duration ${o.durationSec}s` : `${o.iterations} iteration(s)/VU`) + `, users=${o.users.length} (${o.usersMode})`);
  log('controller', backend.mode === 'distributed' ? `Stop early with Ctrl+C or "lt stop ${cfg.runId}"` : 'Stop early with Ctrl+C');

  let stopRequested = false;
  const onSigint = () => {
    if (stopRequested) process.exit(1);
    stopRequested = true;
    log('controller', 'Stopping run (Ctrl+C again to exit immediately)...');
    void backend.state.requestStop(cfg.runId);
  };
  process.on('SIGINT', onSigint);

  const stepOrder = [...o.workflow.setup, ...o.workflow.steps].map((s) => s.name);
  const { stats } = await monitorRun(backend.state, cfg, stepOrder, (p) => {
    const s = p.stats;
    const label = p.phase === 'starting' ? 'starting' : `t+${p.elapsedSec}s`;
    console.log(
      `[${label}] VUs active ${s.vus.active}/${cfg.vus} done ${s.vus.done} | reqs ${s.total.count} (${p.currentRps.toFixed(1)}/s) ` +
        `| errors ${s.total.errors} (${(s.total.errorRate * 100).toFixed(1)}%) | avg ${s.total.avgMs.toFixed(0)}ms ` +
        `p95 ${s.total.p95.toFixed(0)}ms | iterations ok ${p.iterations}`,
    );
  });
  process.off('SIGINT', onSigint);

  printSummary(stats);
  const samples = await backend.state.loadSamples(cfg.runId).catch(() => []);
  const files = writeReports(stats, o.workflow, o.reportDir, { samples, capture: cfg.capture });
  log('controller', `Reports: ${files.join(', ')}`);
  return stats;
}
