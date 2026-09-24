import { performance } from 'node:perf_hooks';
import type { CallSample, Step, Workflow } from '../types.js';
import { errorMessage, sleepInterruptible } from '../util.js';
import { applyAuth } from './auth.js';
import { CookieJar } from './cookies.js';
import { parseSetCookies, runExtractor, type ResponseView } from './extract.js';
import { cut, maskHeaders, maskText, maskVars, type CallSampler } from './sampling.js';
import { render, renderRecord, type Vars } from './template.js';

export const ITERATION_METRIC = '__iteration__';

/** Receives one sample per HTTP step (and per iteration). */
export interface MetricSink {
  record(step: string, durationMs: number, status: number, error?: string): void;
}

/** Cross-worker cache for vars (e.g. auth tokens), backed by Redis in distributed mode. */
export interface SharedCache {
  get(key: string): Promise<Vars | null>;
  set(key: string, vars: Vars, ttlSec: number): Promise<void>;
}

export interface StepTrace {
  step: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  error?: string;
  extracted: Vars;
  cached?: boolean;
  /** workflow-level authentication: applied, skipped (variable not available yet) or own (step sets its own header) */
  auth?: 'applied' | 'skipped' | 'own';
  requestBody?: string;
  responseSnippet?: string;
  /** full request/response details; present when the sampler asked for this call */
  call?: CallSample;
}

export interface VirtualUserOptions {
  workflow: Workflow;
  user: Record<string, string>;
  vuIndex: number;
  metrics: MetricSink;
  cache?: SharedCache;
  requestTimeoutMs: number;
  thinkTimeScale: number;
  shouldStop: () => boolean;
  /** keeps full request/response details for selected calls (reports); optional */
  sampler?: CallSampler;
  /** called after every step; used by `lt validate` */
  onTrace?: (trace: StepTrace) => void;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** What the fetch actually did, for call details: the first hop's headers (with cookies) and the redirects followed. */
interface FetchProbe {
  sent?: Record<string, string>;
  hops: { status: number; url: string }[];
}

/**
 * One simulated user: owns a cookie jar and a variable scope, and executes the
 * workflow's setup once and its steps once per iteration.
 */
export class VirtualUser {
  private jar = new CookieJar();
  private vars: Vars = {};
  private phase: CallSample['phase'] = 'setup';
  private iteration = 0;

  constructor(private readonly o: VirtualUserOptions) {
    this.setUser(o.user);
  }

  /** Swap the user (users-mode=per-iteration): fresh cookies and variables. */
  setUser(user: Record<string, string>): void {
    this.jar.clear();
    this.vars = { ...this.o.workflow.variables, $vu: String(this.o.vuIndex) };
    for (const [k, v] of Object.entries(user)) this.vars[`user.${k}`] = v;
  }

  runSetup(): Promise<boolean> {
    this.phase = 'setup';
    return this.runSteps(this.o.workflow.setup);
  }

  async runIteration(iteration: number): Promise<boolean> {
    this.vars.$iteration = String(iteration);
    this.phase = 'iteration';
    this.iteration = iteration;
    const t0 = performance.now();
    const ok = await this.runSteps(this.o.workflow.steps);
    if (this.o.workflow.steps.length && !this.o.shouldStop()) {
      this.o.metrics.record(ITERATION_METRIC, performance.now() - t0, ok ? 200 : 0, ok ? undefined : 'iteration failed');
    }
    return ok;
  }

  private async runSteps(steps: Step[]): Promise<boolean> {
    let allOk = true;
    for (const step of steps) {
      if (this.o.shouldStop()) return false;
      const think = (step.thinkTimeMs ?? 0) * this.o.thinkTimeScale;
      if (think > 0) await sleepInterruptible(think, this.o.shouldStop);
      if (this.o.shouldStop()) return false;
      const ok = await this.execStep(step);
      if (!ok) {
        allOk = false;
        if (this.o.workflow.onError !== 'continue') return false;
      }
    }
    return allOk;
  }

  private async execStep(step: Step): Promise<boolean> {
    const { metrics, cache, onTrace } = this.o;

    // Shared cache: reuse vars (e.g. a token) that any worker already obtained.
    let cacheKey: string | undefined;
    if (step.cache && cache) {
      try {
        cacheKey = render(step.cache.key, this.vars);
        const hit = await cache.get(cacheKey);
        if (hit) {
          Object.assign(this.vars, hit);
          onTrace?.({ step: step.name, method: step.request.method, url: '(cache)', status: 0, durationMs: 0, extracted: hit, cached: true });
          return true;
        }
      } catch {
        /* cache is best-effort */
      }
    }

    let url: string, method: string, headers: Record<string, string>, body: string | undefined;
    let authStatus: StepTrace['auth'];
    try {
      method = step.request.method.toUpperCase();
      url = render(step.request.url, this.vars);
      headers = {
        ...renderRecord(this.o.workflow.defaults?.headers, this.vars),
        ...renderRecord(step.request.headers, this.vars),
      };
      body = step.request.body !== undefined ? render(step.request.body, this.vars) : undefined;
      const auth = this.o.workflow.auth;
      if (auth && !step.skipAuth) {
        const r = applyAuth(auth, this.vars, headers, url);
        url = r.url;
        authStatus = r.status;
      }
    } catch (e) {
      const error = `template: ${errorMessage(e)}`;
      metrics.record(step.name, 0, 0, error);
      const call = this.sample(step, { method: step.request.method, url: step.request.url, headers: { ...(step.request.headers ?? {}) }, body: step.request.body, ms: 0, error, extracted: {} });
      onTrace?.({ step: step.name, method: step.request.method, url: step.request.url, status: 0, durationMs: 0, error, extracted: {}, call });
      return false;
    }

    const t0 = performance.now();
    let res: ResponseView;
    const probe: FetchProbe = { hops: [] };
    try {
      res = await this.fetchFollowingRedirects(method, url, headers, body, probe);
    } catch (e) {
      const ms = performance.now() - t0;
      const error = (e as Error)?.name === 'TimeoutError' ? `timeout after ${this.o.requestTimeoutMs}ms` : errorMessage(e);
      metrics.record(step.name, ms, 0, error);
      const call = this.sample(step, { method, url, headers, body, ms, error, extracted: {}, auth: authStatus, probe });
      onTrace?.({ step: step.name, method, url, status: 0, durationMs: ms, error, extracted: {}, auth: authStatus, requestBody: body, call });
      return false;
    }
    const ms = performance.now() - t0;

    let error: string | undefined;
    const expected = step.expect?.status;
    if (expected?.length ? !expected.includes(res.status) : res.status >= 400) {
      error = `unexpected status ${res.status}`;
    } else if (step.expect?.bodyContains && !res.body.includes(step.expect.bodyContains)) {
      error = `body does not contain "${step.expect.bodyContains}"`;
    }

    const extracted: Vars = {};
    if (!error) {
      for (const ex of step.extract ?? []) {
        const v = runExtractor(ex, res);
        if (v === undefined) {
          if (!ex.optional) {
            error = `extract "${ex.var}" failed (${ex.from} ${ex.path ?? ex.name ?? ex.regex ?? ''})`;
            break;
          }
        } else {
          extracted[ex.var] = v;
        }
      }
      Object.assign(this.vars, extracted);
    }

    metrics.record(step.name, ms, res.status, error);
    const call = this.sample(step, { method, url, headers, body, res, ms, error, extracted, auth: authStatus, probe });
    onTrace?.({
      step: step.name,
      method,
      url,
      status: res.status,
      durationMs: ms,
      error,
      extracted,
      auth: authStatus,
      requestBody: body,
      responseSnippet: res.body.slice(0, 300),
      call,
    });

    if (!error && step.cache && cache && cacheKey) {
      const toCache = Object.fromEntries(step.cache.vars.filter((v) => v in this.vars).map((v) => [v, this.vars[v]]));
      cache.set(cacheKey, toCache, step.cache.ttlSec).catch(() => undefined);
    }
    return !error;
  }

  /** Build the full details of one call when the sampler wants it (returns undefined otherwise). */
  private sample(
    step: Step,
    c: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
      res?: ResponseView;
      ms: number;
      error?: string;
      extracted: Vars;
      auth?: CallSample['auth'];
      probe?: FetchProbe;
    },
  ): CallSample | undefined {
    const sampler = this.o.sampler;
    if (!sampler || !sampler.want(step.name, !!c.error)) return undefined;
    const { maskSecrets, bodyKb } = sampler.capture;
    const max = bodyKb * 1024;
    const m = (t: string) => (maskSecrets ? maskText(t) : t);
    const reqBody = cut(c.body, max);
    const sample: CallSample = {
      step: step.name,
      outcome: c.error ? 'error' : 'ok',
      phase: this.phase,
      at: Date.now() - Math.round(c.ms),
      vu: this.o.vuIndex,
      iteration: this.iteration,
      durationMs: c.ms,
      request: {
        method: c.method,
        url: m(c.url),
        headers: maskSecrets ? maskHeaders(c.probe?.sent ?? c.headers) : (c.probe?.sent ?? c.headers),
        ...(reqBody.text !== undefined ? { body: m(reqBody.text) } : {}),
        ...(reqBody.truncated ? { bodyTruncated: true } : {}),
      },
      ...(c.error ? { error: c.error } : {}),
      extracted: maskSecrets ? maskVars(c.extracted) : c.extracted,
      ...(c.auth ? { auth: c.auth } : {}),
      ...(maskSecrets ? { masked: true } : {}),
    };
    if (c.probe?.hops.length) sample.redirects = c.probe.hops;
    if (c.res) {
      const resBody = cut(c.res.body, max);
      const headers: Record<string, string> = {};
      c.res.headers.forEach((v, k) => (headers[k] = v));
      const setCookie = c.res.headers.getSetCookie();
      if (setCookie.length) headers['set-cookie'] = setCookie.join('\n');
      sample.response = {
        status: c.res.status,
        headers: maskSecrets ? maskHeaders(headers) : headers,
        ...(resBody.text !== undefined ? { body: m(resBody.text) } : {}),
        ...(resBody.truncated ? { bodyTruncated: true } : {}),
        bytes: Buffer.byteLength(c.res.body),
      };
    }
    sampler.add(sample);
    return sample;
  }

  /** fetch with manual redirects so Set-Cookie on every hop lands in the jar. */
  private async fetchFollowingRedirects(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    probe: FetchProbe,
  ): Promise<ResponseView> {
    const signal = AbortSignal.timeout(this.o.requestTimeoutMs);
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    const hdrs = { ...headers };
    const setCookies: string[] = [];

    for (let hop = 0; hop <= 10; hop++) {
      const cookie = this.jar.header(currentUrl);
      const reqHeaders = { ...hdrs };
      if (cookie) reqHeaders.cookie = reqHeaders.cookie ? `${reqHeaders.cookie}; ${cookie}` : cookie;
      if (hop === 0) probe.sent = reqHeaders;

      const res = await fetch(currentUrl, {
        method: currentMethod,
        headers: reqHeaders,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal,
      });
      const sc = res.headers.getSetCookie();
      setCookies.push(...sc);
      this.jar.store(currentUrl, sc);

      const location = res.headers.get('location');
      if (REDIRECTS.has(res.status) && location) {
        await res.arrayBuffer().catch(() => undefined);
        currentUrl = new URL(location, currentUrl).toString();
        probe.hops.push({ status: res.status, url: currentUrl });
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
          for (const k of Object.keys(hdrs)) if (k.toLowerCase() === 'content-type') delete hdrs[k];
        }
        continue;
      }
      return { status: res.status, headers: res.headers, body: await res.text(), setCookies: parseSetCookies(setCookies) };
    }
    throw new Error('too many redirects');
  }
}
