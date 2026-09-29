import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createMemoryBackend } from '../src/backend/memory.js';
import { launchRun, monitorRun } from '../src/distributed/controller.js';
import { LoadWorker } from '../src/distributed/worker.js';
import { VirtualUser, type StepTrace } from '../src/engine/executor.js';
import { runExtractor } from '../src/engine/extract.js';
import { getPathAll, pickOne } from '../src/engine/jsonpath.js';
import { itemVars, loopItems, sameLoop } from '../src/engine/loop.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { workflowSchema } from '../src/server/schemas.js';
import type { CaptureSettings, Step, Workflow } from '../src/types.js';

const CUSTOMERS = [
  { id: 11, name: 'Acme', address: { city: 'Oslo', geo: { lat: 1 } }, tags: ['a'] },
  { id: 12, name: 'Bolt', address: { city: 'Rome', geo: { lat: 2 } }, tags: [] },
  { id: 13, name: 'Cyan', address: { city: 'Kyiv', geo: { lat: 3 } }, tags: ['b', 'c'] },
];

describe('picking a different item per virtual user or iteration', () => {
  it('vu: user n takes item n; iteration: the next item each time; sequence: both', () => {
    const list = ['a', 'b', 'c'];
    assert.deepEqual([0, 1, 2, 3, 4].map((vu) => pickOne(list, 'vu', Math.random, { vu, iteration: 9 })), ['a', 'b', 'c', 'a', 'b']);
    assert.deepEqual([0, 1, 2, 3].map((iteration) => pickOne(list, 'iteration', Math.random, { vu: 5, iteration })), ['a', 'b', 'c', 'a']);
    assert.deepEqual([[0, 0], [1, 0], [0, 1], [2, 2]].map(([vu, iteration]) => pickOne(list, 'sequence', Math.random, { vu, iteration })), ['a', 'b', 'b', 'b']);
    assert.equal(pickOne([], 'vu'), undefined);
  });

  it('is applied by the extractor', () => {
    const res = { status: 200, headers: new Headers(), body: JSON.stringify({ customers: CUSTOMERS }), setCookies: {} };
    const at = (select: 'vu' | 'iteration', who: { vu: number; iteration: number }) => runExtractor({ var: 'id', from: 'body', path: '$.customers[*].id', select }, res, who);
    assert.equal(at('vu', { vu: 1, iteration: 0 }), '12');
    assert.equal(at('iteration', { vu: 1, iteration: 2 }), '13');
    assert.equal(at('vu', { vu: 4, iteration: 0 }), '12', 'wraps around when there are more users than items');
  });

  it('saves a whole list when asked to', () => {
    const res = { status: 200, headers: new Headers(), body: JSON.stringify({ customers: CUSTOMERS }), setCookies: {} };
    const list = runExtractor({ var: 'customers', from: 'body', path: '$.customers[*]', list: true }, res)!;
    assert.deepEqual(JSON.parse(list), CUSTOMERS);
    assert.equal(runExtractor({ var: 'x', from: 'body', path: "$.customers[?(@.name=='none')]", list: true }, res), '[]', 'an empty list is still a list');
    assert.deepEqual(getPathAll(JSON.parse(list), '$[?(@.id>11)].name'), ['Bolt', 'Cyan']);
  });
});

describe('the items of a loop', () => {
  it('parses the list, shuffles on request and honours the maximum', () => {
    const raw = JSON.stringify([1, 2, 3, 4, 5]);
    assert.deepEqual(loopItems(raw, { list: 'l', as: 'x' }), [1, 2, 3, 4, 5]);
    assert.deepEqual(loopItems(raw, { list: 'l', as: 'x', max: 2 }), [1, 2]);
    assert.deepEqual(loopItems(raw, { list: 'l', as: 'x', order: 'random' }, () => 0).sort(), [1, 2, 3, 4, 5]);
    assert.notDeepEqual(loopItems(raw, { list: 'l', as: 'x', order: 'random' }, () => 0), [1, 2, 3, 4, 5], 'shuffled');
    assert.deepEqual(loopItems('7', { list: 'l', as: 'x' }), [7], 'a single value is a list of one');
    assert.deepEqual(loopItems('null', { list: 'l', as: 'x' }), []);
    assert.equal(loopItems(Array.from({ length: 2000 }, (_, i) => i).join(',').length ? JSON.stringify(Array.from({ length: 2000 }, (_, i) => i)) : '[]', { list: 'l', as: 'x' }).length, 1000, 'at most 1000 by default');
    assert.match(loopItems(undefined, { list: 'customers', as: 'c' }) as string, /no earlier step saved a list/);
    assert.match(loopItems('not json', { list: 'customers', as: 'c' }) as string, /is not a list/);
  });

  it('defines the item and its fields as variables', () => {
    const v = itemVars('customer', CUSTOMERS[0], 0, 3);
    assert.equal(v['customer.id'], '11');
    assert.equal(v['customer.name'], 'Acme');
    assert.equal(v['customer.address.city'], 'Oslo');
    assert.equal(v['customer.address.geo.lat'], '1', 'three levels deep');
    assert.equal(v['customer.tags'], '["a"]', 'a list inside an item is kept as JSON');
    assert.deepEqual([v['customer.$index'], v['customer.$count']], ['0', '3']);
    assert.equal(JSON.parse(v.customer).name, 'Acme', 'the item itself is its JSON');
    assert.deepEqual(itemVars('id', 42, 1, 2), { id: '42', 'id.$index': '1', 'id.$count': '2' }, 'a plain value is the item');
  });

  it('groups consecutive steps of the same loop', () => {
    assert.equal(sameLoop({ list: 'a', as: 'x' }, { list: 'a', as: 'x', max: 3 }), true);
    assert.equal(sameLoop({ list: 'a', as: 'x' }, { list: 'b', as: 'x' }), false);
    assert.equal(sameLoop(undefined, undefined), false);
  });
});

/* ------------------------------------------------------------------ the engine, against a customers API */

let server: Server;
let base: string;
const seen: string[] = [];
before(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = req.url ?? '';
    seen.push(`${req.method} ${url}${body ? ` ${body}` : ''}`);
    res.setHeader('content-type', 'application/json');
    if (url === '/customers') return void res.end(JSON.stringify({ customers: CUSTOMERS }));
    if (url === '/empty') return void res.end('{"customers":[]}');
    if (url === '/customers/12/orders') return void res.writeHead(500).end('{"error":"boom"}');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => (seen.length = 0));

const listStep = (url = '/customers'): Step => ({ name: 'list', request: { method: 'GET', url: `\${baseUrl}${url}` }, extract: [{ var: 'customers', from: 'body', path: '$.customers[*]', list: true }] });
const each = { list: 'customers', as: 'customer' };
const body = (): Step[] => [
  { name: 'detail', each, request: { method: 'GET', url: '${baseUrl}/customers/${customer.id}' } },
  { name: 'order', each, request: { method: 'POST', url: '${baseUrl}/customers/${customer.id}/orders', headers: { 'content-type': 'application/json' }, body: '{"n":${customer.$index},"who":"${customer.name|json}","city":"${customer.address.city}"}' } },
];
const wf = (steps: Step[], extra: Partial<Workflow> = {}): Workflow => ({ name: 't', variables: { baseUrl: base }, setup: [], steps, ...extra });
async function runOnce(workflow: Workflow): Promise<StepTrace[]> {
  const traces: StepTrace[] = [];
  const vu = new VirtualUser({ workflow, user: {}, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => traces.push(t) });
  await vu.runIteration(0);
  return traces;
}

describe('repeating steps for every customer of a list', () => {
  it('runs the whole loop body for each item, item after item, with the item\'s own values', async () => {
    const traces = await runOnce(wf([listStep(), ...body()], { onError: 'continue' }));
    assert.deepEqual(seen.filter((s) => !s.startsWith('GET /customers ') && s !== 'GET /customers').map((s) => s.split(' {')[0]), [
      'GET /customers/11', 'POST /customers/11/orders', 'GET /customers/12', 'POST /customers/12/orders', 'GET /customers/13', 'POST /customers/13/orders',
    ]);
    assert.ok(seen.includes('POST /customers/11/orders {"n":0,"who":"Acme","city":"Oslo"}'), seen.join('\n'));
    assert.ok(seen.includes('POST /customers/13/orders {"n":2,"who":"Cyan","city":"Kyiv"}'));
    assert.equal(traces.filter((t) => t.step === 'detail').length, 3, 'a step that repeats is counted every time');
  });

  it('records which item each call was made for', async () => {
    const collector = new MetricsCollector({ okSamples: 0, errorSamples: 0, bodyKb: 16, maskSecrets: true, keepAll: true });
    const traces: StepTrace[] = [];
    const vu = new VirtualUser({ workflow: wf([listStep(), ...body()], { onError: 'continue' }), user: {}, userRow: 4, vuIndex: 0, metrics: collector, sampler: collector, requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => traces.push(t) });
    await vu.runIteration(0);
    const details = traces.filter((t) => t.step === 'detail').map((t) => t.call!);
    assert.deepEqual(details.map((c) => c.loop), [{ as: 'customer', index: 0, count: 3 }, { as: 'customer', index: 1, count: 3 }, { as: 'customer', index: 2, count: 3 }]);
    assert.ok(details.every((c) => c.userRow === 4));
    assert.equal(traces.find((t) => t.step === 'list')!.call!.loop, undefined, 'the call that produced the list is not part of the loop');
  });

  it('a failing item stops the iteration by default, and is skipped with "continue"', async () => {
    const stopped = await runOnce(wf([listStep(), ...body()]));
    assert.ok(!seen.some((s) => s.startsWith('GET /customers/13')), 'item 3 was not reached after item 2 failed');
    assert.ok(stopped.some((t) => t.step === 'order' && t.error));
    seen.length = 0;
    await runOnce(wf([listStep(), ...body()], { onError: 'continue' }));
    assert.ok(seen.some((s) => s.startsWith('GET /customers/13')), 'with continue, the next item still runs');
  });

  it('says what is wrong when the list was never saved, and skips an empty list quietly', async () => {
    const missing = await runOnce(wf(body()));
    assert.match(missing[0].error!, /loop over \$\{customers\}: no earlier step saved a list with that name/);
    seen.length = 0;
    const empty = await runOnce(wf([listStep('/empty'), ...body()]));
    assert.ok(empty.every((t) => !t.error));
    assert.deepEqual(seen, ['GET /empty'], 'nothing to repeat: no request is made');
  });

  it('limits the number of items and can shuffle them', async () => {
    await runOnce(wf([listStep(), { name: 'detail', each: { ...each, max: 2 }, request: { method: 'GET', url: '${baseUrl}/customers/${customer.id}' } }]));
    assert.deepEqual(seen.filter((s) => /customers\/\d+$/.test(s)), ['GET /customers/11', 'GET /customers/12']);
  });

  it('steps before and after the loop are not repeated', async () => {
    const steps: Step[] = [listStep(), body()[0], { name: 'after', request: { method: 'GET', url: '${baseUrl}/done' } }];
    await runOnce(wf(steps));
    assert.deepEqual(seen.filter((s) => s === 'GET /done').length, 1);
    assert.equal(seen.filter((s) => /customers\/\d+$/.test(s)).length, 3);
  });
});

describe('every virtual user takes a different customer, in a real run', () => {
  const CAP: CaptureSettings = { okSamples: 0, errorSamples: 0, bodyKb: 16, maskSecrets: true, keepAll: true };
  const run = async (workflow: Workflow, o: { vus: number; iterations: number; usersMode?: 'per-vu' | 'per-iteration' | 'unique'; users?: number }) => {
    const backend = createMemoryBackend();
    const worker = new LoadWorker(backend, { concurrency: 10, id: 'l' });
    await worker.start();
    const users = Array.from({ length: o.users ?? 0 }, (_, i) => ({ name: `user${i + 1}` }));
    const cfg = await launchRun(backend, { workflow, users, vus: o.vus, rampUpSec: 0, iterations: o.iterations, usersMode: o.usersMode ?? 'per-vu', thinkTimeScale: 0, requestTimeoutMs: 5000, capture: CAP, startDelaySec: 0 });
    const { stats } = await monitorRun(backend.state, cfg, [], () => undefined, 200);
    const samples = await backend.state.loadSamples(cfg.runId);
    await worker.stop();
    return { stats, samples };
  };

  it('vu: virtual user n works with customer n; iteration: one user works through the customers', async () => {
    const pick = (select: 'vu' | 'iteration') => wf([{ name: 'list', request: { method: 'GET', url: '${baseUrl}/customers' }, extract: [{ var: 'cid', from: 'body', path: '$.customers[*].id', select }] }, { name: 'detail', request: { method: 'GET', url: '${baseUrl}/customers/${cid}' } }]);
    const byVu = await run(pick('vu'), { vus: 3, iterations: 2 });
    const perVu = new Map<number, Set<string>>();
    for (const s of byVu.samples.filter((c) => c.step === 'detail')) perVu.set(s.vu, (perVu.get(s.vu) ?? new Set()).add(s.request.url.split('/').pop()!));
    assert.deepEqual([...perVu.entries()].sort().map(([vu, ids]) => [vu, [...ids]]), [[0, ['11']], [1, ['12']], [2, ['13']]], 'each virtual user has its own customer, every iteration');

    seen.length = 0;
    const byIteration = await run(pick('iteration'), { vus: 1, iterations: 5 });
    assert.deepEqual(byIteration.samples.filter((c) => c.step === 'detail').sort((a, b) => a.iteration - b.iteration).map((c) => c.request.url.split('/').pop()), ['11', '12', '13', '11', '12']);
  });

  it('shows which row of the users file each call was made as', async () => {
    const w = wf([{ name: 'ping', request: { method: 'GET', url: '${baseUrl}/ping?u=${user.name}' } }]);
    const perVu = await run(w, { vus: 3, iterations: 2, users: 3 });
    const rowsByVu = (calls: typeof perVu.samples) => [...new Set(calls.map((c) => `${c.vu}:${c.userRow}`))].sort();
    assert.deepEqual(rowsByVu(perVu.samples), ['0:1', '1:2', '2:3']);

    const perIteration = await run(w, { vus: 1, iterations: 5, users: 3, usersMode: 'per-iteration' });
    assert.deepEqual(perIteration.samples.sort((a, b) => a.iteration - b.iteration).map((c) => c.userRow), [1, 2, 3, 1, 2], 'the next row every iteration, starting again at the end of the file');
    assert.deepEqual(perIteration.samples.sort((a, b) => a.iteration - b.iteration).map((c) => c.request.url.split('=')[1]), ['user1', 'user2', 'user3', 'user1', 'user2']);
  });
});

describe('the workflow schema', () => {
  const step = (o: Record<string, unknown>) => ({ name: 's', request: { method: 'GET', url: 'http://a/x' }, ...o });
  const check = (s: unknown) => workflowSchema.safeParse({ name: 'w', variables: {}, setup: [], steps: [s] }).success;
  it('accepts loops, lists and per-user picks, and rejects malformed ones', () => {
    assert.equal(check(step({ each: { list: 'customers', as: 'customer', max: 5, order: 'random' } })), true);
    assert.equal(check(step({ extract: [{ var: 'c', from: 'body', path: '$.a[*]', list: true }, { var: 'd', from: 'body', path: '$.a[*].id', select: 'sequence' }] })), true);
    assert.equal(check(step({ each: { list: 'customers', as: 'my.customer' } })), false, 'the item name is a simple name');
    assert.equal(check(step({ each: { list: '1bad', as: 'c' } })), false);
    assert.equal(check(step({ each: { list: 'l', as: 'c', max: 0 } })), false);
    assert.equal(check(step({ extract: [{ var: 'd', from: 'body', path: '$.a', select: 'nope' }] })), false);
  });
});

import { analyzeFlow } from '../src/builder/flow.js';

describe('data flow for loops and fixed logins', () => {
  const flowWf = (steps: Step[]): Workflow => ({ name: 't', variables: { baseUrl: 'http://x' }, setup: [], steps });

  it('shows the list a step repeats over and the fields of each item', () => {
    const f = analyzeFlow(flowWf([listStep(), ...body()]));
    const detail = f.steps.find((s) => s.name === 'detail')!;
    assert.deepEqual(detail.loop, { list: 'customers', as: 'customer' });
    assert.deepEqual(detail.inputs.map((i) => [i.where, i.origin, i.variable, i.from]), [
      ['repeats for each item of', 'step', 'customers', 'list'],
      ['URL path', 'loop', 'customer.id', 'list'],
    ]);
    const order = f.steps.find((s) => s.name === 'order')!;
    assert.deepEqual(order.inputs.filter((i) => i.origin === 'loop').map((i) => i.variable).sort(), ['customer.$index', 'customer.address.city', 'customer.id', 'customer.name']);
    assert.ok(order.inputs.some((i) => i.variable === 'customer.$index' && i.how === 'index of customers'));
    assert.ok(order.inputs.some((i) => i.variable === 'customer.address.city' && i.how === 'field "address.city" of customers'));
    assert.deepEqual(f.steps[0].outputs[0].usedBy.sort(), ['detail', 'order'], 'the list counts as used by the steps that repeat over it');
    assert.equal(f.issues.filter((i) => i.kind === 'unresolved' || i.kind === 'unused').length, 0, JSON.stringify(f.issues));
  });

  it('describes a list and per-user picks in words', () => {
    const f = analyzeFlow(flowWf([{ name: 'a', request: { method: 'GET', url: '${baseUrl}/a' }, extract: [{ var: 'all', from: 'body', path: '$.c[*]', list: true }, { var: 'mine', from: 'body', path: '$.c[*].id', select: 'vu' }, { var: 'next', from: 'body', path: '$.c[*].id', select: 'iteration' }] }, { name: 'b', request: { method: 'GET', url: '${baseUrl}/b/${mine}/${next}' } }]));
    assert.deepEqual(f.steps[0].outputs.map((o) => o.how), ['$.c[*] (all items, as a list)', '$.c[*].id (a different one per virtual user)', '$.c[*].id (the next one every iteration)']);
  });

  it('flags a loop over a list nobody saved', () => {
    const f = analyzeFlow(flowWf(body()));
    assert.ok(f.issues.some((i) => i.kind === 'unresolved' && i.variable === 'customers' && /no step saves a list/.test(i.message)));
  });

  it('warns when a login sends the same recorded credentials for every user', () => {
    const w = flowWf([{ name: 'POST /login', request: { method: 'POST', url: '${baseUrl}/login?tenant=acme', body: '{"userName":"alice","password":"hunter2","remember":"true","note":"hi"}' } }]);
    const withUsers = analyzeFlow(w, { userColumns: ['name', 'pw'] });
    const c = withUsers.issues.filter((i) => i.kind === 'fixed-credentials');
    assert.deepEqual(c.map((i) => [i.field!.where, i.field!.key, i.field!.value]), [['body "userName"', 'userName', 'alice'], ['body "password"', 'password', 'hunter2']]);
    assert.match(c[0].message, /sends the same userName \(alice\) for every virtual user, although a users file is loaded/);
    assert.equal(withUsers.steps[0].fixedCredentials.length, 2);
    assert.match(analyzeFlow(w).issues.find((i) => i.kind === 'fixed-credentials')!.hint!, /Upload a users file/, 'without a users file the hint says to upload one');
  });

  it('does not flag credentials that already come from the users file, or fields that are not logins', () => {
    const w = flowWf([{ name: 'POST /login', request: { method: 'POST', url: '${baseUrl}/login', body: '{"userName":"${user.name|base64}","password":"${user.pw}","city":"Oslo"}' } }]);
    assert.deepEqual(analyzeFlow(w, { userColumns: ['name', 'pw'] }).issues.filter((i) => i.kind === 'fixed-credentials'), []);
  });

  it('finds fixed logins in form bodies and query strings too', () => {
    const w = flowWf([{ name: 'login', request: { method: 'POST', url: '${baseUrl}/login?email=a%40b.io', body: 'username=alice&password=x%21&csrf=1' } }]);
    const c = analyzeFlow(w, { userColumns: ['name'] }).issues.filter((i) => i.kind === 'fixed-credentials').map((i) => i.field!.where).sort();
    assert.deepEqual(c, ['body "password"', 'body "username"', 'query "email"']);
  });
});
