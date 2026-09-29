import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyListPick, describePick, splitListPath } from '../web/src/listpick.js';
import {
  bindLiteral,
  describeUsers,
  fieldSource,
  guessColumn,
  itemName,
  listProducer,
  listVars,
  loopFieldsFromSample,
  withSource,
} from '../web/src/sources.js';
import type { Step, Workflow } from '../src/types.js';

const login: Step = {
  name: 'login',
  request: { method: 'POST', url: 'http://x/login', headers: { 'content-type': 'application/json' }, body: '{"userName":"YWxpY2U=","password":"secret"}' },
};

describe('field sources', () => {
  it('classifies a field', () => {
    assert.equal(fieldSource('abc').kind, 'fixed');
    assert.equal(fieldSource('${user.name}').kind, 'user');
    assert.equal(fieldSource('${token}').kind, 'step');
    assert.equal(fieldSource('${$uuid}').kind, 'generated');
    assert.equal(fieldSource('${customer.id}', 'customer').kind, 'loop');
    assert.equal(fieldSource('id-${a}-${b}').kind, 'mixed');
    assert.equal(fieldSource('${user.name|base64}').filters, 'base64');
  });

  it('keeps the encoding when the source changes', () => {
    const prev = fieldSource('${user.name|base64|json}');
    assert.equal(withSource('token', prev, 'json'), '${token|base64}');
    assert.equal(withSource('token', undefined), '${token}');
  });

  it('binds a fixed login field to a users-file column, keeping Base64', () => {
    const a = bindLiteral(login, 'body "userName"', 'userName', 'user.name')!;
    assert.match(a.request.body!, /"userName":"\$\{user\.name\|base64\}"/);
    assert.match(a.request.body!, /"password":"secret"/);
    const b = bindLiteral(login, 'body "password"', 'password', 'user.password')!;
    assert.match(b.request.body!, /"password":"\$\{user\.password\|json\}"/);
    assert.equal(bindLiteral(login, 'body "nope"', 'nope', 'user.x'), null);
  });

  it('binds query and form fields', () => {
    const q = bindLiteral({ name: 'q', request: { method: 'GET', url: 'http://x/a?u=bob&z=1', headers: {} } }, 'query "u"', 'u', 'user.name')!;
    assert.match(q.request.url, /u=\$\{user\.name(\|urlencode)?\}/);
    const f = bindLiteral({ name: 'f', request: { method: 'POST', url: 'http://x/a', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=bob&p=1' } }, 'body "user"', 'user', 'user.name')!;
    assert.match(f.request.body!, /^user=\$\{user\.name(\|urlencode)?\}&p=1$/);
  });

  it('guesses the column', () => {
    assert.equal(guessColumn('userName', ['id', 'username', 'password']), 'username');
    assert.equal(guessColumn('password', ['username', 'password']), 'password');
    assert.equal(guessColumn('zzz', ['a', 'b']), undefined);
  });
});

describe('lists and loops', () => {
  const wf: Workflow = {
    version: 1,
    setup: [],
    teardown: [],
    steps: [
      { name: 'customers', request: { method: 'GET', url: 'http://x/c', headers: {} }, extract: [{ var: 'customers', from: 'body', path: '$.data[*]', list: true }] },
      { name: 'orders', request: { method: 'GET', url: 'http://x/o/${customer.id}', headers: {} }, each: { list: 'customers', as: 'customer' } },
    ],
  } as Workflow;

  it('finds lists and their producer', () => {
    assert.deepEqual(listVars(wf, { phase: 'steps', index: 1 }).map((l) => l.name), ['customers']);
    assert.equal(listVars(wf, { phase: 'steps', index: 0 }).length, 0);
    assert.equal(listProducer(wf, 'customers')?.step.name, 'customers');
    assert.equal(listProducer(wf, 'nothing'), null);
  });

  it('learns item fields from the recorded response', () => {
    const sample = [{ path: '$.data[0].id' }, { path: '$.data[0].address.city' }, { path: '$.data[0].tags[1]' }, { path: '$.data[1].id' }];
    assert.deepEqual(loopFieldsFromSample('$.data[*]', sample).sort(), ['address.city', 'id', 'tags']);
    assert.deepEqual(loopFieldsFromSample('$.data[*].id', sample), []);
    assert.deepEqual(loopFieldsFromSample(undefined, sample), []);
  });

  it('names one item', () => {
    assert.equal(itemName('customers'), 'customer');
    assert.equal(itemName('companies'), 'company');
    assert.equal(itemName('orderList'), 'order');
    assert.equal(itemName('items'), 'item');
    assert.equal(itemName('status'), 'item');
  });

  it('list pick modes', () => {
    const p = splitListPath('$.data[2].id')!;
    assert.deepEqual(applyListPick(p, { mode: 'vu' }), { path: '$.data[*].id', select: 'vu' });
    assert.deepEqual(applyListPick(p, { mode: 'iteration' }), { path: '$.data[*].id', select: 'iteration' });
    assert.deepEqual(applyListPick(p, { mode: 'sequence' }), { path: '$.data[*].id', select: 'sequence' });
    assert.deepEqual(applyListPick(p, { mode: 'all' }), { path: '$.data[*]', select: undefined, list: true });
    assert.deepEqual(applyListPick(p, { mode: 'allField' }), { path: '$.data[*].id', select: undefined, list: true });
    assert.equal('list' in applyListPick(p, { mode: 'vu' }), false);
    assert.equal(describePick({ path: '$.data[*].id', select: 'vu' }), 'item for each virtual user');
    assert.equal(describePick({ path: '$.data[*]', list: true }), 'every item, saved as a list');
  });
});

describe('which user is who', () => {
  const base = { vus: 5, usersMode: 'per-vu' as const, mode: 'iterations' as const, iterations: 3 };
  it('explains per-vu', () => {
    const d = describeUsers(base, 10);
    assert.match(d.summary, /Virtual user 1 is row 1, virtual user 5 is row 5/);
    assert.match(d.summary, /same user and session/);
    assert.equal(d.warning, undefined);
  });
  it('wraps around a small file', () => {
    assert.match(describeUsers({ ...base, vus: 8 }, 3).summary, /Virtual user 4 and above start again at row 1/);
  });
  it('warns about one virtual user', () => {
    assert.match(describeUsers({ ...base, vus: 1 }, 10).warning!, /same user/);
  });
  it('explains per-iteration', () => {
    const d = describeUsers({ ...base, usersMode: 'per-iteration' }, 10);
    assert.match(d.summary, /next row/);
    assert.match(d.summary, /15 logins/);
  });
  it('warns without a users file', () => {
    assert.ok(describeUsers(base, 0).warning);
  });
});
