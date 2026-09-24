import { Redis } from 'ioredis';
import { config } from '../config.js';
import type { SharedCache } from '../engine/executor.js';
import type { Snapshot } from '../metrics/collector.js';
import { computeStats, emptyRawStep, type RawRun, type RunStats } from '../metrics/stats.js';
import { DEFAULT_CAPTURE, type CallSample, type RunConfig, type Workflow } from '../types.js';
import { STALE_MS, type StateBackend, type WorkerInfo } from './types.js';

/** All Redis keys used by one run live under lt:<runId>:* */
export const keys = {
  runs: 'lt:runs',
  workers: 'lt:workers',
  config: (r: string) => `lt:${r}:config`,
  workflow: (r: string) => `lt:${r}:workflow`,
  users: (r: string) => `lt:${r}:users`,
  userCursor: (r: string) => `lt:${r}:users:cursor`,
  stop: (r: string) => `lt:${r}:stop`,
  vusStarted: (r: string) => `lt:${r}:vus:started`,
  /** hash workerId -> {"n":activeVus,"ts":epochMs}; stale entries (dead workers) are ignored */
  vusActive: (r: string) => `lt:${r}:vus:active`,
  vusDone: (r: string) => `lt:${r}:vus:done`,
  steps: (r: string) => `lt:${r}:steps`,
  step: (r: string, s: string) => `lt:${r}:step:${s}`,
  hist: (r: string, s: string) => `lt:${r}:hist:${s}`,
  timeline: (r: string) => `lt:${r}:timeline`,
  errors: (r: string) => `lt:${r}:errors`,
  /** list of JSON call samples; sampleCounts: hash "step|outcome" -> how many were kept */
  samples: (r: string) => `lt:${r}:samples`,
  sampleCounts: (r: string) => `lt:${r}:samples:count`,
  cache: (r: string, k: string) => `lt:${r}:cache:${k}`,
  iterations: (r: string) => `lt:${r}:iterations`,
};

type LtRedis = Redis & {
  hsetmax(key: string, field: string, value: number): Promise<number>;
  hsetmin(key: string, field: string, value: number): Promise<number>;
};
type LtPipeline = ReturnType<Redis['pipeline']> & {
  hsetmax(k: string, f: string, v: number): unknown;
  hsetmin(k: string, f: string, v: number): unknown;
  pushsample(list: string, counts: string, field: string, cap: number, json: string): unknown;
};

function createRedis(url: string): LtRedis {
  const redis = new Redis(url, { maxRetriesPerRequest: 3 }) as LtRedis;
  redis.defineCommand('hsetmax', {
    numberOfKeys: 1,
    lua: `local c = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
          if tonumber(ARGV[2]) > c then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end return 1`,
  });
  redis.defineCommand('hsetmin', {
    numberOfKeys: 1,
    lua: `local c = redis.call('HGET', KEYS[1], ARGV[1])
          if (not c) or tonumber(ARGV[2]) < tonumber(c) then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end return 1`,
  });
  // keep a call sample only while fewer than `cap` were stored for this step/outcome (atomic across workers)
  redis.defineCommand('pushsample', {
    numberOfKeys: 2,
    lua: `local n = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
          if n < tonumber(ARGV[2]) then redis.call('HSET', KEYS[2], ARGV[1], n + 1) redis.call('RPUSH', KEYS[1], ARGV[3]) return 1 end return 0`,
  });
  redis.on('error', (e) => console.error('[redis]', e.message));
  return redis;
}

/** Run state in Redis, shared by the controller and every worker process. */
export class RedisState implements StateBackend {
  readonly kind = 'redis' as const;
  readonly redis: LtRedis;

  constructor(url = config.redisUrl) {
    this.redis = createRedis(url);
  }

  async ping() {
    return this.redis.ping().then(() => true).catch(() => false);
  }

  async saveRun(cfg: RunConfig, workflow: Workflow, users: Record<string, string>[]) {
    const r = cfg.runId;
    // users first, then workflow + config (workers treat config as "run exists")
    for (let i = 0; i < users.length; i += 1000) {
      await this.redis.rpush(keys.users(r), ...users.slice(i, i + 1000).map((u) => JSON.stringify(u)));
    }
    await this.redis
      .multi()
      .set(keys.workflow(r), JSON.stringify(workflow))
      .set(keys.config(r), JSON.stringify(cfg))
      .zadd(keys.runs, Date.now(), r)
      .exec();
  }

  async loadRun(runId: string) {
    const [cfg, wf] = await this.redis.mget(keys.config(runId), keys.workflow(runId));
    if (!cfg || !wf) return null;
    return { config: JSON.parse(cfg) as RunConfig, workflow: JSON.parse(wf) as Workflow };
  }

  async getUser(runId: string, index: number) {
    const len = await this.redis.llen(keys.users(runId));
    if (!len) return {};
    const raw = await this.redis.lindex(keys.users(runId), index % len);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }

  async nextUserIndex(runId: string) {
    return (await this.redis.incr(keys.userCursor(runId))) - 1;
  }

  async requestStop(runId: string) {
    await this.redis.set(keys.stop(runId), '1');
  }

  async isStopped(runId: string) {
    return (await this.redis.exists(keys.stop(runId))) === 1;
  }

  async markVuStarted(runId: string) {
    await this.redis.incr(keys.vusStarted(runId));
  }

  async markVuDone(runId: string) {
    await this.redis.incr(keys.vusDone(runId));
  }

  async markIterationDone(runId: string) {
    await this.redis.incr(keys.iterations(runId));
  }

  async getIterations(runId: string) {
    return Number((await this.redis.get(keys.iterations(runId))) ?? 0);
  }

  async reportActive(runId: string, workerId: string, active: number) {
    await this.redis.hset(keys.vusActive(runId), workerId, JSON.stringify({ n: active, ts: Date.now() }));
  }

  async flushMetrics(runId: string, snap: Snapshot) {
    const p = this.redis.pipeline() as LtPipeline;
    for (const [step, a] of snap.steps) {
      const k = keys.step(runId, step);
      p.sadd(keys.steps(runId), step);
      p.hincrby(k, 'count', a.count);
      p.hincrby(k, 'errors', a.errors);
      p.hincrbyfloat(k, 'sumMs', a.sumMs);
      p.hsetmax(k, 'maxMs', Math.round(a.maxMs * 1000) / 1000);
      p.hsetmin(k, 'minMs', Math.round(a.minMs * 1000) / 1000);
      for (const [status, c] of a.statuses) p.hincrby(k, `status:${status}`, c);
      const hk = keys.hist(runId, step);
      for (const [b, c] of a.buckets) p.hincrby(hk, String(b), c);
    }
    const tk = keys.timeline(runId);
    for (const [sec, s] of snap.timeline) {
      p.hincrby(tk, `${sec}:r`, s.requests);
      p.hincrby(tk, `${sec}:e`, s.errors);
      p.hincrbyfloat(tk, `${sec}:s`, s.sumMs);
    }
    for (const [key, c] of snap.errors) p.hincrby(keys.errors(runId), key, c);
    if (snap.samples.length) {
      const cap = await this.captureOf(runId);
      for (const s of snap.samples) {
        p.pushsample(keys.samples(runId), keys.sampleCounts(runId), `${s.step}|${s.outcome}`, s.outcome === 'ok' ? cap.okSamples : cap.errorSamples, JSON.stringify(s));
      }
    }
    await p.exec();
  }

  private captures = new Map<string, Promise<typeof DEFAULT_CAPTURE>>();
  private captureOf(runId: string) {
    let c = this.captures.get(runId);
    if (!c) {
      c = this.redis.get(keys.config(runId)).then((raw) => (raw ? (JSON.parse(raw) as RunConfig).capture : undefined) ?? DEFAULT_CAPTURE);
      this.captures.set(runId, c);
    }
    return c;
  }

  async loadSamples(runId: string): Promise<CallSample[]> {
    return (await this.redis.lrange(keys.samples(runId), 0, -1)).map((j) => JSON.parse(j) as CallSample);
  }

  async loadStats(runId: string, stepOrder: string[] = []): Promise<RunStats> {
    const r = this.redis;
    const [cfgRaw, started, done] = await r.mget(keys.config(runId), keys.vusStarted(runId), keys.vusDone(runId));
    const now = Date.now();
    const active = Object.values(await r.hgetall(keys.vusActive(runId))).reduce((sum, raw) => {
      const e = JSON.parse(raw) as { n: number; ts: number };
      return now - e.ts < STALE_MS ? sum + e.n : sum;
    }, 0);

    const raw: RawRun = {
      config: cfgRaw ? JSON.parse(cfgRaw) : null,
      vus: { started: Number(started ?? 0), active, done: Number(done ?? 0) },
      steps: new Map(),
      timeline: new Map(),
      errors: new Map(),
    };

    for (const [field, v] of Object.entries(await r.hgetall(keys.timeline(runId)))) {
      const [sec, kind] = field.split(':');
      const t = raw.timeline.get(Number(sec)) ?? { requests: 0, errors: 0, sumMs: 0 };
      if (kind === 'r') t.requests = Number(v);
      else if (kind === 'e') t.errors = Number(v);
      else t.sumMs = Number(v);
      raw.timeline.set(Number(sec), t);
    }

    const names = await r.smembers(keys.steps(runId));
    const p = r.pipeline();
    for (const n of names) p.hgetall(keys.step(runId, n)).hgetall(keys.hist(runId, n));
    const res = (await p.exec()) ?? [];
    names.forEach((n, i) => {
      const h = res[i * 2][1] as Record<string, string>;
      const hist = res[i * 2 + 1][1] as Record<string, string>;
      const s = emptyRawStep();
      s.count = Number(h.count ?? 0);
      s.errors = Number(h.errors ?? 0);
      s.sumMs = Number(h.sumMs ?? 0);
      s.maxMs = Number(h.maxMs ?? 0);
      s.minMs = h.minMs === undefined ? Infinity : Number(h.minMs);
      for (const [k, v] of Object.entries(h)) if (k.startsWith('status:')) s.statuses.set(k.slice(7), Number(v));
      for (const [b, c] of Object.entries(hist)) s.buckets.set(Number(b), Number(c));
      raw.steps.set(n, s);
    });

    for (const [k, c] of Object.entries(await r.hgetall(keys.errors(runId)))) raw.errors.set(k, Number(c));
    return computeStats(runId, raw, stepOrder);
  }

  sharedCache(runId: string): SharedCache {
    return {
      get: async (key) => {
        const v = await this.redis.get(keys.cache(runId, key));
        return v ? (JSON.parse(v) as Record<string, string>) : null;
      },
      set: async (key, vars, ttlSec) => {
        await this.redis.set(keys.cache(runId, key), JSON.stringify(vars), 'EX', Math.max(1, ttlSec));
      },
    };
  }

  async heartbeat(info: WorkerInfo) {
    await this.redis.hset(keys.workers, info.id, JSON.stringify(info));
  }

  async removeWorker(id: string) {
    await this.redis.hdel(keys.workers, id);
  }

  async listWorkers() {
    const all = await this.redis.hgetall(keys.workers);
    const now = Date.now();
    const alive: WorkerInfo[] = [];
    for (const [id, raw] of Object.entries(all)) {
      const w = JSON.parse(raw) as WorkerInfo;
      if (now - w.ts < STALE_MS) alive.push(w);
      else await this.redis.hdel(keys.workers, id); // prune dead workers
    }
    return alive.sort((a, b) => a.id.localeCompare(b.id));
  }

  async recentRuns(limit: number) {
    return this.redis.zrevrange(keys.runs, 0, limit - 1);
  }

  async expireRun(runId: string, ttlSec: number) {
    let cursor = '0';
    do {
      const [next, found] = await this.redis.scan(cursor, 'MATCH', `lt:${runId}:*`, 'COUNT', 500);
      cursor = next;
      if (found.length) {
        const p = this.redis.pipeline();
        for (const k of found) p.expire(k, ttlSec);
        await p.exec();
      }
    } while (cursor !== '0');
  }

  async close() {
    this.redis.disconnect();
  }
}
