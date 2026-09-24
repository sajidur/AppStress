import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPathAll, pickOne } from '../src/engine/jsonpath.js';
import { suggestTypedColumns } from '../src/server/services/helpers.js';
import { applyListPick, conditionText, describePick, siblingFields, splitListPath } from '../web/src/listpick.js';

const DATA = { items: [{ id: 1, status: 'CLOSED', qty: 0 }, { id: 2, status: 'OPEN', qty: 5 }, { id: 3, status: 'OPEN', qty: 9 }] };

describe('choosing which list item a value comes from', () => {
  it('splits a path at its last list position', () => {
    assert.deepEqual(splitListPath('$.items[1].id'), { prefix: '$.items', index: 1, suffix: '.id' });
    assert.deepEqual(splitListPath('$.groups[0].items[2].id'), { prefix: '$.groups[0].items', index: 2, suffix: '.id' });
    assert.equal(splitListPath('$.items[*].id'), null);
    assert.equal(splitListPath('$.token'), null);
  });

  it('turns a fixed position into first / last / random / conditional picks that actually select what they say', () => {
    const p = splitListPath('$.items[1].id')!;
    const run = (pick: Parameters<typeof applyListPick>[1]) => {
      const r = applyListPick(p, pick);
      return { ...r, value: pickOne(getPathAll(DATA, r.path!), r.select ?? 'first', () => 0.99) };
    };
    assert.deepEqual(run({ mode: 'position' }), { path: '$.items[1].id', select: undefined, value: 2 });
    assert.equal(run({ mode: 'first' }).value, 1);
    assert.equal(run({ mode: 'last' }).value, 3);
    assert.equal(run({ mode: 'random' }).value, 3, 'random with a fixed generator');
    const open = run({ mode: 'where', where: [{ field: 'status', op: '==', value: 'OPEN' }] });
    assert.equal(open.path, "$.items[?(@.status=='OPEN')].id");
    assert.equal(open.value, 2);
    assert.equal(run({ mode: 'where', select: 'last', where: [{ field: 'status', op: '==', value: 'OPEN' }] }).value, 3);
    assert.equal(run({ mode: 'where', where: [{ field: 'status', op: '==', value: 'OPEN' }, { field: 'qty', op: '>', value: '5' }] }).value, 3);
    assert.equal(run({ mode: 'where', where: [] }).path, '$.items[*].id', 'no condition means every item');
  });

  it('writes conditions the path engine understands', () => {
    assert.equal(conditionText({ field: 'status', op: '==', value: 'OPEN' }), "@.status=='OPEN'");
    assert.equal(conditionText({ field: '@.qty', op: '>=', value: '3' }), '@.qty>=3');
    assert.equal(conditionText({ field: 'ok', op: '==', value: 'true' }), '@.ok==true');
    assert.equal(conditionText({ field: 'name', op: '==', value: "O'Neil" }), "@.name=='O\\'Neil'");
    assert.equal(conditionText({ field: 'status', op: '=~', value: '^OP' }), '@.status=~/^OP/');
    const named = applyListPick(splitListPath('$.items[1].id')!, { mode: 'where', where: [{ field: 'name', op: '==', value: "O'Neil" }] });
    assert.deepEqual(getPathAll({ items: [{ id: 7, name: "O'Neil" }] }, named.path!), [7], 'quotes survive a round trip');
  });

  it('suggests the recorded item\'s own fields as conditions', () => {
    const sample = [{ path: '$.items[1].id', value: '2' }, { path: '$.items[1].status', value: 'OPEN' }, { path: '$.items[1].owner.name', value: 'bob' }, { path: '$.items[2].status', value: 'OPEN' }];
    assert.deepEqual(siblingFields(sample, splitListPath('$.items[1].id')!), [{ field: 'id', value: '2' }, { field: 'status', value: 'OPEN' }, { field: 'owner.name', value: 'bob' }]);
  });

  it('describes a pick in words', () => {
    assert.equal(describePick({ path: '$.items[1].id' }), 'item #2 of the list');
    assert.equal(describePick({ path: '$.items[*].id', select: 'random' }), 'random item');
    assert.equal(describePick({ path: "$.items[?(@.status=='OPEN')].id" }), "first item where status=='OPEN'");
    assert.equal(describePick({ path: '$.token' }), 'exact value');
  });
});

describe('typed inputs: which users-file column', () => {
  const rows = [{ name: 'alice', pw: 'pw-alice', employee_id: '1001' }, { name: 'bob', pw: 'pw-bob', employee_id: '1002' }];
  const cols = ['name', 'pw', 'employee_id'];
  const t = (field: string, label: string, type: string, value: string) => ({ at: 0, field, label, type, value, page: 'p' });

  it('prefers the column whose values contain what was typed, and falls back to the field name', () => {
    const s = suggestTypedColumns([t('UserId', 'Employee ID', 'text', 'alice'), t('Password', 'Password', 'password', 'pw-alice'), t('Employee_ID', 'Employee ID', 'text', '9999'), t('q', 'Search', 'text', 'red shoes')], cols, rows);
    assert.deepEqual(s.map((x) => x.suggestedColumn), ['name', 'pw', 'employee_id', undefined]);
    assert.equal(s[1].value, '••••••', 'passwords are never sent to the browser');
    assert.deepEqual(s.map((x) => x.index), [0, 1, 2, 3]);
  });
});

describe('typed inputs sent encoded', () => {
  it('say how they were sent when the page never sends the typed text', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const ex = (body: string) => ({ id: 1, startedAt: 1, durationMs: 1, pageUrl: '', resourceType: 'fetch', request: { method: 'POST', url: 'http://a/x', headers: {}, postData: body }, response: { status: 200, headers: {} } });
    const typed = (field: string, value: string, type = 'text') => ({ at: 0, field, label: field, type, value, page: 'p' });
    const s = suggestTypedColumns(
      [typed('UserName', 'alice01'), typed('Password', 'hunter2!', 'password'), typed('Note', 'hello there')],
      ['name'],
      [{ name: 'alice01' }],
      [ex(JSON.stringify({ u: b64('alice01'), p: b64('hunter2!'), note: 'hello there' }))],
    );
    assert.deepEqual(s.map((x) => x.sentAs), [['base64'], ['base64'], undefined], 'the note is sent as typed, so it is not "encoded"');
  });
});
