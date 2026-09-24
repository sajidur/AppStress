import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createMemoryBackend } from '../src/backend/memory.js';
import { buildWorkflow, type BuildOptions } from '../src/builder/builder.js';
import { analyzeFlow } from '../src/builder/flow.js';
import { launchRun, monitorRun } from '../src/distributed/controller.js';
import { LoadWorker } from '../src/distributed/worker.js';
import { VirtualUser, type StepTrace } from '../src/engine/executor.js';
import { formatPath, getPath, getPathAll, isMultiPath, pickOne, tokenizePath } from '../src/engine/jsonpath.js';
import { runExtractor } from '../src/engine/extract.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { workflowSchema } from '../src/server/schemas.js';
import type { RecordedExchange, Recording, Workflow } from '../src/types.js';

const DATA = {
  items: [
    { id: 11, status: 'CLOSED', qty: 0, owner: { name: 'ann' } },
    { id: 12, status: 'OPEN', qty: 3, owner: { name: 'bob' } },
    { id: 13, status: 'OPEN', qty: 7, owner: { name: 'cyd' } },
    { id: 14, status: 'HOLD', qty: 1, owner: { name: 'dee' } },
  ],
};

describe('JSON path: choosing values from lists', () => {
  it('reads exact positions exactly as before', () => {
    assert.equal(getPath(DATA, '$.items[1].id'), 12);
    assert.equal(getPath(DATA, '$.items[9].id'), undefined);
    assert.equal(isMultiPath('$.items[1].id'), false);
  });

  it('matches every item with [*]', () => {
    assert.deepEqual(getPathAll(DATA, '$.items[*].id'), [11, 12, 13, 14]);
    assert.equal(isMultiPath('$.items[*].id'), true);
  });

  it('filters by a condition', () => {
    assert.deepEqual(getPathAll(DATA, "$.items[?(@.status=='OPEN')].id"), [12, 13]);
    assert.deepEqual(getPathAll(DATA, '$.items[?(@.qty>1)].id'), [12, 13]);
    assert.deepEqual(getPathAll(DATA, "$.items[?(@.status!='CLOSED' && @.qty>=3)].id"), [12, 13]);
    assert.deepEqual(getPathAll(DATA, "$.items[?(@.owner.name=='cyd')].id"), [13]);
    assert.deepEqual(getPathAll(DATA, '$.items[?(@.status=~/^(OPEN|HOLD)$/)].id'), [12, 13, 14]);
    assert.deepEqual(getPathAll(DATA, '$.items[?(@.qty)].id'), [12, 13, 14], 'a bare field means "is set"');
    assert.deepEqual(getPathAll(DATA, "$.items[?(@.status=='GONE')].id"), []);
  });

  it('handles parentheses and && inside quoted text', () => {
    const d = { rows: [{ name: 'a (x) && b', id: 1 }, { name: 'other', id: 2 }] };
    assert.deepEqual(getPathAll(d, "$.rows[?(@.name=='a (x) && b')].id"), [1]);
  });

  it('round-trips paths and rejects bad conditions', () => {
    const p = "$.items[?(@.status=='OPEN')].id";
    assert.equal(formatPath(tokenizePath(p)), p);
    assert.equal(formatPath(tokenizePath('$.a[*].b')), '$.a[*].b');
    assert.throws(() => getPathAll(DATA, '$.items[?(@.status==OPEN)].id'), /quote text/);
    assert.throws(() => tokenizePath('$.items[?(@.a==1].id'), /unterminated/);
  });

  it('picks the first, last or a random match', () => {
    assert.equal(pickOne([1, 2, 3]), 1);
    assert.equal(pickOne([1, 2, 3], 'last'), 3);
    assert.equal(pickOne([1, 2, 3], 'random', () => 0.5), 2);
    assert.equal(pickOne([], 'random'), undefined);
    const seen = new Set<unknown>();
    for (let i = 0; i < 200; i++) seen.add(pickOne([1, 2, 3, 4], 'random'));
    assert.equal(seen.size, 4, 'random eventually reaches every item');
  });

  it('extractors take the selected match and fall back to a default', () => {
    const res = { status: 200, headers: new Headers(), body: JSON.stringify(DATA), setCookies: {} };
    const ex = (path: string, select?: 'first' | 'last' | 'random') => runExtractor({ var: 'v', from: 'body', path, select }, res);
    assert.equal(ex("$.items[?(@.status=='OPEN')].id"), '12');
    assert.equal(ex("$.items[?(@.status=='OPEN')].id", 'last'), '13');
    assert.equal(ex('$.items[*].id', 'last'), '14');
    assert.equal(ex("$.items[?(@.status=='GONE')].id"), undefined);
  });

  it('accepts the new options in the workflow schema', () => {
    const wf = { name: 'x', variables: {}, setup: [], steps: [{ name: 's', request: { method: 'GET', url: 'http://a' }, set: { requestId: '${$uuid}' }, extract: [{ var: 'v', from: 'body', path: '$.items[*].id', select: 'random', default: '0' }] }] };
    assert.equal(workflowSchema.safeParse(wf).success, true);
    assert.equal(workflowSchema.safeParse({ ...wf, steps: [{ ...wf.steps[0], extract: [{ var: 'v', from: 'body', path: '$.a', select: 'middle' }] }] }).success, false);
  });
});

/* ------------------------------------------------------------------ engine: conditional values, defaults, generated variables */

describe('values chosen at run time', () => {
  let server: Server;
  let base: string;
  const seen: { url: string; body: string; id?: string }[] = [];
  before(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      let body = '';
      for await (const c of req) body += c;
      seen.push({ url: req.url ?? '', body, id: req.headers['x-request-id'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/list' ? JSON.stringify(DATA) : '{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const run = async (wf: Workflow): Promise<StepTrace[]> => {
    const traces: StepTrace[] = [];
    seen.length = 0;
    const vu = new VirtualUser({ workflow: wf, user: {}, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => traces.push(t) });
    await vu.runIteration(0);
    return traces;
  };

  it('uses the first item that matches a condition, and a fallback when none does', async () => {
    const traces = await run({
      name: 't',
      variables: { baseUrl: base },
      setup: [],
      steps: [
        {
          name: 'list',
          request: { method: 'GET', url: '${baseUrl}/list' },
          extract: [
            { var: 'openId', from: 'body', path: "$.items[?(@.status=='OPEN')].id" },
            { var: 'lastOpenId', from: 'body', path: "$.items[?(@.status=='OPEN')].id", select: 'last' },
            { var: 'goneId', from: 'body', path: "$.items[?(@.status=='GONE')].id", default: 'none' },
          ],
        },
        { name: 'order', request: { method: 'POST', url: '${baseUrl}/order?first=${openId}&last=${lastOpenId}&gone=${goneId}', body: '{"item":${openId}}' } },
      ],
    });
    assert.ok(traces.every((t) => !t.error), traces.map((t) => t.error).join());
    assert.equal(seen[1].url, '/order?first=12&last=13&gone=none');
    assert.equal(seen[1].body, '{"item":12}');
  });

  it('fails the step, with a clear message, when the condition matches nothing and there is no fallback', async () => {
    const traces = await run({
      name: 't',
      variables: { baseUrl: base },
      setup: [],
      steps: [{ name: 'list', request: { method: 'GET', url: '${baseUrl}/list' }, extract: [{ var: 'x', from: 'body', path: "$.items[?(@.status=='GONE')].id" }] }],
    });
    assert.match(traces[0].error!, /extract "x" failed/);
  });

  it('generates a variable once per step and reuses it in later steps', async () => {
    const traces = await run({
      name: 't',
      variables: { baseUrl: base },
      setup: [],
      steps: [
        { name: 'a', set: { requestId: '${$uuid}' }, request: { method: 'POST', url: '${baseUrl}/a', headers: { 'x-request-id': '${requestId}' }, body: '{"id":"${requestId}"}' } },
        { name: 'b', request: { method: 'POST', url: '${baseUrl}/b', headers: { 'x-request-id': '${requestId}' } } },
      ],
    });
    assert.ok(traces.every((t) => !t.error));
    assert.match(seen[0].id!, /^[0-9a-f-]{36}$/);
    assert.equal(seen[0].body, `{"id":"${seen[0].id}"}`);
    assert.equal(seen[1].id, seen[0].id, 'the same value in both calls');
    assert.equal(traces[0].extracted.requestId, seen[0].id, 'and it is listed as saved by the first step');
  });
});

/* ------------------------------------------------------------------ builder: values the browser made up */

let seq = 0;
function ex(method: string, url: string, o: { body?: string; headers?: Record<string, string>; res?: string; at?: number; type?: string } = {}): RecordedExchange {
  seq++;
  return {
    id: seq,
    startedAt: o.at ?? 1_700_000_000_000 + seq * 1000,
    durationMs: 20,
    pageUrl: 'https://shop.test/',
    resourceType: o.type ?? 'fetch',
    request: { method, url, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, postData: o.body },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: o.res ?? '{}', mimeType: 'application/json' },
  };
}
const OPTS: BuildOptions = { exclude: [], userFields: {}, minThinkMs: 500, maxThinkMs: 10_000, correlate: true };
const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_B = '9b2d3a10-7c55-4d2e-8f4a-1c2b3d4e5f60';

describe('builder: values the browser makes up', () => {
  it('turns client-made request ids into generated values, reusing one id across calls', () => {
    seq = 0;
    const rec: Recording = {
      version: 1, startUrl: 'https://shop.test/', recordedAt: '', navigations: [],
      exchanges: [
        ex('POST', 'https://shop.test/api/cart', { headers: { 'x-request-id': UUID_A }, body: `{"clientId":"${UUID_B}","qty":1}` }),
        ex('POST', 'https://shop.test/api/pay', { headers: { 'x-request-id': UUID_A }, body: `{"cart":"${UUID_B}"}` }),
      ],
    };
    const { workflow, report } = buildWorkflow(rec, OPTS);
    const [cart, pay] = [...workflow.setup, ...workflow.steps];
    assert.deepEqual(cart.set, { xRequestId: '${$uuid}', clientId: '${$uuid}' });
    assert.equal(cart.request.headers?.['x-request-id'], '${xRequestId}');
    assert.equal(cart.request.body, '{"clientId":"${clientId}","qty":1}');
    assert.equal(pay.request.headers?.['x-request-id'], '${xRequestId}', 'the same id in the second call');
    assert.equal(pay.request.body, '{"cart":"${clientId}"}');
    assert.equal(pay.set, undefined);
    assert.deepEqual(report.generated!.map((g) => [g.kind, g.where]), [['uuid', 'header "x-request-id"'], ['uuid', 'field "clientId"']]);
  });

  it('leaves ids that a server response provided, and ids in URL paths, alone', () => {
    seq = 0;
    const rec: Recording = {
      version: 1, startUrl: 'https://shop.test/', recordedAt: '', navigations: [],
      exchanges: [
        ex('GET', `https://shop.test/api/items/${UUID_A}`),
        ex('POST', 'https://shop.test/api/x', { headers: { 'x-request-id': UUID_B }, res: '{}' }),
      ],
    };
    // UUID_B was in an earlier response: it comes from the server
    rec.exchanges[0].response!.body = `{"token":"${UUID_B}"}`;
    const { workflow } = buildWorkflow(rec, { ...OPTS, correlate: false });
    const [get, post] = [...workflow.setup, ...workflow.steps];
    assert.equal(get.request.url, `\${baseUrl}/api/items/${UUID_A}`, 'resource ids in a path are not invented');
    assert.equal(post.request.headers?.['x-request-id'], UUID_B);
    assert.equal(post.set, undefined);
  });

  it('replaces the current time (ms, seconds, ISO) but not unrelated numbers', () => {
    seq = 0;
    const t = 1_700_000_000_000 + 1000;
    const rec: Recording = {
      version: 1, startUrl: 'https://shop.test/', recordedAt: '', navigations: [],
      exchanges: [
        ex('GET', `https://shop.test/api/list?_=${t}&since=${Math.floor(t / 1000)}`, { at: t }),
        ex('POST', 'https://shop.test/api/log', { at: t + 5000, body: `{"at":"${new Date(t + 5000).toISOString()}","orderNo":1234567890123,"sec":${Math.floor(t / 1000)}}` }),
      ],
    };
    const { workflow, report } = buildWorkflow(rec, OPTS);
    const [list, log] = [...workflow.setup, ...workflow.steps];
    assert.equal(list.request.url, '${baseUrl}/api/list?_=${$timestamp}&since=${$timestampSec}');
    assert.equal(log.request.body, '{"at":"${$isoDate}","orderNo":1234567890123,"sec":${$timestampSec}}', 'an order number far from the request time stays');
    assert.deepEqual(report.generated!.map((g) => g.kind), ['timestamp', 'timestamp-seconds', 'timestamp-seconds', 'iso-date']);
  });
});

/* ------------------------------------------------------------------ flow analysis */

const step = (name: string, o: Partial<Workflow['steps'][number]> & { url?: string; body?: string; headers?: Record<string, string> } = {}) => ({
  name,
  ...(o.extract ? { extract: o.extract } : {}),
  ...(o.set ? { set: o.set } : {}),
  ...(o.skipAuth ? { skipAuth: true } : {}),
  request: { method: o.body ? 'POST' : 'GET', url: o.url ?? '${baseUrl}/x', ...(o.headers ? { headers: o.headers } : {}), ...(o.body ? { body: o.body } : {}) },
});

describe('data-flow analysis', () => {
  const wf = (): Workflow => ({
    name: 't',
    variables: { baseUrl: 'http://x' },
    auth: { type: 'bearer', token: '${token}' },
    setup: [
      step('login', { url: '${baseUrl}/login', body: '{"u":"${user.name}","p":"${user.pass}"}', skipAuth: true, extract: [{ var: 'token', from: 'body', path: '$.token' }, { var: 'userId', from: 'body', path: '$.user.id' }] }),
    ],
    steps: [
      step('list', { url: '${baseUrl}/items?owner=${userId}', extract: [{ var: 'itemId', from: 'body', path: '$.items[1].id' }, { var: 'spare', from: 'header', name: 'etag' }] }),
      step('order', { url: '${baseUrl}/orders/${itemId}', body: '{"item":${itemId},"key":"${$uuid}","note":"hi"}', headers: { 'x-trace': '${traceId}' }, set: { traceId: '${$uuid}' } }),
    ],
  });

  it('shows where every value comes from', () => {
    const f = analyzeFlow(wf(), { userColumns: ['name', 'pass'] });
    const [login, list, order] = f.steps;
    assert.deepEqual(login.inputs.map((i) => [i.where, i.origin, i.variable]), [['body "u"', 'user', 'user.name'], ['body "p"', 'user', 'user.pass']]);
    assert.deepEqual(list.inputs.map((i) => [i.where, i.origin, i.variable, i.from]), [['query "owner"', 'step', 'userId', 'login'], ['authentication token', 'step', 'token', 'login']]);
    assert.deepEqual(order.inputs.map((i) => [i.where, i.origin, i.variable]), [
      ['URL path', 'step', 'itemId'], ['header "x-trace"', 'generated', 'traceId'], ['body "item"', 'step', 'itemId'], ['body "key"', 'generated', '$uuid'], ['authentication token', 'step', 'token'],
    ]);
    assert.equal(order.inputs.find((i) => i.variable === 'itemId')!.how, '$.items[1].id');
    assert.deepEqual(order.generates, [{ variable: 'traceId', how: '${$uuid}' }]);
    assert.deepEqual(login.outputs.map((o) => [o.variable, o.usedBy]), [['token', ['list', 'order']], ['userId', ['list']]]);
    assert.equal(f.links, 5, 'token x2, userId x1, itemId x2');
  });

  it('does not add the authentication to steps that skip it', () => {
    const f = analyzeFlow(wf());
    assert.ok(!f.steps[0].inputs.some((i) => i.where.startsWith('authentication')));
  });

  it('flags values nobody produces, values used too early, saved-but-unused values and fixed list positions', () => {
    const w = wf();
    w.steps[1].request.url = '${baseUrl}/orders/${itemId}?x=${missing}&y=${later}';
    w.steps.push(step('end', { extract: [{ var: 'later', from: 'body', path: '$.a' }] }));
    const issues = analyzeFlow(w).issues;
    const kinds = (k: string) => issues.filter((i) => i.kind === k).map((i) => i.variable ?? i.step);
    assert.deepEqual(kinds('unresolved'), ['missing']);
    assert.deepEqual(kinds('too-early'), ['later']);
    assert.deepEqual(kinds('unused'), ['spare'], 'a value that is used, even too early, is not unused');
    assert.deepEqual(kinds('fixed-position'), ['itemId']);
    assert.ok(issues.find((i) => i.kind === 'fixed-position')!.hint!.includes('random'));
  });

  it('stops warning about a fixed position once it is dynamic', () => {
    const w = wf();
    w.steps[0].extract![0].path = "$.items[?(@.status=='OPEN')].id";
    w.steps[0].extract![0].select = 'random';
    const f = analyzeFlow(w);
    assert.ok(!f.issues.some((i) => i.kind === 'fixed-position'));
    assert.equal(f.steps[1].outputs[0].how, "$.items[?(@.status=='OPEN')].id (random)");
  });

  it('reports users-file columns that do not exist', () => {
    const f = analyzeFlow(wf(), { userColumns: ['name'] });
    assert.deepEqual(f.issues.filter((i) => i.kind === 'unresolved').map((i) => i.variable), ['user.pass']);
  });

  it('flags recorded tokens and ids that were left fixed', () => {
    const w = wf();
    w.steps[0].request.url = `\${baseUrl}/items/${UUID_A}?sig=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk`;
    w.steps[0].request.headers = { 'x-session': 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4', accept: 'application/json' };
    const fixed = analyzeFlow(w).steps[1].fixedDynamic;
    assert.deepEqual(fixed.map((f) => [f.where, f.kind]).sort(), [['URL path', 'id'], ['header "x-session"', 'id'], ['query string', 'token']].sort());
    assert.ok(analyzeFlow(wf()).steps.every((s) => s.fixedDynamic.length === 0), 'placeholders and plain words are not flagged');
  });
});

describe('builder: typed inputs and the build report', () => {
  it('follows typed values to the requests that carry them, and notices values that never appear', () => {
    seq = 0;
    const rec: Recording = {
      version: 1, startUrl: 'https://shop.test/', recordedAt: '', navigations: [],
      typedInputs: [
        { at: 1, field: 'UserId', label: 'Employee ID', type: 'text', value: 'alice01', page: 'https://shop.test/' },
        { at: 2, field: 'Password', label: 'Password', type: 'password', value: 'hunter2!', page: 'https://shop.test/' },
        { at: 3, field: 'q', label: 'Search', type: 'text', value: 'red shoes', page: 'https://shop.test/' },
      ],
      exchanges: [
        ex('POST', 'https://shop.test/login', { body: '{"user":"alice01","password":"9f8e7d6c5b4a-encrypted"}', res: '{"token":"tok-0123456789abcdef"}' }),
        ex('GET', 'https://shop.test/search?q=red%20shoes', { headers: { authorization: 'Bearer tok-0123456789abcdef' } }),
      ],
    };
    const { report } = buildWorkflow(rec, { ...OPTS, userFields: { UserId: 'alice01' } });
    assert.deepEqual(report.typed!.map((t) => [t.field, t.value, t.column, t.sentIn]), [
      ['UserId', 'alice01', 'UserId', ['POST /login']],
      ['Password', '••••••', undefined, []],
      ['q', 'red shoes', undefined, ['GET /search']],
    ]);
    const enc = report.flow!.issues.filter((i) => i.kind === 'encrypted');
    assert.equal(enc.length, 1);
    assert.match(enc[0].message, /"Password".*not even Base64/);
    assert.ok(report.flow!.steps.length === 2 && report.flow!.links >= 1);
  });
});

/* ------------------------------------------------------------------ the goal: every uploaded user runs the same flow, in parallel */

describe('many users, one flow', () => {
  let server: Server;
  let base: string;
  const wrong: string[] = [];
  const orders: { user: string; item: number }[] = [];

  before(async () => {
    // Each user has their own items and their own token; the server checks every request belongs to the caller.
    const items = (user: string) => [1, 2, 3].map((n) => ({ id: user.charCodeAt(0) * 100 + n, status: n === 2 ? 'OPEN' : 'CLOSED', owner: user }));
    server = createServer(async (req: IncomingMessage, res) => {
      let body = '';
      for await (const c of req) body += c;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/login') {
        const { user } = JSON.parse(body);
        return void res.end(JSON.stringify({ token: `tok-${user}-x9y8z7w6`, profile: { name: user } }));
      }
      const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
      const user = /^tok-(\w+)-/.exec(token)?.[1];
      if (!user) return void res.writeHead(401).end('{}');
      if (req.url === '/my/items') return void res.end(JSON.stringify({ items: items(user) }));
      if (req.url === '/orders') {
        const { item, owner } = JSON.parse(body);
        if (!items(user).some((i) => i.id === item) || owner !== user) wrong.push(`${user} ordered ${item} for ${owner}`);
        orders.push({ user, item });
        return void res.end('{"ok":true}');
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('every user logs in, then uses only their own token and their own data through every step', async () => {
    const backend = createMemoryBackend();
    const worker = new LoadWorker(backend, { concurrency: 20, id: 'test' });
    await worker.start();
    const workflow: Workflow = {
      name: 'pipeline',
      variables: { baseUrl: base },
      auth: { type: 'bearer', token: '${token}' },
      onError: 'abortIteration',
      setup: [
        {
          name: 'login',
          skipAuth: true,
          request: { method: 'POST', url: '${baseUrl}/login', headers: { 'content-type': 'application/json' }, body: '{"user":"${user.name}"}' },
          extract: [{ var: 'token', from: 'body', path: '$.token' }, { var: 'me', from: 'body', path: '$.profile.name' }],
        },
      ],
      steps: [
        // the item to order is chosen by a condition on this user's own list
        { name: 'my items', request: { method: 'GET', url: '${baseUrl}/my/items' }, extract: [{ var: 'openItem', from: 'body', path: "$.items[?(@.status=='OPEN')].id" }] },
        { name: 'order', request: { method: 'POST', url: '${baseUrl}/orders', headers: { 'content-type': 'application/json' }, body: '{"item":${openItem},"owner":"${me}"}' } },
      ],
    };
    const names = ['ann', 'bob', 'cyd', 'dee', 'eve', 'fay', 'gus', 'hal'];
    const cfg = await launchRun(backend, {
      workflow, users: names.map((name) => ({ name })), vus: names.length, rampUpSec: 0, iterations: 3, usersMode: 'unique', thinkTimeScale: 0, requestTimeoutMs: 5000, startDelaySec: 0,
    });
    const { stats } = await monitorRun(backend.state, cfg, ['login', 'my items', 'order'], () => undefined, 200);
    await worker.stop();

    assert.equal(stats.total.errors, 0, JSON.stringify(stats.errors));
    assert.deepEqual(wrong, [], 'no user ever used another user\'s token or data');
    assert.equal(orders.length, names.length * 3, 'every user placed an order in each iteration');
    for (const name of names) {
      const mine = orders.filter((o) => o.user === name);
      assert.equal(mine.length, 3);
      assert.ok(mine.every((o) => o.item === name.charCodeAt(0) * 100 + 2), `${name} ordered the OPEN item of their own list`);
    }
    assert.equal(stats.steps.find((s) => s.name === 'login')!.count, names.length, 'login runs once per user');
  });
});

describe('builder: user values versus values from responses', () => {
  it('keeps a token that contains the user name linked to the login response', () => {
    seq = 0;
    const rec: Recording = {
      version: 1, startUrl: 'https://shop.test/', recordedAt: '', navigations: [],
      exchanges: [
        ex('POST', 'https://shop.test/api/login', { body: '{"user":"alice","password":"secret99"}', res: '{"token":"tok-alice-9f8e7d6c5b4a"}' }),
        ex('GET', 'https://shop.test/api/me', { headers: { authorization: 'Bearer tok-alice-9f8e7d6c5b4a' } }),
        ex('POST', 'https://shop.test/api/note', { headers: { authorization: 'Bearer tok-alice-9f8e7d6c5b4a' }, body: '{"from":"alice","text":"hi alice"}' }),
      ],
    };
    const { workflow } = buildWorkflow(rec, { ...OPTS, userFields: { name: 'alice', pw: 'secret99' } });
    const [login, me, note] = [...workflow.setup, ...workflow.steps];
    assert.equal(login.request.body, '{"user":"${user.name|json}","password":"${user.pw|json}"}');
    assert.equal(me.request.headers?.authorization, 'Bearer ${token}', 'the token is taken from the login response, not rebuilt from the user name');
    assert.equal(note.request.headers?.authorization, 'Bearer ${token}');
    assert.equal(note.request.body, '{"from":"${user.name|json}","text":"hi ${user.name|json}"}', 'ordinary occurrences of the user value are still replaced');
    assert.deepEqual(login.extract, [{ var: 'token', from: 'body', path: '$.token' }]);
  });
});
