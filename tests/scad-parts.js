const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTopLevelParts, resolvePartNames } = require('../scad-parts');

const labels = (src) => parseTopLevelParts(src).map((p) => p.label);

test('innermost call of a transform chain names the part', () => {
  assert.deepEqual(labels('color("red") base();\ntranslate([0,0,15]) rotate([0,0,45]) lid();'), ['base', 'lid']);
});

test('definitions, assignments, includes and output-free statements are skipped', () => {
  const src = [
    'include <lib/bolts.scad>',
    'use <helpers.scad>',
    '$fn = 32; width = 10;',
    'module base() { cube([width, width, 1]); }',
    'module flat() cube(1);',
    'function twice(x) = x * 2;',
    'echo("debug");',
    '*disabled();',
    '%background();',
    'base();',
  ].join('\n');
  assert.deepEqual(labels(src), ['base']);
});

test('comments and strings cannot end or open statements', () => {
  const src = '// lid(); \n/* a(); { */ label = "x; } y();"; text("a;b") ; cube(1);';
  assert.deepEqual(labels(src), ['text', 'cube']);
});

test('debug modifiers keep the part; blocks are labelled by their contents', () => {
  assert.deepEqual(labels('#marker();\ntranslate([5,0,0]) { bolt(); nut(); }'), ['marker', 'bolt + nut']);
  assert.deepEqual(labels('union() { a(); b(); c(); d(); }'), ['a + b + c + …']);
});

test('if/else is one statement', () => {
  assert.deepEqual(labels('if (big) { a(); } else { b(); }\nc();'), ['a', 'c']);
});

test('switches over top-level constants are evaluated', () => {
  const src = [
    'part = "assembly"; show = true; n = 3;',
    'if (part == "assembly" && show) components();',
    'if (part == "assembly") translate([0, 0, -5]) plinth();',
    'if (part == "end-caps") top_cover();',
    'if (part != "print" || !show) spine();',
    'if (n > 2) bolts();',
    'if (n <= 2) nuts();',
  ].join('\n');
  assert.deepEqual(labels(src), ['components', 'plinth', 'spine', 'bolts']);
});

test('false branches fall through to else and else-if chains', () => {
  const chain = (p) => labels(`part = "${p}";\nif (part == "a") a(); else if (part == "b") { b(); } else c();\nlast();`);
  assert.deepEqual(chain('a'), ['a', 'last']);
  assert.deepEqual(chain('b'), ['b', 'last']);
  assert.deepEqual(chain('z'), ['c', 'last']);
  assert.deepEqual(labels('x = 1;\nif (x == 2) { a(); } else { b(); c(); }'), ['b + c']);
});

test('a dangling else binds to the innermost if', () => {
  assert.deepEqual(labels('p = false; q = true;\nif (p) if (q) a(); else b();\nc();'), ['c']);
  assert.deepEqual(labels('p = true; q = false;\nif (p) if (q) a(); else b();'), ['b']);
});

test('conditions beyond constants count as true', () => {
  assert.deepEqual(labels('if (len(v) > 0) a();\nif (unknown_var) b();\nif ($preview) c();'), ['a', 'b', 'c']);
  assert.deepEqual(labels('part = "x";\npart = "y";\nif (part == "y") y_part();'), ['y_part']);
  assert.deepEqual(labels('label = "(";\nif (label == "(") paren();'), ['paren']);
});

test('only top-level for statements are marked repeated', () => {
  const parts = parseTopLevelParts('base();\nfor (i = [0:3]) translate([i * 10, 0, 0]) bolt();\nlid();');
  assert.deepEqual(parts, [
    { label: 'base', repeated: false },
    { label: 'bolt', repeated: true },
    { label: 'lid', repeated: false },
  ]);
});

test('resolvePartNames suffixes duplicates', () => {
  const parts = parseTopLevelParts('bolt(); nut(); bolt();');
  assert.deepEqual(resolvePartNames(parts, 3), ['bolt', 'nut', 'bolt 2']);
});

test('a single for absorbs the surplus objects', () => {
  const parts = parseTopLevelParts('base();\nfor (i = [0:3]) bolt();\ncube(5);');
  assert.deepEqual(resolvePartNames(parts, 6), ['base', 'bolt', 'bolt 2', 'bolt 3', 'bolt 4', 'cube']);
  assert.deepEqual(resolvePartNames(parts, 2), ['base', 'cube']);
});

test('unresolvable counts return null', () => {
  assert.equal(resolvePartNames(parseTopLevelParts('a(); b();'), 3), null);
  assert.equal(resolvePartNames(parseTopLevelParts('for(i=[0:1]) a(); for(j=[0:1]) b();'), 4), null);
  assert.equal(resolvePartNames(parseTopLevelParts('a(); b(); c();'), 1), null);
  assert.equal(resolvePartNames(undefined, 1), null);
});
