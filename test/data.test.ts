import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createMemoryBackend } from '../src/backend/memory.js';
import { launchRun, monitorRun } from '../src/distributed/controller.js';
import { LoadWorker } from '../src/distributed/worker.js';
import { mergeSamples } from '../src/engine/sampling.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { buildApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { EventHub } from '../src/server/events.js';
import { DEFAULT_SETTINGS, type CallSample, type CaptureSettings, type Recording, type Workflow } from '../src/types.js';

const WF: Workflow = { name: 'w', variables: {}, setup: [], steps: [{ name: 'a', request: { method: 'GET', url: 'http://x/a' } }] };

const call = (step: string, outcome: 'ok' | 'error', n: number, status = 200): CallSample => ({
  step, outcome, phase: 'iteration', at: 1000 + n, vu: 0, iteration: n, durationMs: 5,
  request: { method: 'GET', url: `http://x/${step}?n=${n}`, headers: {} },
  response: { status: outcome === 'ok' ? status : 500, headers: {}, body: `body ${n}`, bytes: 6 },
  extracted: {},
});

const seedStore = () => {
  const store = new Store(':memory:');
  store.createTest({ id: 't1', name: 'T', description: '', startUrl: 'http://x', settings: DEFAULT_SETTINGS });
  store.createTest({ id: 't2', name: 'Other', description: '', startUrl: 'http://y', settings: DEFAULT_SETTINGS });
  const run = (id: string, testId: string, status: 'completed' | 'running') => {
    store.createRun({ id, testId, settings: DEFAULT_SETTINGS, workflow: WF, triggeredBy: 'test' });
    store.updateRun(id, { status, ...(status === 'completed' ? { finishedAt: 1 } : {}) });
  };
  run('r1', 't1', 'completed');
  run('r2', 't1', 'completed');
  run('r3', 't1', 'running');
  run('r4', 't2', 'completed');
  const calls = [...Array.from({ length: 6 }, (_, i) => call('a', 'ok', i)), ...Array.from({ length: 3 }, (_, i) => call('b', 'error', i)), call('b', 'ok', 9)];
  store.saveRunCalls('r1', calls);
  store.saveRunCalls('r2', calls.slice(0, 2));
  store.saveRunCalls('r4', calls.slice(0, 1));
  const rec: Recording = { version: 1, startUrl: 'http://x', recordedAt: '', navigations: [], exchanges: [] };
  store.saveRecording('t1', rec, 0, 'import');
  store.saveDataset('t1', 'u.csv', ['a'], [{ a: '1' }]);
  return store;
};

describe('keeping every call', () => {
  const keepAll: CaptureSettings = { okSamples: 0, errorSamples: 0, bodyKb: 16, maskSecrets: true, keepAll: true, maxCalls: 4 };

  it('the collector keeps calls of every step until the limit, ignoring the per-step counts', () => {
    const c = new MetricsCollector(keepAll);
    c.record('a', 1, 200);
    const kept: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = i % 2 ? 'a' : 'b';
      if (c.want(step, i % 3 === 0)) (c.add(call(step, i % 3 === 0 ? 'error' : 'ok', i)), kept.push(`${step}${i}`));
    }
    assert.equal(kept.length, 4, 'stops at maxCalls');
    assert.equal(c.want('__iteration__', false), false);
    assert.equal(c.drain()!.samples.length, 4);
  });

  it('merging workers respects the same limit', () => {
    const into: CallSample[] = [];
    mergeSamples(into, [call('a', 'ok', 1), call('a', 'ok', 2), call('b', 'ok', 3)], keepAll);
    mergeSamples(into, [call('a', 'ok', 4), call('a', 'ok', 5)], keepAll);
    assert.equal(into.length, 4);
  });

  describe('in a real run', () => {
    let server: Server;
    let base: string;
    before(async () => {
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () => res.writeHead(req.url === '/bad' ? 500 : 200, { 'content-type': 'application/json' }).end('{"ok":true}'));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    const run = async (capture: CaptureSettings) => {
      const backend = createMemoryBackend();
      const worker = new LoadWorker(backend, { concurrency: 4, id: 't' });
      await worker.start();
      const workflow: Workflow = { name: 'w', variables: { baseUrl: base }, onError: 'continue', setup: [], steps: [{ name: 'good', request: { method: 'GET', url: '${baseUrl}/ok' } }, { name: 'bad', request: { method: 'GET', url: '${baseUrl}/bad' } }] };
      const cfg = await launchRun(backend, { workflow, users: [], vus: 3, rampUpSec: 0, iterations: 5, usersMode: 'per-vu', thinkTimeScale: 0, requestTimeoutMs: 5000, capture, startDelaySec: 0 });
      const { stats } = await monitorRun(backend.state, cfg, ['good', 'bad'], () => undefined, 200);
      const samples = await backend.state.loadSamples(cfg.runId);
      await worker.stop();
      return { stats, samples };
    };

    it('keeps every one of the calls', async () => {
      const { stats, samples } = await run({ okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true, keepAll: true, maxCalls: 1000 });
      assert.equal(stats.total.count, 30, '3 users x 5 iterations x 2 steps');
      assert.equal(samples.length, 30, 'all of them are kept in full');
      assert.equal(samples.filter((s) => s.step === 'bad' && s.outcome === 'error' && s.response?.status === 500).length, 15);
      assert.ok(samples.every((s) => s.response?.body === '{"ok":true}'));
    });

    it('stops keeping details at the safety limit, but still counts every request', async () => {
      const { stats, samples } = await run({ okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true, keepAll: true, maxCalls: 7 });
      assert.equal(stats.total.count, 30);
      assert.equal(samples.length, 7);
    });
  });
});

describe('stored calls and deleting them', () => {
  it('stores one row per call and can page through, filter and summarise them', () => {
    const store = seedStore();
    assert.deepEqual(store.runCallGroups('r1'), [{ step: 'a', outcome: 'ok', count: 6 }, { step: 'b', outcome: 'error', count: 3 }, { step: 'b', outcome: 'ok', count: 1 }]);
    const p1 = store.getRunCalls('r1', { limit: 4, offset: 0 });
    assert.equal(p1.total, 10);
    assert.deepEqual(p1.calls.map((c) => c.iteration), [0, 1, 2, 3]);
    assert.deepEqual(store.getRunCalls('r1', { limit: 4, offset: 8 }).calls.length, 2);
    assert.equal(store.getRunCalls('r1', { step: 'b', outcome: 'error', limit: 10, offset: 0 }).total, 3);
    assert.equal(store.getRunCalls('r1', { status: 500, limit: 10, offset: 0 }).total, 3);
    assert.equal(store.getRunSamples('r1').length, 10);
    assert.equal(store.getRunSamples('r1', 2).length, 2 + 2 + 1, 'at most 2 per step and outcome');
    store.close();
  });

  it('removes only the call details of a run, keeping the run', () => {
    const store = seedStore();
    assert.equal(store.deleteRunCalls('r1'), 10);
    assert.deepEqual(store.getRunSamples('r1'), []);
    assert.ok(store.getRun('r1'));
    assert.equal(store.getRunSamples('r2').length, 2, 'other runs are untouched');
    store.close();
  });

  it('deleting runs also deletes their calls, and never touches active runs', () => {
    const store = seedStore();
    assert.deepEqual(store.deleteRuns({ testId: 't1' }), { deleted: 2, skipped: 1 });
    assert.equal(store.getRun('r1'), null);
    assert.ok(store.getRun('r3'), 'the running run stays');
    assert.equal(store.getRunSamples('r1').length, 0);
    assert.equal(store.getRunSamples('r4').length, 1, 'another test is untouched');
    assert.deepEqual(store.deleteRuns({ ids: ['r4', 'r3', 'nope'] }), { deleted: 1, skipped: 1 });
    assert.deepEqual(store.deleteRuns({ ids: [] }), { deleted: 0, skipped: 0 });
    assert.deepEqual(store.deleteRuns({ all: true }), { deleted: 0, skipped: 1 });
    store.close();
  });

  it('summarises what is stored and clears the recording and the workflow', () => {
    const store = seedStore();
    const s = store.testDataSummary('t1');
    assert.equal(s.recording?.exchanges, 0);
    assert.equal(s.users?.rows, 1);
    assert.deepEqual([s.runs.count, s.runs.active, s.calls.count], [3, 1, 12]);
    assert.ok(s.calls.bytes > 0 && s.runs.bytes > 0);
    assert.equal(store.deleteRecording('t1'), true);
    assert.equal(store.deleteRecording('t1'), false);
    store.updateTest('t1', { workflow: WF, buildReport: { kept: 1, dropped: 0, correlations: [], userFieldSteps: [] } });
    store.clearWorkflow('t1');
    const t = store.getTest('t1')!;
    assert.equal(t.workflow, null);
    assert.equal(t.buildReport, null);
    assert.equal(store.testDataSummary('t1').recording, null);
    store.close();
  });

  it('reads runs saved before calls had their own table', () => {
    const store = seedStore();
    // a run from an older version kept its calls as one JSON value
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare('UPDATE runs SET samples = ? WHERE id = ?').run(JSON.stringify([call('a', 'ok', 1), call('a', 'ok', 2), call('a', 'ok', 3)]), 'r3');
    assert.equal(store.getRunSamples('r3').length, 3);
    assert.equal(store.getRunSamples('r3', 2).length, 2);
    assert.equal(store.getRunCalls('r3', { limit: 2, offset: 1 }).calls.length, 2);
    assert.deepEqual(store.runCallGroups('r3'), [{ step: 'a', outcome: 'ok', count: 3 }]);
    assert.equal(store.deleteRunCalls('r3'), 1);
    assert.equal(store.getRunSamples('r3').length, 0);
    store.close();
  });
});

describe('delete API', () => {
  const setup = async () => {
    const store = seedStore();
    const { app } = await buildApp({ store, backend: createMemoryBackend(), hub: new EventHub(), recorderHeadless: true, recorderEnabled: false, redisRunTtlSec: 60, maxUploadMb: 1, logLevel: 'silent' });
    const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { store, app, call };
  };

  it('pages through a run\'s calls and reports the groups', async () => {
    const { app, call, store } = await setup();
    const r = (await call('GET', '/api/runs/r1/calls?step=a&limit=4&offset=4')).json();
    assert.deepEqual([r.total, r.calls.length], [6, 2]);
    const s = (await call('GET', '/api/runs/r1/samples?perGroup=2')).json();
    assert.equal(s.samples.length, 5);
    assert.deepEqual(s.groups.map((g: { count: number }) => g.count), [6, 3, 1]);
    await app.close();
    store.close();
  });

  it('shows what is stored, and clears chosen parts of a test', async () => {
    const { app, call, store } = await setup();
    const d = (await call('GET', '/api/tests/t1/data')).json();
    assert.deepEqual([d.runs.count, d.calls.count, d.users.rows], [3, 12, 1]);

    const blocked = await call('POST', '/api/tests/t1/clear', { runs: true });
    assert.equal(blocked.statusCode, 409, 'an active run blocks deleting runs');
    assert.match(blocked.json().error, /active run/);

    const users = (await call('POST', '/api/tests/t1/clear', { users: true, recording: true })).json();
    assert.equal(users.users, null);
    assert.equal(users.recording, null);
    assert.equal(users.cleared.users, true);
    assert.equal(store.getRun('r1') !== null, true, 'runs were not asked for');

    store.updateRun('r3', { status: 'completed', finishedAt: 2 });
    const calls = (await call('POST', '/api/tests/t1/clear', { calls: true })).json();
    assert.equal(calls.calls.count, 0);
    assert.equal(calls.runs.count, 3, 'the runs stay when only their calls are cleared');

    const runs = (await call('POST', '/api/tests/t1/clear', { runs: true })).json();
    assert.equal(runs.runs.count, 0);
    assert.equal(store.getRun('r4') !== null, true, 'another test keeps its runs');
    assert.equal((await call('POST', '/api/tests/nope/clear', {})).statusCode, 404);
    await app.close();
    store.close();
  });

  it('deletes selected runs, all runs, or just their call details', async () => {
    const { app, call, store } = await setup();
    assert.equal((await call('DELETE', '/api/runs/r3/calls')).statusCode, 409, 'not while it runs');
    assert.equal((await call('DELETE', '/api/runs/r1/calls')).json().deleted, 10);
    assert.equal((await call('POST', '/api/runs/delete', {})).statusCode, 400, 'must say which runs');
    assert.deepEqual((await call('POST', '/api/runs/delete', { ids: ['r2'], only: 'calls' })).json(), { deleted: 2, skipped: 0 });
    assert.ok(store.getRun('r2'));
    assert.deepEqual((await call('POST', '/api/runs/delete', { ids: ['r1', 'r3'] })).json(), { deleted: 1, skipped: 1 });
    assert.deepEqual((await call('POST', '/api/runs/delete', { all: true })).json(), { deleted: 2, skipped: 1 });
    assert.equal(store.listRuns({}).length, 1, 'only the active run is left');
    await app.close();
    store.close();
  });
});

import { normalizeCapture } from '../src/types.js';
import { sampleBytes } from '../src/engine/sampling.js';

describe('every call is kept by default', () => {
  it('fills in the defaults, also for settings saved before "every call" existed', () => {
    assert.deepEqual([normalizeCapture(undefined).keepAll, normalizeCapture(undefined).maxCalls], [true, 100_000]);
    const legacy = normalizeCapture({ okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true });
    assert.equal(legacy.keepAll, true, 'an old 3-per-step setting that was never chosen on purpose no longer limits the run');
    assert.equal(normalizeCapture({ keepAll: false, okSamples: 3 }).keepAll, false, 'choosing a few per step is respected');
    assert.equal(normalizeCapture({ okSamples: 0, errorSamples: 0, bodyKb: 16, maskSecrets: true }).keepAll, false, 'an old "capture off" (0 and 0) stays off');
    assert.equal(normalizeCapture({ okSamples: 0, errorSamples: 0, keepAll: true }).keepAll, true, 'unless every call is asked for');
    assert.equal(normalizeCapture({ maxCalls: 5 }).maxCalls, 5);
    assert.equal(normalizeCapture({ maskSecrets: false }).maskSecrets, false);
  });

  it('estimates the size of a kept call from its text', () => {
    const small = call('a', 'ok', 1);
    const big = { ...small, response: { ...small.response!, body: 'x'.repeat(10_000) } };
    assert.ok(sampleBytes(big) - sampleBytes(small) >= 9_990);
    assert.ok(sampleBytes(small) > 300);
  });

  describe('in a run', () => {
    let server: Server;
    let base: string;
    before(async () => {
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    it('a run that says nothing about call details keeps every request and response, not 3 per step', async () => {
      const backend = createMemoryBackend();
      const worker = new LoadWorker(backend, { concurrency: 4, id: 'd' });
      await worker.start();
      const workflow: Workflow = { name: 'w', variables: { baseUrl: base }, setup: [], steps: [{ name: 'a', request: { method: 'GET', url: '${baseUrl}/a' } }, { name: 'b', request: { method: 'POST', url: '${baseUrl}/b', body: '{"n":1}' } }] };
      const cfg = await launchRun(backend, { workflow, users: [], vus: 3, rampUpSec: 0, iterations: 10, usersMode: 'per-vu', thinkTimeScale: 0, requestTimeoutMs: 5000, startDelaySec: 0 });
      assert.equal(cfg.capture?.keepAll, true);
      const { stats } = await monitorRun(backend.state, cfg, ['a', 'b'], () => undefined, 200);
      const samples = await backend.state.loadSamples(cfg.runId);
      await worker.stop();
      assert.equal(stats.total.count, 60);
      assert.equal(samples.length, 60, 'all 60 requests, with their responses');
      assert.equal(samples.filter((s) => s.step === 'a').length, 30);
      assert.ok(samples.every((s) => s.response?.body === '{"ok":true}'));
      assert.ok(samples.filter((s) => s.step === 'b').every((s) => s.request.body === '{"n":1}'));
    });

    it('a saved 3-per-step setting from an older version is upgraded when the run starts', async () => {
      const backend = createMemoryBackend();
      const worker = new LoadWorker(backend, { concurrency: 4, id: 'd2' });
      await worker.start();
      const workflow: Workflow = { name: 'w', variables: { baseUrl: base }, setup: [], steps: [{ name: 'a', request: { method: 'GET', url: '${baseUrl}/a' } }] };
      const legacy = { okSamples: 3, errorSamples: 5, bodyKb: 16, maskSecrets: true };
      const cfg = await launchRun(backend, { workflow, users: [], vus: 2, rampUpSec: 0, iterations: 10, usersMode: 'per-vu', thinkTimeScale: 0, requestTimeoutMs: 5000, capture: legacy, startDelaySec: 0 });
      await monitorRun(backend.state, cfg, ['a'], () => undefined, 200);
      assert.equal((await backend.state.loadSamples(cfg.runId)).length, 20);
      await worker.stop();
    });
  });
});
