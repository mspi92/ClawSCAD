const { test } = require('node:test');
const assert = require('node:assert/strict');
const { layoutHistory } = require('../history-graph');

/** Builds checkpoints from `[id, parent]` pairs listed newest first. */
function history(pairs) {
  const cps = {};
  pairs.forEach(([id, parent], order) => { cps[id] = { parent, order, created: '2026-01-01T00:00:00Z' }; });
  return cps;
}

const brief = ({ rows }) => rows.map(({ id, lane, joins }) => ({ id, lane, joins }));

test('linear chain stays in one lane', () => {
  const layout = layoutHistory(history([['c', 'b'], ['b', 'a'], ['a', null]]));
  assert.equal(layout.laneCount, 1);
  assert.deepEqual(layout.rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(layout.rows[0].above, []);
  assert.deepEqual(layout.rows[1].above, [0]);
  assert.deepEqual(layout.rows[2].below, []);
});

test('a fork opens a second lane that joins back at the branch point', () => {
  const layout = layoutHistory(history([['x', 'b'], ['c', 'b'], ['b', 'a'], ['a', null]]));
  assert.equal(layout.laneCount, 2);
  assert.deepEqual(brief(layout), [
    { id: 'x', lane: 0, joins: [] },
    { id: 'c', lane: 1, joins: [] },
    { id: 'b', lane: 0, joins: [1] },
    { id: 'a', lane: 0, joins: [] },
  ]);
  assert.deepEqual(layout.rows[1].above, [0]);
  assert.deepEqual(layout.rows[1].below, [0, 1]);
  assert.deepEqual(layout.rows[2].below, [0]);
});

test('freed lanes are reused by later branch tips', () => {
  const layout = layoutHistory(history([
    ['y', 'b'], ['x', 'c'], ['c', 'b'], ['b', 'a'], ['z', 'a'], ['a', null],
  ]));
  assert.equal(layout.laneCount, 2);
  assert.deepEqual(layout.rows.map((r) => r.lane), [0, 1, 1, 0, 1, 0]);
});

test('a parent outside the set ends the lane', () => {
  const layout = layoutHistory(history([['b', 'a'], ['a', 'gone']]));
  assert.deepEqual(layout.rows[1].below, []);
});

test('falls back to newest-first by date without order', () => {
  const layout = layoutHistory({
    a: { parent: null, created: '2026-01-01T00:00:00Z' },
    b: { parent: 'a', created: '2026-01-02T00:00:00Z' },
  });
  assert.deepEqual(layout.rows.map((r) => r.id), ['b', 'a']);
});
