// Top-level part detection for OpenSCAD sources rendered with lazy-union,
// where every top-level geometry statement becomes its own 3MF object.

const NON_GEOMETRY = new Set(['module', 'function', 'include', 'use', 'echo', 'assert', 'else']);
const UNKNOWN = Symbol('unknown');

/**
 * Lexes OpenSCAD source into identifier, punctuation and literal tokens.
 * Comments and `include <...>` / `use <...>` paths are dropped.
 * Literal values live in `val` so they never collide with punctuation checks on `v`.
 * @returns {{t: 'id'|'p'|'lit', v?: string, val?: string|number}[]}
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { text += src[j + 1] || ''; j += 2; } else { text += src[j]; j++; }
      }
      tokens.push({ t: 'lit', val: text });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push({ t: 'id', v: word });
      i = j;
      if (word === 'include' || word === 'use') {
        while (i < src.length && /[ \t]/.test(src[i])) i++;
        if (src[i] === '<') {
          const close = src.indexOf('>', i);
          i = close < 0 ? src.length : close + 1;
        }
      }
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE]/.test(src[j])) j++;
      tokens.push({ t: 'lit', val: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ t: 'p', v: two });
      i += 2;
      continue;
    }
    tokens.push({ t: 'p', v: c });
    i++;
  }
  return tokens;
}

/** Index one past the bracket matching the opener at `start`, or `end` if unbalanced. */
function skipGroup(tokens, start, end) {
  let depth = 0;
  for (let k = start; k < end; k++) {
    const v = tokens[k].v;
    if (v === '(' || v === '[' || v === '{') depth++;
    else if ((v === ')' || v === ']' || v === '}') && --depth === 0) return k + 1;
  }
  return end;
}

/**
 * Index one past the statement starting at `start`: its closing `;` or `}` at depth 0.
 * With `continueElse`, a following `else` belongs to the same statement.
 */
function statementEnd(tokens, start, end, continueElse) {
  let depth = 0;
  let j = start;
  while (j < end) {
    const v = tokens[j].v;
    j++;
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') {
      depth--;
      if (depth === 0 && v === '}' && !(continueElse && j < end && tokens[j].v === 'else')) break;
    } else if (v === ';' && depth === 0 && !(continueElse && j < end && tokens[j].v === 'else')) break;
  }
  return j;
}

/** [start, end) token ranges of the statements in tokens[start, end). */
function splitStatements(tokens, start, end) {
  const ranges = [];
  for (let i = start; i < end;) {
    const j = statementEnd(tokens, i, end, true);
    ranges.push([i, j]);
    i = j;
  }
  return ranges;
}

/**
 * Values of top-level `name = <string | number | true | false>;` assignments.
 * Later assignments win, as in OpenSCAD.
 */
function collectConstants(tokens) {
  const env = {};
  for (const [s, e] of splitStatements(tokens, 0, tokens.length)) {
    if (e - s !== 4 || tokens[s].t !== 'id' || tokens[s + 1].v !== '=' || tokens[s + 3].v !== ';') continue;
    const value = tokens[s + 2];
    if (value.t === 'lit') env[tokens[s].v] = value.val;
    else if (value.v === 'true' || value.v === 'false') env[tokens[s].v] = value.v === 'true';
  }
  return env;
}

function truthy(v) {
  return v !== false && v !== 0 && v !== '' && v !== undefined;
}

/**
 * Truth value of the condition tokens[start, end), or UNKNOWN when it uses anything
 * beyond literals, constants from `env`, `== != < > <= >=`, `! && ||` and parentheses.
 */
function evaluate(tokens, start, end, env) {
  let i = start;
  const peek = () => (i < end ? tokens[i] : null);
  const fail = () => { throw UNKNOWN; };

  function primary() {
    const t = peek();
    if (!t) fail();
    i++;
    if (t.v === '(') {
      const v = or();
      if (!peek() || peek().v !== ')') fail();
      i++;
      return v;
    }
    if (t.v === '!') return !truthy(primary());
    if (t.t === 'lit') return t.val;
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return t.v === 'true';
      if (t.v === 'undef') return undefined;
      const next = peek();
      if (next && ['(', '[', '.'].includes(next.v)) fail();
      if (!Object.prototype.hasOwnProperty.call(env, t.v)) fail();
      return env[t.v];
    }
    return fail();
  }

  function compare() {
    const left = primary();
    const op = peek();
    if (!op || !['==', '!=', '<', '>', '<=', '>='].includes(op.v)) return left;
    i++;
    const right = primary();
    switch (op.v) {
      case '==': return left === right;
      case '!=': return left !== right;
      case '<': return left < right;
      case '>': return left > right;
      case '<=': return left <= right;
      default: return left >= right;
    }
  }

  function and() {
    let v = compare();
    while (peek() && peek().v === '&&') { i++; const r = compare(); v = truthy(v) && truthy(r); }
    return v;
  }

  function or() {
    let v = and();
    while (peek() && peek().v === '||') { i++; const r = and(); v = truthy(v) || truthy(r); }
    return v;
  }

  try {
    const v = or();
    return i === end ? truthy(v) : UNKNOWN;
  } catch (err) {
    if (err === UNKNOWN) return UNKNOWN;
    throw err;
  }
}

/**
 * Geometry statements in tokens[start, end), in source order, as {label, repeated}.
 * Label = innermost call of the transform chain (`translate(..) lid();` → `lid`);
 * a braced block is labelled by its own statements joined with ` + `.
 * `repeated` marks a `for` statement: lazy-union emits one object per iteration.
 * Skips definitions, assignments, include/use, echo/assert, statements disabled
 * with `*` or `%`, and `if` statements whose condition is statically false
 * (these emit no output object).
 */
function statementLabels(tokens, start, end, env) {
  const parts = [];
  for (const [s, e] of splitStatements(tokens, start, end)) {
    const part = describeStatement(tokens, s, e, env);
    if (part) parts.push(part);
  }
  return parts;
}

function describeStatement(tokens, start, end, env) {
  let k = start;
  while (k < end && ['!', '#'].includes(tokens[k].v)) k++;
  if (k >= end) return null;
  const first = tokens[k];
  if (first.v === '*' || first.v === '%' || first.v === ';') return null;
  if (first.v !== '{' && (first.t !== 'id' || NON_GEOMETRY.has(first.v))) return null;
  if (tokens[k + 1] && tokens[k + 1].v === '=') return null;

  if (first.v === 'if' && tokens[k + 1] && tokens[k + 1].v === '(') {
    const condEnd = skipGroup(tokens, k + 1, end);
    const cond = evaluate(tokens, k + 2, condEnd - 1, env);
    // A nested `if` body keeps a following `else` (dangling else binds innermost).
    const nestedIf = tokens[condEnd] && tokens[condEnd].v === 'if';
    const bodyEnd = tokens[condEnd] && tokens[condEnd].v === '{'
      ? skipGroup(tokens, condEnd, end)
      : statementEnd(tokens, condEnd, end, nestedIf);
    const hasElse = bodyEnd < end && tokens[bodyEnd].v === 'else';
    if (cond === false) return hasElse ? describeStatement(tokens, bodyEnd + 1, end, env) : null;
    return describeStatement(tokens, condEnd, bodyEnd, env);
  }

  const repeated = first.v === 'for';
  let lastCall = null;
  while (k < end) {
    const tok = tokens[k];
    if (tok.v === '{') {
      const close = skipGroup(tokens, k, end);
      const inner = statementLabels(tokens, k + 1, close - 1, env).map((p) => p.label);
      if (inner.length === 0) break;
      const label = inner.length > 3 ? inner.slice(0, 3).join(' + ') + ' + …' : inner.join(' + ');
      return { label, repeated };
    }
    if (tok.t === 'id' && tokens[k + 1] && tokens[k + 1].v === '(') {
      lastCall = tok.v;
      k = skipGroup(tokens, k + 1, end);
      continue;
    }
    if (tok.v === '(' || tok.v === '[') {
      k = skipGroup(tokens, k, end);
      continue;
    }
    k++;
  }
  return lastCall ? { label: lastCall, repeated } : null;
}

/**
 * Top-level geometry statements of an OpenSCAD program, in 3MF build order of a
 * lazy-union render. `if` switches over top-level constants (e.g. `part = "lid";`
 * … `if (part == "lid") lid();`) are evaluated; other conditions count as true.
 * Feed the result to `resolvePartNames` once the object count is known.
 * @param {string} source OpenSCAD program text.
 * @returns {{label: string, repeated: boolean}[]}
 */
function parseTopLevelParts(source) {
  const tokens = tokenize(source || '');
  return statementLabels(tokens, 0, tokens.length, collectConstants(tokens));
}

/**
 * One display name per rendered object, or null when `parts` can't account for
 * `objectCount` (count mismatch, or more than one top-level `for`).
 * A single `for` absorbs the surplus objects. Repeated names get a numeric
 * suffix (`bolt`, `bolt 2`), so names are unique within a model.
 * @param {{label: string, repeated: boolean}[]} parts from `parseTopLevelParts`.
 * @param {number} objectCount top-level objects in the rendered 3MF.
 * @returns {string[] | null}
 */
function resolvePartNames(parts, objectCount) {
  if (!Array.isArray(parts)) return null;
  const loops = parts.filter((p) => p.repeated).length;
  const fixed = parts.length - loops;
  let labels;
  if (loops === 0 && objectCount === parts.length) {
    labels = parts.map((p) => p.label);
  } else if (loops === 1 && objectCount >= fixed) {
    labels = parts.flatMap((p) => (p.repeated ? Array(objectCount - fixed).fill(p.label) : [p.label]));
  } else {
    return null;
  }
  const seen = new Map();
  return labels.map((label) => {
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  });
}

module.exports = { parseTopLevelParts, resolvePartNames };
