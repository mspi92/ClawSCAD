const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGit, GitError } = require('../git');

const IGNORE = ['*.3mf', '.clawscad/'];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

test('ensureRepo initializes once, writes ignores, and creates a root commit', async (t) => {
  const dir = tempDir(t);
  const repo = createGit(dir);
  await repo.ensureRepo(IGNORE, 'Init');
  await repo.ensureRepo(IGNORE, 'Init');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8'), '*.3mf\n.clawscad/\n');
  const log = await repo.log();
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, 'Init');
  assert.deepEqual(log[0].parents, []);
});

test('commitAll records trailers, skips clean trees, and respects ignores', async (t) => {
  const dir = tempDir(t);
  const repo = createGit(dir);
  await repo.ensureRepo(IGNORE, 'Init');
  fs.writeFileSync(path.join(dir, 'model.scad'), '// Cube\ncube(1);');
  fs.writeFileSync(path.join(dir, 'model.3mf'), 'binary');
  assert.equal(await repo.isDirty(), true);
  const sha = await repo.commitAll('Cube', { sessionId: 'abc-123' });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await repo.isDirty(), false);
  assert.equal(await repo.commitAll('Nothing'), null);
  assert.equal(git(dir, 'ls-files', 'model.3mf'), '');

  const [latest] = await repo.log();
  assert.equal(latest.sha, sha);
  assert.equal(latest.sessionId, 'abc-123');
  assert.equal(latest.body, '');
  assert.ok(latest.refs.length > 0);
  assert.equal(await repo.showFile(sha, 'model.scad'), '// Cube\ncube(1);');
  assert.deepEqual(await repo.listFiles(sha), ['.gitignore', 'model.scad']);
});

test('checking out an older commit detaches HEAD and branches fork the log', async (t) => {
  const dir = tempDir(t);
  const repo = createGit(dir);
  await repo.ensureRepo(IGNORE, 'Init');
  const file = path.join(dir, 'model.scad');
  fs.writeFileSync(file, 'cube(1);');
  const first = await repo.commitAll('First');
  fs.writeFileSync(file, 'cube(2);');
  const second = await repo.commitAll('Second');
  const mainBranch = (await repo.head()).branch;

  await repo.checkout(first);
  assert.deepEqual(await repo.head(), { sha: first, branch: null });
  assert.equal(fs.readFileSync(file, 'utf-8'), 'cube(1);');

  await repo.createBranch('clawscad/alt');
  fs.writeFileSync(file, 'sphere(1);');
  const alt = await repo.commitAll('Alt');

  const log = await repo.log();
  const bySha = Object.fromEntries(log.map((e) => [e.sha, e]));
  assert.deepEqual(bySha[second].parents, [first]);
  assert.deepEqual(bySha[alt].parents, [first]);
  assert.deepEqual(await repo.localBranches(), { [mainBranch]: second, 'clawscad/alt': alt });

  await repo.checkout(mainBranch);
  await repo.deleteBranch('clawscad/alt');
  assert.equal((await repo.log()).some((e) => e.sha === alt), false);
});

test('a workspace inside an unrelated repo gets its own nested repo', async (t) => {
  const outer = tempDir(t);
  git(outer, 'init', '-q');
  const dir = path.join(outer, 'cad');
  fs.mkdirSync(dir);
  await createGit(dir).ensureRepo(IGNORE, 'Init');
  assert.equal(fs.realpathSync(git(dir, 'rev-parse', '--show-toplevel')), fs.realpathSync(dir));
});

test('a workspace already tracked by an enclosing repo is committed there, scoped to itself', async (t) => {
  const outer = tempDir(t);
  git(outer, 'init', '-q');
  const dir = path.join(outer, 'cad');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'model.scad'), 'cube(1);');
  fs.writeFileSync(path.join(outer, 'README.md'), 'project');
  git(outer, 'add', '-A');
  git(outer, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Project');

  const repo = createGit(dir);
  await repo.ensureRepo([], 'Init');
  fs.writeFileSync(path.join(dir, 'model.scad'), 'cube(2);');
  fs.writeFileSync(path.join(outer, 'README.md'), 'edited elsewhere');
  await repo.commitAll('Bigger cube');

  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  assert.equal(git(outer, 'status', '--porcelain'), 'M README.md');
  assert.deepEqual((await repo.log()).map((e) => e.subject), ['Bigger cube', 'Project']);
});

test('failures reject with git stderr and later calls still run', async (t) => {
  const dir = tempDir(t);
  const repo = createGit(dir);
  await repo.ensureRepo(IGNORE, 'Init');
  await assert.rejects(repo.checkout('no-such-branch'), (err) => err instanceof GitError && /no-such-branch/.test(err.message));
  await assert.rejects(repo.push(), (err) => err instanceof GitError && /origin/.test(err.message));
  assert.equal((await repo.log()).length, 1);
});
