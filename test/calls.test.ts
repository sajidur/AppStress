import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createMemoryBackend } from '../src/backend/memory.js';
import { launchRun, monitorRun } from '../src/distributed/controller.js';
import { LoadWorker } from '../src/distributed/worker.js';
import { maskHeaders, maskText, maskVars, mergeSamples } from '../src/engine/sampling.js';
import { VirtualUser, type StepTrace } from '../src/engine/executor.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { renderHtml } from '../src/metrics/report.js';
import { DEFAULT_CAPTURE, type CallSample, type CaptureSettings, type Workflow } from '../src/types.js';

const CAP: CaptureSettings = { okSamples: 2, errorSamples: 3, bodyKb: 16, maskSecrets: true };

describe('masking', () => {
  it('hides credential headers but keeps a recognisable prefix', () => {
    const h = maskHeaders({ Authorization: 'Bearer abcdefghijklmnop', cookie: 'sid=0123456789abc; theme=dark', accept: 'application/json', 'x-api-key': 'k' });
    assert.match(h.Authorization, /^Bearer abcdef…\[masked, 16 chars\]$/);
    assert.equal(h.accept, 'application/json');
    assert.match(h.cookie, /^sid=012345…\[masked, 13 chars\]; theme=••••••$/);
    assert.equal(h['x-api-key'], '••••••');
  });

  it('hides passwords completely and tokens partially in JSON, forms and URLs', () => {
    assert.equal(maskText('{"user":"al","password":"hunter2"}'), '{"user":"al","password":"••••••"}');
    assert.equal(maskText('user=al&password=hunter2&x=1'), 'user=al&password=••••••&x=1');
    assert.match(maskText('{"access_token":"eyJhbGciOiJIUzI1NiJ9"}'), /"access_token":"eyJhbG…\[masked, 20 chars\]"/);
    assert.equal(maskText('https://a.test/x?api_key=abcdefghijk&q=1'), 'https://a.test/x?api_key=abcdef…[masked, 11 chars]&q=1');
    assert.equal(maskText('{"password":"${user.password|json}"}'), '{"password":"${user.password|json}"}', 'templates hold no secret');
    assert.equal(maskText('{"name":"passenger"}'), '{"name":"passenger"}');
  });

  it('masks saved variables by name', () => {
    assert.deepEqual(maskVars({ userId: '42', accessToken: 'abcdefghijkl', password: 'x' }), { userId: '42', accessToken: 'abcdef…[masked, 12 chars]', password: '••••••' });
  });
});

const sample = (step: string, outcome: 'ok' | 'error'): CallSample => ({
  step, outcome, phase: 'iteration', at: 0, vu: 0, iteration: 0, durationMs: 1, request: { method: 'GET', url: 'u', headers: {} }, extracted: {},
});

describe('sample limits', () => {
  it('keeps the first N ok and M failed calls per step', () => {
    const c = new MetricsCollector(CAP);
    c.record('a', 1, 200); // drain() only returns something once a request was recorded
    let kept = 0;
    for (let i = 0; i < 10; i++) {
      for (const failed of [false, true]) {
        if (c.want('a', failed)) {
          c.add(sample('a', failed ? 'error' : 'ok'));
          kept++;
        }
      }
    }
    assert.equal(kept, 5);
    assert.equal(c.want('b', false), true, 'limits are per step');
    assert.equal(c.want('__iteration__', false), false);
    assert.equal(c.drain()!.samples.length, 5);
    assert.equal(new MetricsCollector().want('a', true), false, 'capture is off by default');
  });

  it('merges workers without exceeding the limits', () => {
    const into: CallSample[] = [];
    mergeSamples(into, [sample('a', 'ok'), sample('a', 'ok'), sample('a', 'ok'), sample('a', 'error')], CAP);
    mergeSamples(into, [sample('a', 'ok'), sample('a', 'error'), sample('b', 'ok')], CAP);
    assert.deepEqual(into.map((s) => `${s.step}:${s.outcome}`), ['a:ok', 'a:ok', 'a:error', 'a:error', 'b:ok']);
  });
});

describe('call details of a real request', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/login') res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abcdef0123456789; Path=/', 'x-request-id': 'r-1' }).end('{"access_token":"tok-0123456789abcdef","user":{"id":7}}');
        else if (req.url === '/old') res.writeHead(302, { location: '/new' }).end();
        else if (req.url === '/new') res.writeHead(200, { 'content-type': 'text/plain' }).end('moved');
        else res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const run = async (wf: Workflow, capture: CaptureSettings): Promise<StepTrace[]> => {
    const collector = new MetricsCollector(capture);
    const traces: StepTrace[] = [];
    const vu = new VirtualUser({ workflow: wf, user: { name: 'al', password: 'hunter2' }, vuIndex: 3, metrics: collector, sampler: collector, requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => traces.push(t) });
    await vu.runSetup();
    await vu.runIteration(4);
    return traces;
  };

  const wf = (): Workflow => ({
    name: 't',
    variables: { baseUrl: base },
    auth: { type: 'bearer', token: '${accessToken}' },
    setup: [
      {
        name: 'login',
        request: { method: 'POST', url: '${baseUrl}/login', headers: { 'content-type': 'application/json' }, body: '{"user":"${user.name}","password":"${user.password}"}' },
        extract: [{ var: 'accessToken', from: 'body', path: '$.access_token' }, { var: 'userId', from: 'body', path: '$.user.id' }],
      },
    ],
    steps: [
      { name: 'redirect', request: { method: 'GET', url: '${baseUrl}/old' } },
      { name: 'broken', request: { method: 'GET', url: '${baseUrl}/boom?x=${missing}' } },
    ],
  });

  it('records what was sent and received, masks secrets, and follows redirects', async () => {
    const traces = await run(wf(), CAP);
    const login = traces[0].call!;
    assert.equal(login.outcome, 'ok');
    assert.equal(login.phase, 'setup');
    assert.equal(login.vu, 3);
    assert.equal(login.request.method, 'POST');
    assert.equal(login.request.url, `${base}/login`);
    assert.equal(login.request.headers['content-type'], 'application/json');
    assert.equal(login.request.body, '{"user":"al","password":"••••••"}');
    assert.equal(login.response?.status, 200);
    assert.match(login.response!.headers['set-cookie'], /^sid=abcdef…\[masked, 16 chars\]; Path=\/$/);
    assert.equal(login.response!.headers['x-request-id'], 'r-1');
    assert.match(login.response!.body!, /"access_token":"tok-01…\[masked, 20 chars\]"/);
    assert.equal(login.extracted.userId, '7');
    assert.match(login.extracted.accessToken, /^tok-01…/);
    assert.equal(login.masked, true);

    const redirect = traces[1].call!;
    assert.equal(redirect.phase, 'iteration');
    assert.equal(redirect.iteration, 4);
    assert.deepEqual(redirect.redirects, [{ status: 302, url: `${base}/new` }]);
    assert.equal(redirect.response?.body, 'moved');
    assert.equal(redirect.auth, 'applied');
    assert.match(redirect.request.headers.authorization, /^Bearer tok-01…\[masked/);
    assert.match(redirect.request.headers.cookie, /^sid=abcdef…/, 'the cookie the session sent is shown');
  });

  it('shows real values when masking is off', async () => {
    const [login, redirect] = (await run(wf(), { ...CAP, maskSecrets: false })).map((t) => t.call!);
    assert.equal(login.request.body, '{"user":"al","password":"hunter2"}');
    assert.equal(redirect.request.headers.authorization, 'Bearer tok-0123456789abcdef');
    assert.equal(login.masked, undefined);
  });

  it('keeps a failed call whose template could not be filled, so the missing value is visible', async () => {
    const traces = await run(wf(), CAP);
    const broken = traces[2].call!;
    assert.equal(broken.outcome, 'error');
    assert.match(broken.error!, /unresolved variable \$\{missing\}/);
    assert.equal(broken.request.url, '${baseUrl}/boom?x=${missing}');
    assert.equal(broken.response, undefined);
  });

  it('cuts long bodies and keeps nothing when capture is off', async () => {
    const [login] = (await run(wf(), { ...CAP, bodyKb: 1 })).map((t) => t.call!);
    assert.equal(login.response?.bodyTruncated, undefined, 'short bodies are not cut');
    const off = await run(wf(), { ...CAP, okSamples: 0, errorSamples: 0 });
    assert.ok(off.every((t) => t.call === undefined));
  });
});

describe('call details in a load run and its report', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url === '/fail') res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"down"}');
        else res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[1,2,3]}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('keeps only the configured number of calls per step and renders them in the HTML report', async () => {
    const backend = createMemoryBackend();
    const worker = new LoadWorker(backend, { concurrency: 5, id: 'test' });
    await worker.start();
    const workflow: Workflow = {
      name: 'details',
      variables: { baseUrl: base },
      setup: [],
      onError: 'continue',
      steps: [
        { name: 'list', request: { method: 'GET', url: '${baseUrl}/items?page=1', headers: { 'x-trace': 'abc' } } },
        { name: 'fail', request: { method: 'POST', url: '${baseUrl}/fail', body: '{"a":1}' } },
      ],
    };
    const capture: CaptureSettings = { okSamples: 2, errorSamples: 3, bodyKb: 16, maskSecrets: true, keepAll: false };
    const cfg = await launchRun(backend, { workflow, users: [], vus: 3, rampUpSec: 0, iterations: 6, usersMode: 'per-vu', thinkTimeScale: 0, requestTimeoutMs: 5000, capture, startDelaySec: 0 });
    const { stats } = await monitorRun(backend.state, cfg, ['list', 'fail'], () => undefined, 200);
    const samples = await backend.state.loadSamples(cfg.runId);
    await worker.stop();

    assert.ok(stats.total.count >= 36, 'every call is still counted');
    const of = (step: string, o: string) => samples.filter((s) => s.step === step && s.outcome === o).length;
    assert.equal(of('list', 'ok'), 2);
    assert.equal(of('fail', 'error'), 3);
    assert.equal(of('list', 'error'), 0);

    const failed = samples.find((s) => s.step === 'fail')!;
    assert.equal(failed.response?.status, 503);
    assert.equal(failed.request.body, '{"a":1}');
    assert.equal(failed.error, 'unexpected status 503');

    const html = renderHtml(stats, workflow, { samples, capture });
    assert.match(html, /Call details/);
    assert.match(html, /x-trace: abc/);
    assert.match(html, /503/);
    assert.match(html, /&quot;error&quot;: &quot;down&quot;/, 'response body is pretty printed and escaped');
    assert.match(html, /Configured request/);
    assert.match(renderHtml(stats, workflow, { samples: [], capture: { ...DEFAULT_CAPTURE, keepAll: false, okSamples: 0, errorSamples: 0 } }), /call capture was switched off/);
  });
});
