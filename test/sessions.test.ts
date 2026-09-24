import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createMemoryBackend } from '../src/backend/memory.js';
import { buildWorkflow } from '../src/builder/builder.js';
import { analyzeFlow } from '../src/builder/flow.js';
import { launchRun, monitorRun } from '../src/distributed/controller.js';
import { LoadWorker } from '../src/distributed/worker.js';
import { VirtualUser, type StepTrace } from '../src/engine/executor.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { workflowSchema } from '../src/server/schemas.js';
import { validateWorkflow } from '../src/server/services/helpers.js';
import type { RecordedExchange, Recording, UsersMode, Workflow } from '../src/types.js';

/**
 * A server that keeps the login in a cookie like ASP.NET forms authentication: while a valid auth cookie is sent,
 * a login request is answered with the user who is ALREADY signed in, whatever credentials it carries.
 */
let server: Server;
let base: string;
const sessions = new Map<string, string>(); // cookie value -> user
const events: string[] = [];
const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

before(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const c of req) body += c;
    const cookie = /\.AUTH=([0-9a-f]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    const current = cookie ? sessions.get(cookie) : undefined;
    const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(o));
    };
    if (req.url === '/login') {
      const { userName, password } = JSON.parse(body);
      const user = fromB64(userName);
      if (current) {
        if (current !== user) events.push(`login as ${user} IGNORED: already signed in as ${current}`);
        return void json({ user: current });
      }
      if (fromB64(password) !== `pw-${user}`) return void json({ error: 'bad credentials' }, 401);
      const id = randomBytes(6).toString('hex');
      sessions.set(id, user);
      events.push(`login ${user}`);
      return void json({ user }, 200, { 'set-cookie': `.AUTH=${id}; Path=/; HttpOnly` });
    }
    if (req.url === '/me') return void (current ? json({ user: current }) : json({ error: 'not signed in' }, 401));
    if (req.url === '/logout') {
      if (cookie) sessions.delete(cookie);
      events.push(`logout ${current ?? 'nobody'}`);
      return void json({ ok: true }, 200, { 'set-cookie': '.AUTH=; Path=/; Max-Age=0' });
    }
    if (req.url === '/broken') return void json({ error: 'boom' }, 500);
    json({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  sessions.clear();
  events.length = 0;
});

const wf = (extra: Partial<Workflow> = {}): Workflow => ({
  name: 'forms auth',
  variables: { baseUrl: base },
  setup: [{ name: 'login', request: { method: 'POST', url: '${baseUrl}/login', headers: { 'content-type': 'application/json' }, body: '{"userName":"${user.name|base64}","password":"${user.pw|base64}"}' } }],
  steps: [{ name: 'me', request: { method: 'GET', url: '${baseUrl}/me' }, expect: { bodyContains: '"user"' } }],
  teardown: [{ name: 'logout', request: { method: 'POST', url: '${baseUrl}/logout' } }],
  ...extra,
});

const NAMES = ['alice', 'bob', 'cyd', 'dee'];
const users = NAMES.map((name) => ({ name, pw: `pw-${name}` }));

async function run(workflow: Workflow, o: { vus: number; iterations: number; usersMode?: UsersMode; freshSession?: boolean }) {
  const backend = createMemoryBackend();
  const worker = new LoadWorker(backend, { concurrency: 20, id: 't' });
  await worker.start();
  const cfg = await launchRun(backend, { workflow, users, vus: o.vus, rampUpSec: 0, iterations: o.iterations, usersMode: o.usersMode ?? 'unique', thinkTimeScale: 0, requestTimeoutMs: 5000, freshSession: o.freshSession, startDelaySec: 0 });
  const { stats } = await monitorRun(backend.state, cfg, [], () => undefined, 200);
  await worker.stop();
  return stats;
}

describe('sessions of virtual users', () => {
  it('two users in parallel never share a session: each keeps their own identity in every step', async () => {
    const traces: Record<string, string[]> = {};
    await Promise.all(
      ['alice', 'bob'].map(async (name) => {
        const list: StepTrace[] = [];
        const vu = new VirtualUser({ workflow: wf(), user: { name, pw: `pw-${name}` }, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => list.push(t) });
        await vu.runSetup();
        for (let i = 0; i < 3; i++) await vu.runIteration(i);
        traces[name] = list.filter((t) => t.step === 'me').map((t) => t.responseSnippet ?? '');
      }),
    );
    assert.deepEqual(traces.alice, Array(3).fill('{"user":"alice"}'));
    assert.deepEqual(traces.bob, Array(3).fill('{"user":"bob"}'));
  });

  it('a server that keeps you signed in ignores a second login: the trap of reusing a session for another user', async () => {
    const vu = new VirtualUser({ workflow: wf(), user: { name: 'alice', pw: 'pw-alice' }, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false });
    await vu.runSetup();
    vu.setUser({ name: 'bob', pw: 'pw-bob' }); // switching users clears the cookies...
    await vu.runSetup();
    assert.ok(!events.some((e) => /IGNORED/.test(e)), events.join('; '));
    assert.deepEqual(events.filter((e) => e.startsWith('login')), ['login alice', 'login bob'], '...so the new login is really performed');
  });

  it('logs in once per user and logs out when the user is done', async () => {
    const stats = await run(wf(), { vus: 2, iterations: 3, usersMode: 'per-vu' });
    assert.equal(stats.total.errors, 0, JSON.stringify(stats.errors));
    assert.equal(events.filter((e) => e.startsWith('login')).length, 2, 'one login per user for 3 iterations');
    assert.equal(events.filter((e) => e.startsWith('logout')).length, 2);
    assert.equal(sessions.size, 0, 'no session is left signed in');
    assert.equal(stats.steps.find((s) => s.name === 'logout')?.count, 2, 'logout is counted like any other step');
  });

  it('per-iteration users: every iteration is a different user with a clean session, and each one logs out first', async () => {
    const stats = await run(wf(), { vus: 1, iterations: 4, usersMode: 'per-iteration' });
    assert.equal(stats.total.errors, 0, JSON.stringify(stats.errors));
    assert.deepEqual(events, ['login alice', 'logout alice', 'login bob', 'logout bob', 'login cyd', 'logout cyd', 'login dee', 'logout dee']);
  });

  it('fresh session: the same user logs in again every iteration; nothing is reused from the last session', async () => {
    const stats = await run(wf(), { vus: 1, iterations: 3, usersMode: 'per-vu', freshSession: true });
    assert.equal(stats.total.errors, 0, JSON.stringify(stats.errors));
    assert.deepEqual(events, ['login alice', 'logout alice', 'login alice', 'logout alice', 'login alice', 'logout alice']);
  });

  it('without logout steps a fresh session still works, but the old sessions stay signed in on the server', async () => {
    const stats = await run(wf({ teardown: undefined }), { vus: 1, iterations: 3, usersMode: 'per-vu', freshSession: true });
    assert.equal(stats.total.errors, 0);
    assert.equal(events.filter((e) => e.startsWith('login')).length, 3);
    assert.equal(sessions.size, 3, 'three sessions were opened and never closed');
  });

  it('the end of a timed run still lets users log out, but a stopped run sends nothing more', async () => {
    const make = (over: Partial<ConstructorParameters<typeof VirtualUser>[0]>) => new VirtualUser({ workflow: wf(), user: { name: 'alice', pw: 'pw-alice' }, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, ...over });
    const timeUp = make({ shouldStop: () => true, shouldAbort: () => false });
    assert.equal(await timeUp.runIteration(0), false, 'no new iteration once time is up');
    assert.equal(await timeUp.runTeardown(), true, 'but the logout runs');
    assert.ok(events.includes('logout nobody'));

    events.length = 0;
    const stopped = make({ shouldStop: () => true, shouldAbort: () => true });
    assert.equal(await stopped.runTeardown(), false);
    assert.deepEqual(events, [], 'a stopped run does not send anything');
  });

  it('a failing logout step does not keep the following teardown steps from running', async () => {
    const w = wf({ teardown: [{ name: 'bad', request: { method: 'GET', url: '${baseUrl}/broken' } }, { name: 'logout', request: { method: 'POST', url: '${baseUrl}/logout' } }] });
    const list: StepTrace[] = [];
    const vu = new VirtualUser({ workflow: w, user: { name: 'alice', pw: 'pw-alice' }, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => list.push(t) });
    await vu.runSetup();
    assert.equal(await vu.runTeardown(), false);
    assert.deepEqual(list.map((t) => t.step), ['login', 'bad', 'logout']);
    assert.equal(sessions.size, 0);
  });

  it('Validate shows the logout as the last step of one user\'s session', async () => {
    const r = await validateWorkflow(wf(), { name: 'alice', pw: 'pw-alice' }, { iterations: 2, requestTimeoutMs: 5000 });
    assert.equal(r.passed, true);
    assert.deepEqual(r.traces.map((t) => `${t.phase}: ${t.step}`), ['setup: login', 'iteration 1: me', 'iteration 2: me', 'teardown: logout']);
  });
});

describe('teardown in the workflow', () => {
  it('is accepted by the schema, and step names are unique across all three phases', () => {
    assert.equal(workflowSchema.safeParse(wf()).success, true);
    const dup = workflowSchema.safeParse(wf({ teardown: [{ name: 'me', request: { method: 'POST', url: 'http://x/logout' } }] }));
    assert.equal(dup.success, false);
    assert.equal(dup.error?.issues[0].message, 'Duplicate step name "me"');
  });

  it('shows up last in the data flow', () => {
    const f = analyzeFlow(wf());
    assert.deepEqual(f.steps.map((s) => `${s.phase}:${s.name}`), ['setup:login', 'steps:me', 'teardown:logout']);
  });
});

let seq = 0;
const ex = (method: string, url: string, body?: string, res = '{}'): RecordedExchange => {
  seq++;
  return { id: seq, startedAt: seq * 1000, durationMs: 10, pageUrl: 'https://app.test/', resourceType: 'fetch', request: { method, url, headers: { 'content-type': 'application/json' }, postData: body }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: res, mimeType: 'application/json' } };
};
const OPTS = { exclude: [], userFields: { name: 'alice', pw: 'hunter2!' }, minThinkMs: 500, maxThinkMs: 10_000, correlate: true };
const recording = (...exchanges: RecordedExchange[]): Recording => ({ version: 1, startUrl: 'https://app.test/', recordedAt: '', navigations: [], exchanges });

describe('builder: logout at the end of the recording', () => {
  it('moves a trailing logout into the teardown', () => {
    seq = 0;
    const { workflow, report } = buildWorkflow(
      recording(ex('POST', 'https://app.test/Account/Login', '{"u":"alice","p":"hunter2!"}'), ex('GET', 'https://app.test/api/orders'), ex('POST', 'https://app.test/Account/LogOff')),
      OPTS,
    );
    assert.deepEqual(workflow.teardown?.map((s) => s.name), ['POST /Account/LogOff']);
    assert.ok(![...workflow.setup, ...workflow.steps].some((s) => /LogOff/.test(s.name)));
    assert.deepEqual(report.teardown, ['POST /Account/LogOff']);
  });

  it('handles several trailing sign-out requests, other spellings, and never moves every step', () => {
    seq = 0;
    const many = buildWorkflow(recording(ex('POST', 'https://app.test/login', '{"u":"alice"}'), ex('GET', 'https://app.test/data'), ex('POST', 'https://app.test/api/auth/logout'), ex('GET', 'https://app.test/signout.aspx?x=1')), OPTS).workflow;
    assert.deepEqual(many.teardown?.map((s) => s.name), ['POST /api/auth/logout', 'GET /signout.aspx']);
    seq = 0;
    const only = buildWorkflow(recording(ex('POST', 'https://app.test/logout')), OPTS).workflow;
    assert.equal(only.teardown, undefined);
    assert.equal(only.steps.length, 1, 'a recording that is only a logout keeps it as a step');
    seq = 0;
    const words = buildWorkflow(recording(ex('GET', 'https://app.test/api/items'), ex('GET', 'https://app.test/api/blogout-posts'), ex('GET', 'https://app.test/api/catalog')), OPTS).workflow;
    assert.equal(words.teardown, undefined, 'only real logout paths count');
  });

  it('leaves a logout in the middle of the recording alone', () => {
    seq = 0;
    const { workflow } = buildWorkflow(recording(ex('POST', 'https://app.test/login', '{"u":"alice"}'), ex('POST', 'https://app.test/logout'), ex('POST', 'https://app.test/login', '{"u":"alice"}'), ex('GET', 'https://app.test/data')), OPTS);
    assert.equal(workflow.teardown, undefined);
    assert.ok([...workflow.setup, ...workflow.steps].some((s) => /logout/.test(s.name)));
  });
});
