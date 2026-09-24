import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildWorkflow, type BuildOptions } from '../src/builder/builder.js';
import { encodedForms, replaceEncodedForms } from '../src/builder/encodings.js';
import { analyzeFlow } from '../src/builder/flow.js';
import { runExtractor } from '../src/engine/extract.js';
import { VirtualUser, type StepTrace } from '../src/engine/executor.js';
import { FILTERS, parseFilterChain } from '../src/engine/filter-names.js';
import { applyFilters, render, TemplateError } from '../src/engine/template.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { workflowSchema } from '../src/server/schemas.js';
import type { RecordedExchange, Recording, Workflow } from '../src/types.js';

describe('value filters', () => {
  it('base64 is what C# Convert.FromBase64String + Encoding.UTF8.GetString reads back', () => {
    assert.equal(render('${u|base64}', { u: 'alice' }), 'YWxpY2U=');
    assert.equal(render('${u|base64}', { u: 'José' }), 'Sm9zw6k=', 'non-ASCII text is encoded as UTF-8 first');
    assert.equal(applyFilters('Sm9zw6k=', 'base64decode'), 'José');
  });

  it('covers the other common encodings', () => {
    assert.equal(applyFilters('abc', 'base64utf16'), 'YQBiAGMA', 'Convert.ToBase64String(Encoding.Unicode.GetBytes(x))');
    assert.equal(applyFilters('YQBiAGMA', 'base64utf16decode'), 'abc');
    assert.equal(applyFilters('>>>???', 'base64'), 'Pj4+Pz8/');
    assert.equal(applyFilters('>>>???', 'base64url'), 'Pj4-Pz8_');
    assert.equal(applyFilters('Pj4-Pz8_', 'base64decode'), '>>>???', 'URL-safe input is accepted');
    assert.equal(applyFilters('abc', 'hex'), '616263');
    assert.equal(applyFilters('616263', 'hexdecode'), 'abc');
    assert.equal(applyFilters('a b&c', 'urlencode'), 'a%20b%26c');
    assert.equal(applyFilters('a%20b%26c', 'urldecode'), 'a b&c');
    assert.equal(applyFilters('abc', 'md5'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(applyFilters('abc', 'sha1'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(applyFilters('abc', 'sha256'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(applyFilters('  Ab ', 'trim|upper'), 'AB');
  });

  it('chains filters in order', () => {
    assert.equal(render('?u=${u|base64|urlencode}', { u: 'alice' }), '?u=YWxpY2U%3D');
    assert.equal(render('${t|base64decode|upper}', { t: 'YWxpY2U=' }), 'ALICE');
  });

  it('explains bad input instead of returning garbage', () => {
    assert.throws(() => applyFilters('not base64!', 'base64decode'), TemplateError);
    assert.throws(() => applyFilters('zz', 'hexdecode'), /hex digits/);
    assert.throws(() => applyFilters('x', 'rot13'), /unknown filter/);
  });

  it('lists every filter once, and validates chains', () => {
    assert.equal(new Set(FILTERS.map((f) => f.name)).size, FILTERS.length);
    assert.deepEqual(parseFilterChain('base64 | urlencode'), { filters: ['base64', 'urlencode'], unknown: [] });
    assert.deepEqual(parseFilterChain('base64|nope').unknown, ['nope']);
    for (const f of FILTERS.filter((x) => x.kind !== 'decode')) assert.doesNotThrow(() => applyFilters('sample', f.name), f.name);
  });
});

describe('recognising encoded values', () => {
  it('produces the forms a page might send', () => {
    const forms = Object.fromEntries(encodedForms('alice').map((f) => [f.filters, f.text]));
    assert.equal(forms.base64, 'YWxpY2U=');
    assert.equal(forms.base64url, 'YWxpY2U');
    assert.equal(forms.hex, '616c696365');
    assert.equal(forms.sha256, applyFilters('alice', 'sha256'));
    assert.equal(forms['sha256|upper'], applyFilters('alice', 'sha256').toUpperCase());
    assert.deepEqual(encodedForms('ab').map((f) => f.filters).filter((f) => !/^(md5|sha)/.test(f)), [], 'two-letter values are only checked as hashes');
  });

  it('replaces an encoded value, also when it is percent-encoded, but not inside a longer token', () => {
    const forms = encodedForms('alice');
    const used = new Set<string>();
    const out = replaceEncodedForms('u=YWxpY2U%3D&v=YWxpY2U=&w=xYWxpY2U=y&z=YWxpY2U=Zm9v', 'name', forms, used);
    assert.equal(out, 'u=${user.name|base64|urlencode}&v=${user.name|base64}&w=xYWxpY2U=y&z=YWxpY2U=Zm9v');
    assert.deepEqual([...used].sort(), ['base64', 'base64|urlencode']);
  });
});

let seq = 0;
function ex(method: string, url: string, o: { body?: string; headers?: Record<string, string>; res?: string; type?: string } = {}): RecordedExchange {
  seq++;
  return {
    id: seq, startedAt: seq * 1000, durationMs: 10, pageUrl: 'https://app.test/', resourceType: o.type ?? 'fetch',
    request: { method, url, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, postData: o.body },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: o.res ?? '{}', mimeType: 'application/json' },
  };
}
const OPTS: BuildOptions = { exclude: [], userFields: { name: 'alice01', pw: 'hunter2!' }, minThinkMs: 500, maxThinkMs: 10_000, correlate: true };
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('builder: values the page sends encoded', () => {
  const rec = (): Recording => {
    seq = 0;
    return {
      version: 1, startUrl: 'https://app.test/', recordedAt: '', navigations: [],
      typedInputs: [
        { at: 1, field: 'UserName', label: 'User name', type: 'text', value: 'alice01', page: 'p' },
        { at: 2, field: 'Password', label: 'Password', type: 'password', value: 'hunter2!', page: 'p' },
      ],
      exchanges: [
        ex('POST', 'https://app.test/api/login', { body: JSON.stringify({ userName: b64('alice01'), password: b64('hunter2!'), remember: true }), res: '{"token":"tok-0123456789abcdef"}' }),
        ex('GET', `https://app.test/api/profile?u=${encodeURIComponent(b64('alice01'))}`, { headers: { authorization: 'Bearer tok-0123456789abcdef' } }),
        ex('POST', 'https://app.test/api/form', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user=${encodeURIComponent(b64('alice01'))}&plain=alice01&h=${applyFilters('hunter2!', 'sha256')}` }),
      ],
    };
  };

  it('generates each user\'s own encoded value in the body, the query string and a form', () => {
    const { workflow, report } = buildWorkflow(rec(), OPTS);
    const [login, profile, form] = [...workflow.setup, ...workflow.steps];
    assert.equal(login.request.body, '{"userName":"${user.name|base64}","password":"${user.pw|base64}","remember":true}');
    assert.equal(profile.request.url, '${baseUrl}/api/profile?u=${user.name|base64|urlencode}');
    assert.equal(form.request.body, 'user=${user.name|base64|urlencode}&plain=${user.name}&h=${user.pw|sha256}');
    assert.equal(profile.request.headers?.authorization, 'Bearer ${token}', 'the token still comes from the login response');
    assert.deepEqual(report.encoded!.map((e) => `${e.step}:${e.field}:${e.filters}`).sort(), [
      'GET /api/profile:name:base64|urlencode', 'POST /api/form:name:base64|urlencode', 'POST /api/form:pw:sha256', 'POST /api/login:name:base64', 'POST /api/login:pw:base64',
    ]);
  });

  it('the typed-input report says how each value was sent, and does not call it encrypted', () => {
    const { report } = buildWorkflow(rec(), OPTS);
    const [user, pw] = report.typed!;
    assert.deepEqual(user.sentIn, ['POST /api/login', 'GET /api/profile', 'POST /api/form']);
    assert.equal(user.encoding, undefined, 'the user name is also sent as typed (plain=alice01), so it is not reported as encoded');
    assert.deepEqual(pw.sentIn, ['POST /api/login', 'POST /api/form']);
    assert.deepEqual([...pw.encoding!].sort(), ['base64', 'sha256'], 'the password is only ever sent Base64 encoded or hashed');
    assert.ok(!report.flow!.issues.some((i) => i.kind === 'encrypted'));
    assert.ok(report.flow!.issues.some((i) => i.kind === 'encoded' && /Password.*base64, sha256/.test(i.message)));
  });

  it('shows the transformation in the data flow', () => {
    const { workflow } = buildWorkflow(rec(), OPTS);
    const login = analyzeFlow(workflow).steps.find((s) => s.name === 'POST /api/login')!;
    assert.deepEqual(login.inputs.map((i) => [i.where, i.how]), [['body "userName"', 'users file, column "name" -> base64'], ['body "password"', 'users file, column "pw" -> base64']]);
  });

  it('does not touch short values that could match by chance', () => {
    seq = 0;
    const r: Recording = {
      version: 1, startUrl: 'https://app.test/', recordedAt: '', navigations: [],
      exchanges: [ex('POST', 'https://app.test/api/x', { body: `{"a":"${b64('ab')}","n":"MQ=="}` })],
    };
    const { workflow } = buildWorkflow(r, { ...OPTS, userFields: { code: 'ab', one: '1' } });
    const step = [...workflow.setup, ...workflow.steps][0];
    assert.ok(step.request.body!.includes(b64('ab')) && step.request.body!.includes('MQ=='), step.request.body);
  });
});

describe('saved values can be decoded', () => {
  const res = { status: 200, headers: new Headers(), body: '{"blob":"YWxpY2U=","bad":"@@@"}', setCookies: {} };
  const get = (path: string, transform?: string) => runExtractor({ var: 'v', from: 'body', path, transform }, res);

  it('is applied by the executor, with a clear error when the value cannot be decoded', async () => {
    assert.equal(get('$.blob'), 'YWxpY2U=', 'the extractor itself does not transform');
    const server: Server = createServer((_req: IncomingMessage, r) => r.writeHead(200, { 'content-type': 'application/json' }).end('{"blob":"YWxpY2U=","bad":"@@@"}'));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const run = async (transform: string, path = '$.blob') => {
        const traces: StepTrace[] = [];
        const wf: Workflow = { name: 't', variables: { baseUrl: base }, setup: [], steps: [{ name: 's', request: { method: 'GET', url: '${baseUrl}/' }, extract: [{ var: 'plain', from: 'body', path, transform }] }] };
        await new VirtualUser({ workflow: wf, user: {}, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => traces.push(t) }).runIteration(0);
        return traces[0];
      };
      assert.equal((await run('base64decode')).extracted.plain, 'alice');
      assert.equal((await run('base64decode|upper')).extracted.plain, 'ALICE');
      assert.match((await run('base64decode', '$.bad')).error!, /extract "plain": base64decode: "@@@" is not valid Base64/);
    } finally {
      server.close();
    }
  });

  it('is checked by the workflow schema', () => {
    const wf = (transform: string) => ({ name: 'x', variables: {}, setup: [], steps: [{ name: 's', request: { method: 'GET', url: 'http://a' }, extract: [{ var: 'v', from: 'body', path: '$.a', transform }] }] });
    assert.equal(workflowSchema.safeParse(wf('base64decode|lower')).success, true);
    const bad = workflowSchema.safeParse(wf('base64decode|rot13'));
    assert.equal(bad.success, false);
    assert.match(JSON.stringify(bad.error?.issues), /Unknown transform/);
  });
});

describe('a server that decodes like C# does', () => {
  let server: Server;
  let base: string;
  const seen: string[] = [];
  before(async () => {
    // Encoding.UTF8.GetString(Convert.FromBase64String(userName)) - and it rejects anything that is not Base64
    server = createServer(async (req: IncomingMessage, res) => {
      let body = '';
      for await (const c of req) body += c;
      const url = new URL(req.url ?? '/', 'http://x');
      const decode = (s: string | null) => (s !== null && /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? Buffer.from(s, 'base64').toString('utf8') : null);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/login') {
        const { userName, password } = JSON.parse(body);
        const user = decode(userName);
        const pw = decode(password);
        if (!user || pw !== `pw-${user}`) return void res.writeHead(400).end('{"error":"invalid encoding or credentials"}');
        seen.push(user);
        return void res.end(JSON.stringify({ session: b64(`sess-${user}`) }));
      }
      const who = decode(url.searchParams.get('u'));
      const session = decode(req.headers['x-session'] as string);
      if (!who || session !== `sess-${who}`) return void res.writeHead(403).end('{"error":"session does not belong to this user"}');
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('every user sends their own Base64 credentials and uses the session the server gave them', async () => {
    const wf: Workflow = {
      name: 't',
      variables: { baseUrl: base },
      setup: [{ name: 'login', request: { method: 'POST', url: '${baseUrl}/login', headers: { 'content-type': 'application/json' }, body: '{"userName":"${user.name|base64}","password":"${user.pw|base64}"}' }, extract: [{ var: 'session', from: 'body', path: '$.session' }] }],
      steps: [{ name: 'profile', request: { method: 'GET', url: '${baseUrl}/profile?u=${user.name|base64|urlencode}', headers: { 'x-session': '${session}' } } }],
    };
    for (const name of ['alice', 'josé', 'bob smith']) {
      const traces: StepTrace[] = [];
      const vu = new VirtualUser({ workflow: wf, user: { name, pw: `pw-${name}` }, vuIndex: 0, metrics: new MetricsCollector(), requestTimeoutMs: 5000, thinkTimeScale: 0, shouldStop: () => false, onTrace: (t) => traces.push(t) });
      assert.equal(await vu.runSetup(), true, `${name}: ${traces.map((t) => t.error).join()}`);
      assert.equal(await vu.runIteration(0), true, `${name}: ${traces.map((t) => t.error).join()}`);
    }
    assert.deepEqual(seen, ['alice', 'josé', 'bob smith']);
  });
});
