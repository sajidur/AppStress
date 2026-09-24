import type { SharedCache } from '../engine/executor.js';
import { mergeSamples } from '../engine/sampling.js';
import type { Snapshot } from '../metrics/collector.js';
import { computeStats, mergeSnapshot, type RawRun, type RunStats } from '../metrics/stats.js';
import { DEFAULT_CAPTURE, type CallSample, type RunConfig, type VuJob, type Workflow } from '../types.js';
import { STALE_MS, type Backend, type JobDelivery, type JobQueue, type StateBackend, type WorkerInfo } from './types.js';

interface MemoryRun {
  config: RunConfig;
  workflow: Workflow;
  users: Record<string, string>[];
  userCursor: number;
  stopped: boolean;
  iterations: number;
  started: number;
  done: number;
  active: Map<string, { n: number; ts: number }>;
  raw: RawRun;
  samples: CallSample[];
  cache: Map<string, { vars: Record<string, string>; expiresAt: number }>;
  createdAt: number;
  expiry?: NodeJS.Timeout;
}

/**
 * Run state kept in process memory. Everything a Redis-backed run keeps is here,
 * so the controller, workers and reports behave identically; it just cannot be
 * shared with other processes.
 */
export class MemoryState implements StateBackend {
  readonly kind = 'memory' as const;
  private runs = new Map<string, MemoryRun>();
  private workers = new Map<string, WorkerInfo>();

  private run(runId: string): MemoryRun | undefined {
    return this.runs.get(runId);
  }

  async ping() {
    return true;
  }

  async saveRun(config: RunConfig, workflow: Workflow, users: Record<string, string>[]) {
    this.runs.set(config.runId, {
      config,
      workflow,
      users,
      userCursor: 0,
      stopped: false,
      iterations: 0,
      started: 0,
      done: 0,
      active: new Map(),
      raw: { config, vus: { started: 0, active: 0, done: 0 }, steps: new Map(), timeline: new Map(), errors: new Map() },
      samples: [],
      cache: new Map(),
      createdAt: Date.now(),
    });
  }

  async loadRun(runId: string) {
    const r = this.run(runId);
    return r ? { config: r.config, workflow: r.workflow } : null;
  }

  async getUser(runId: string, index: number) {
    const r = this.run(runId);
    return r?.users.length ? r.users[index % r.users.length] : {};
  }

  async nextUserIndex(runId: string) {
    const r = this.run(runId);
    return r ? r.userCursor++ : 0;
  }

  async requestStop(runId: string) {
    const r = this.run(runId);
    if (r) r.stopped = true;
  }

  async isStopped(runId: string) {
    return this.run(runId)?.stopped ?? false;
  }

  async markVuStarted(runId: string) {
    const r = this.run(runId);
    if (r) r.started++;
  }

  async markVuDone(runId: string) {
    const r = this.run(runId);
    if (r) r.done++;
  }

  async markIterationDone(runId: string) {
    const r = this.run(runId);
    if (r) r.iterations++;
  }

  async getIterations(runId: string) {
    return this.run(runId)?.iterations ?? 0;
  }

  async reportActive(runId: string, workerId: string, active: number) {
    this.run(runId)?.active.set(workerId, { n: active, ts: Date.now() });
  }

  async flushMetrics(runId: string, snap: Snapshot) {
    const r = this.run(runId);
    if (!r) return;
    mergeSnapshot(r.raw, snap);
    if (snap.samples.length) mergeSamples(r.samples, snap.samples, r.config.capture ?? DEFAULT_CAPTURE);
  }

  async loadSamples(runId: string) {
    return [...(this.run(runId)?.samples ?? [])];
  }

  async loadStats(runId: string, stepOrder: string[] = []): Promise<RunStats> {
    const r = this.run(runId);
    if (!r) return computeStats(runId, { config: null, vus: { started: 0, active: 0, done: 0 }, steps: new Map(), timeline: new Map(), errors: new Map() }, stepOrder);
    const now = Date.now();
    let active = 0;
    for (const a of r.active.values()) if (now - a.ts < STALE_MS) active += a.n;
    return computeStats(runId, { ...r.raw, vus: { started: r.started, active, done: r.done } }, stepOrder);
  }

  sharedCache(runId: string): SharedCache {
    return {
      get: async (key) => {
        const e = this.run(runId)?.cache.get(key);
        return e && e.expiresAt > Date.now() ? e.vars : null;
      },
      set: async (key, vars, ttlSec) => {
        this.run(runId)?.cache.set(key, { vars, expiresAt: Date.now() + Math.max(1, ttlSec) * 1000 });
      },
    };
  }

  async heartbeat(info: WorkerInfo) {
    this.workers.set(info.id, info);
  }

  async removeWorker(id: string) {
    this.workers.delete(id);
  }

  async listWorkers() {
    const now = Date.now();
    return [...this.workers.values()].filter((w) => now - w.ts < STALE_MS).sort((a, b) => a.id.localeCompare(b.id));
  }

  async recentRuns(limit: number) {
    return [...this.runs.entries()]
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .slice(0, limit)
      .map(([id]) => id);
  }

  async expireRun(runId: string, ttlSec: number) {
    const r = this.run(runId);
    if (!r) return;
    if (r.expiry) clearTimeout(r.expiry);
    r.expiry = setTimeout(() => this.runs.delete(runId), ttlSec * 1000);
    r.expiry.unref();
  }

  async close() {
    for (const r of this.runs.values()) if (r.expiry) clearTimeout(r.expiry);
    this.runs.clear();
  }
}

interface MemoryConsumer {
  prefetch: number;
  inflight: number;
  onJob: (d: JobDelivery) => void;
  cancelled: boolean;
}

/** In-process job queue with the same semantics as the RabbitMQ one: prefetch, ack, requeue. */
export class MemoryQueue implements JobQueue {
  readonly kind = 'memory' as const;
  private ready: VuJob[] = [];
  private consumers: MemoryConsumer[] = [];
  private next = 0;
  private dispatching = false;

  async publish(jobs: VuJob[]) {
    this.ready.push(...jobs);
    this.dispatch();
  }

  async consume(prefetch: number, onJob: (d: JobDelivery) => void, opts?: { onStatus?: (connected: boolean) => void }) {
    const c: MemoryConsumer = { prefetch, inflight: 0, onJob, cancelled: false };
    this.consumers.push(c);
    opts?.onStatus?.(true);
    this.dispatch();
    return {
      cancel: async () => {
        c.cancelled = true;
        this.consumers = this.consumers.filter((x) => x !== c);
      },
    };
  }

  /** Round-robin jobs to consumers that still have prefetch capacity. */
  private dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.ready.length) {
        const open = this.consumers.filter((c) => !c.cancelled && c.inflight < c.prefetch);
        if (!open.length) return;
        const c = open[this.next++ % open.length];
        const job = this.ready.shift()!;
        c.inflight++;
        let settled = false;
        const settle = (requeue: boolean) => {
          if (settled) return;
          settled = true;
          c.inflight--;
          if (requeue) this.ready.unshift(job);
          queueMicrotask(() => this.dispatch());
        };
        c.onJob({ job, ack: () => settle(false), requeue: () => settle(true), lost: () => false });
      }
    } finally {
      this.dispatching = false;
    }
  }

  async info() {
    return { messages: this.ready.length, consumers: this.consumers.length };
  }

  async close() {
    this.consumers = [];
  }
}

export function createMemoryBackend(): Backend {
  const state = new MemoryState();
  const queue = new MemoryQueue();
  return {
    mode: 'memory',
    state,
    queue,
    close: async () => {
      await queue.close();
      await state.close();
    },
  };
}
