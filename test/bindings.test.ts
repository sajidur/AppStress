import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  availableVars,
  detectAuth,
  detectBodyKind,
  formFields,
  joinForm,
  newParamName,
  joinUrl,
  jsonFields,
  setJsonField,
  splitUrl,
  stripAuthorization,
  suggestVarName,
  unresolvedVars,
  usedStepVars,
} from '../web/src/bindings.js';
import type { Step, Workflow } from '../src/types.js';

const step = (name: string, extra: Partial<Step> = {}, req: Partial<Step['request']> = {}): Step => ({
  name,
  request: { method: 'GET', url: '${baseUrl}/x', ...req },
  ...extra,
});

const wf = (): Workflow => ({
  name: 't',
  variables: { baseUrl: 'http://x' },
  setup: [step('login', { extract: [{ var: 'token', from: 'body', path: '$.token' }] })],
  steps: [
    step('list', { extract: [{ var: 'itemId', from: 'body', path: '$.items[0].id' }] }),
    step('order', {}, { method: 'POST', url: '${baseUrl}/o?item=${itemId}', body: '{"item":${itemId},"note":"hi"}' }),
    step('later', { extract: [{ var: 'orderId', from: 'body', path: '$.id' }] }),
  ],
});

describe('available variables', () => {
  it('offers only what earlier steps produced, plus user columns, workflow variables and built-ins', () => {
    const names = (i: number) => availableVars(wf(), { phase: 'steps', index: i }, ['email']).map((v) => v.name);
    assert.deepEqual(names(0).filter((n) => !n.startsWith('$')), ['token', 'user.email', 'baseUrl']);
    assert.ok(names(1).includes('itemId'));
    assert.ok(!names(1).includes('orderId'), 'a later step output is not available yet');
    assert.ok(names(2).includes('itemId'));
    assert.deepEqual(availableVars(wf(), { phase: 'setup', index: 0 }).filter((v) => v.kind === 'step'), []);
    assert.ok(names(3).includes('orderId'), 'index = length means "after every step"');
  });

  it('reports unresolved placeholders and the variables a step reads', () => {
    const w = wf();
    w.steps[0].request.url = '${baseUrl}/a/${orderId}/${nope}/${user.email}';
    assert.deepEqual(unresolvedVars(w, { phase: 'steps', index: 0 }, ['email']).sort(), ['nope', 'orderId']);
    assert.deepEqual(usedStepVars(w, w.steps[1]), ['itemId']);
  });
});

describe('variable names', () => {
  it('derives readable names from paths and headers', () => {
    assert.equal(suggestVarName('body', '$.user.id'), 'userId');
    assert.equal(suggestVarName('body', '$.items[0].id'), 'itemId');
    assert.equal(suggestVarName('body', '$.data.accessToken'), 'accessToken');
    assert.equal(suggestVarName('header', 'x-csrf-token'), 'xCsrfToken');
  });
});

describe('query parameters and form bodies', () => {
  it('splits and re-joins URLs without touching placeholders', () => {
    const u = '${baseUrl}/o?item=${itemId|urlencode}&flag&q=a%20b#top';
    const { base, params, hash } = splitUrl(u);
    assert.equal(base, '${baseUrl}/o');
    assert.deepEqual(params, [{ key: 'item', value: '${itemId|urlencode}' }, { key: 'flag', value: '', bare: true }, { key: 'q', value: 'a%20b' }]);
    assert.equal(joinUrl(base, params, hash), u);
    assert.equal(joinUrl('http://a/x', []), 'http://a/x');
  });

  it('adds a new parameter with an unused name and keeps it once its value is filled in', () => {
    const { base, params } = splitUrl('http://a/x?param1=1');
    const name = newParamName(params);
    assert.equal(name, 'param2');
    assert.equal(joinUrl(base, [...params, { key: name, value: '' }]), 'http://a/x?param1=1&param2=');
    assert.equal(joinUrl('http://a/x', [{ key: 'param1', value: '' }]), 'http://a/x?param1=');
  });

  it('parses form bodies', () => {
    const f = formFields('a=1&b=${x|urlencode}');
    assert.deepEqual(f, [{ key: 'a', value: '1' }, { key: 'b', value: '${x|urlencode}' }]);
    assert.equal(joinForm(f), 'a=1&b=${x|urlencode}');
  });

  it('detects the body kind', () => {
    assert.equal(detectBodyKind(undefined), 'empty');
    assert.equal(detectBodyKind('{"a":1}'), 'json');
    assert.equal(detectBodyKind('{"a":${id}}'), 'json');
    assert.equal(detectBodyKind('a=1&b=2', { 'Content-Type': 'application/x-www-form-urlencoded' }), 'form');
    assert.equal(detectBodyKind('<xml/>'), 'text');
  });
});

describe('JSON body fields', () => {
  it('lists leaves including bare ${placeholders}', () => {
    const fields = jsonFields('{"item":${itemId},"note":"hi","n":3,"nested":{"ok":true,"list":[{"id":"a"}]}}')!;
    assert.deepEqual(
      fields.map((f) => [f.label, f.value, f.raw]),
      [
        ['item', '${itemId}', true],
        ['note', 'hi', false],
        ['n', '3', true],
        ['nested.ok', 'true', true],
        ['nested.list[0].id', 'a', false],
      ],
    );
    assert.equal(jsonFields('not json'), null);
  });

  it('binds a numeric field to a variable without quoting it, and a string field with quotes', () => {
    const body = '{"productId":102,"quantity":1,"note":"hi"}';
    const a = setJsonField(body, ['productId'], '${productId}');
    assert.equal(a, '{"productId":${productId},"quantity":1,"note":"hi"}');
    const b = setJsonField(a, ['note'], 'for ${user.name|json}');
    assert.equal(b, '{"productId":${productId},"quantity":1,"note":"for ${user.name|json}"}');
    assert.deepEqual(jsonFields(b)!.map((f) => f.value), ['${productId}', '1', 'for ${user.name|json}']);
  });

  it('turns a raw field back into a literal, or into a string when the text is not a literal', () => {
    const body = '{"n":${x},"m":5}';
    assert.equal(setJsonField(body, ['n'], '7'), '{"n":7,"m":5}');
    assert.equal(setJsonField(body, ['m'], 'abc'), '{"n":${x},"m":"abc"}');
  });

  it('keeps pretty-printed bodies pretty and handles nested paths', () => {
    const body = '{\n  "a": {\n    "b": [\n      1\n    ]\n  }\n}';
    const out = setJsonField(body, ['a', 'b', 0], '${v}');
    assert.equal(out, '{\n  "a": {\n    "b": [\n      ${v}\n    ]\n  }\n}');
  });
});

describe('authentication detection', () => {
  const withAuth = (): Workflow => ({
    ...wf(),
    steps: wf().steps.map((s) => ({ ...s, request: { ...s.request, headers: { Authorization: 'Bearer ${token}', accept: '*/*' } } })),
  });

  it('finds a repeated bearer header and can strip it from the steps', () => {
    const w = withAuth();
    const d = detectAuth(w)!;
    assert.deepEqual(d.auth, { type: 'bearer', token: '${token}' });
    assert.equal(d.steps, 3);
    const stripped = stripAuthorization(w, d.headerValue);
    assert.deepEqual(stripped.steps[0].request.headers, { accept: '*/*' });
    assert.equal(stripped.setup[0].request.headers, undefined);
  });

  it('returns null when there is no Authorization header, and reads Basic credentials', () => {
    assert.equal(detectAuth(wf()), null);
    const w = wf();
    w.steps[0].request.headers = { authorization: `Basic ${Buffer.from('al:pw:1').toString('base64')}` };
    assert.deepEqual(detectAuth(w)!.auth, { type: 'basic', username: 'al', password: 'pw:1' });
  });
});

describe('variables a step generates for itself', () => {
  it('are available to its own request and to later steps, and are not reported as missing', () => {
    const w = wf();
    w.steps[0].set = { requestId: '${$uuid}' };
    w.steps[0].request.headers = { 'x-request-id': '${requestId}' };
    w.steps[1].request.headers = { 'x-request-id': '${requestId}' };
    const names = (i: number) => availableVars(w, { phase: 'steps', index: i }).map((v) => v.name);
    assert.ok(names(0).includes('requestId'), 'own request');
    assert.ok(names(1).includes('requestId'), 'later step');
    assert.deepEqual(unresolvedVars(w, { phase: 'steps', index: 0 }), []);
    assert.deepEqual(unresolvedVars(w, { phase: 'steps', index: 1 }), []);
  });
});

import { chainFor } from '../web/src/bindings.js';

describe('choosing how a value is sent', () => {
  it('adds what the place needs after the chosen encoding, unless the encoding is already safe there', () => {
    assert.equal(chainFor(undefined, 'urlencode'), 'urlencode');
    assert.equal(chainFor(undefined), undefined);
    assert.equal(chainFor('base64'), 'base64');
    assert.equal(chainFor('base64', 'urlencode'), 'base64|urlencode', 'Base64 contains + / = which a URL needs escaped');
    assert.equal(chainFor('base64', 'json'), 'base64', 'Base64 is safe inside a JSON string');
    assert.equal(chainFor('base64url', 'urlencode'), 'base64url');
    assert.equal(chainFor('sha256', 'urlencode'), 'sha256');
    assert.equal(chainFor('base64decode', 'json'), 'base64decode|json', 'decoded text can contain anything');
  });
});
