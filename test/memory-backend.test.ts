import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createMemoryBackend, MemoryQueue } from '../src/backend/memory.js';
import type { JobDelivery } from '../src/backend/types.js';
import { launchRun, monitorRun } from '../src/distributed/controller.js';
import { LoadWorker } from '../src/distributed/worker.js';
import type { Workflow } from '../src/types.js';

describe('MemoryQueue', () => {
  it('respects prefetch and redelivers requeued jobs', async () => {
    const q = new MemoryQueue();
    const got: JobDelivery[] = [];
    await q.consume(2, (d) => got.push(d));
    await q.publish([1, 2, 3].map((i) => ({ runId: 'r', vuIndex: i, startDelayMs: 0 })));
    assert.deepEqual(got.map((d) => d.job.vuIndex), [1, 2]); // prefetch 2
    assert.deepEqual(await q.info(), { messages: 1, consumers: 1 });
    got[0].requeue();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got.map((d) => d.job.vuIndex), [1, 2, 1]); // requeued job comes back first
    got[1].ack();
    got[2].ack();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got.map((d) => d.job.vuIndex), [1, 2, 1, 3]);
  });
});

describe('in-memory load run (no Redis/RabbitMQ)', () => {
  let server: Server;
  let base: string;
  const logins = new Map<string, number>();

  before(async () => {
    // Minimal HTTP fixture: login returns a per-user token, /items requires it.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/login') {
          const { user } = JSON.parse(body || '{}');
          logins.set(user, (logins.get(user) ?? 0) + 1);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: `tok-${user}-0123456789` }));
        } else if (req.url === '/items' && req.headers.authorization?.startsWith('Bearer tok-')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[1,2,3]}');
        } else res.writeHead(401).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('runs every VU as its own user and aggregates metrics', async () => {
    const backend = createMemoryBackend();
    const worker = new LoadWorker(backend, { concurrency: 10, id: 'test' });
    await worker.start();
    const workflow: Workflow = {
      name: 'fixture',
      variables: { baseUrl: base },
      setup: [
        {
          name: 'login',
          request: { method: 'POST', url: '${baseUrl}/login', headers: { 'content-type': 'application/json' }, body: '{"user":"${user.name}"}' },
          extract: [{ var: 'token', from: 'body', path: '$.token' }],
        },
      ],
      steps: [{ name: 'items', request: { method: 'GET', url: '${baseUrl}/items', headers: { authorization: 'Bearer ${token}' } }, expect: { bodyContains: 'items' } }],
    };
    const cfg = await launchRun(backend, {
      workflow,
      users: [{ name: 'ann' }, { name: 'bob' }, { name: 'cy' }],
      vus: 3,
      rampUpSec: 0,
      iterations: 4,
      usersMode: 'unique',
      thinkTimeScale: 0,
      requestTimeoutMs: 5000,
      startDelaySec: 0,
    });
    const { stats, outcome } = await monitorRun(backend.state, cfg, ['login', 'items'], () => undefined, 200);
    await worker.stop();
    await backend.close();

    assert.equal(outcome, 'completed');
    assert.deepEqual([...logins.entries()].sort(), [['ann', 1], ['bob', 1], ['cy', 1]]); // one login per VU, each a different user
    assert.deepEqual(stats.steps.map((s) => [s.name, s.count, s.errors]), [['login', 3, 0], ['items', 12, 0]]);
    assert.equal(stats.total.count, 15);
    assert.equal(stats.iteration?.count, 12);
    assert.deepEqual(stats.vus, { started: 3, active: 0, done: 3 });
    assert.ok(stats.total.p95 > 0 && stats.total.p95 < 1000);
  });
});
