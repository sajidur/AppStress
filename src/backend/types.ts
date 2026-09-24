import type { SharedCache } from '../engine/executor.js';
import type { Snapshot } from '../metrics/collector.js';
import type { RunStats } from '../metrics/stats.js';
import type { CallSample, RunConfig, VuJob, Workflow } from '../types.js';

export type BackendMode = 'memory' | 'distributed';

export interface WorkerInfo {
  id: string;
  kind?: string;
  host?: string;
  pid?: number;
  concurrency: number;
  activeVus: number;
  connected?: boolean;
  ts: number;
}

/**
 * Shared run state: run definitions, test users, counters, metrics, stop signals,
 * the cross-worker variable cache and worker heartbeats.
 * Implemented by Redis (distributed) and by in-process maps (memory).
 */
export interface StateBackend {
  readonly kind: 'redis' | 'memory';
  ping(): Promise<boolean>;

  saveRun(config: RunConfig, workflow: Workflow, users: Record<string, string>[]): Promise<void>;
  loadRun(runId: string): Promise<{ config: RunConfig; workflow: Workflow } | null>;
  getUser(runId: string, index: number): Promise<Record<string, string>>;
  /** monotonically increasing cursor for users-mode=per-iteration */
  nextUserIndex(runId: string): Promise<number>;

  requestStop(runId: string): Promise<void>;
  isStopped(runId: string): Promise<boolean>;

  markVuStarted(runId: string): Promise<void>;
  markVuDone(runId: string): Promise<void>;
  markIterationDone(runId: string): Promise<void>;
  getIterations(runId: string): Promise<number>;
  /** a worker's current number of active VUs for the run (stale reports are ignored) */
  reportActive(runId: string, workerId: string, active: number): Promise<void>;

  flushMetrics(runId: string, snap: Snapshot): Promise<void>;
  loadStats(runId: string, stepOrder?: string[]): Promise<RunStats>;
  /** calls kept with full request/response details (at most the run's capture limits per step) */
  loadSamples(runId: string): Promise<CallSample[]>;

  sharedCache(runId: string): SharedCache;

  heartbeat(info: WorkerInfo): Promise<void>;
  removeWorker(id: string): Promise<void>;
  listWorkers(): Promise<WorkerInfo[]>;
  recentRuns(limit: number): Promise<string[]>;

  /** drop the run's state after ttlSec (results are persisted elsewhere) */
  expireRun(runId: string, ttlSec: number): Promise<void>;
  close(): Promise<void>;
}

/** A delivered virtual-user job. Exactly one of ack()/requeue() must be called unless lost() is true. */
export interface JobDelivery {
  job: VuJob;
  ack(): void;
  requeue(): void;
  /** true when the delivery channel died: the broker will redeliver the job elsewhere */
  lost(): boolean;
}

/** Distributes virtual-user jobs to workers. Implemented by RabbitMQ and by an in-process queue. */
export interface JobQueue {
  readonly kind: 'rabbitmq' | 'memory';
  publish(jobs: VuJob[]): Promise<void>;
  /** Start consuming with at most `prefetch` unacknowledged jobs; retries connecting until cancelled. */
  consume(
    prefetch: number,
    onJob: (d: JobDelivery) => void,
    opts?: { name?: string; onStatus?: (connected: boolean) => void },
  ): Promise<{ cancel(): Promise<void> }>;
  info(): Promise<{ messages: number; consumers: number }>;
  close(): Promise<void>;
}

export interface Backend {
  mode: BackendMode;
  state: StateBackend;
  queue: JobQueue;
  close(): Promise<void>;
}

/** A worker report older than this is ignored (the worker is presumed dead). */
export const STALE_MS = 10_000;
