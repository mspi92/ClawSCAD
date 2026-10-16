const fs = require('fs');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');

const SESSION_TRAILER = 'ClawSCAD-Session';
const FALLBACK_IDENTITY = ['-c', 'user.name=ClawSCAD', '-c', 'user.email=clawscad@localhost'];
const FIELD = '\x1f';
const RECORD = '\x1e';

class GitError extends Error {
  constructor(args, err, stderr) {
    const text = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    super((text || err.message).slice(0, 500));
    this.args = args;
    this.code = err.code;
  }
}

/**
 * Git operations scoped to one workspace directory.
 * The workspace may be a repo root or a subdirectory of a larger repo: staging,
 * commits and history are limited to paths under `cwd`.
 * All calls are serialized so concurrent callers never race on the index lock.
 * Every method rejects with GitError (message = git's stderr tail) on failure.
 * @param {string} cwd workspace directory.
 * @param {{execFile?: Function}} [opts] child_process.execFile-compatible runner.
 */
function createGit(cwd, { execFile = nodeExecFile } = {}) {
  let chain = Promise.resolve();
  let identity = null;

  function raw(args) {
    return new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd,
        // Fail instead of blocking on a credential prompt nobody can answer.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60000,
      }, (err, stdout, stderr) => {
        if (err) reject(new GitError(args, err, stderr));
        else resolve(String(stdout));
      });
    });
  }

  function serial(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  async function succeeds(args) {
    try { await raw(args); return true; } catch { return false; }
  }

  async function identityArgs() {
    if (identity === null) {
      const configured = await succeeds(['config', 'user.email']);
      identity = configured ? [] : FALLBACK_IDENTITY;
    }
    return identity;
  }

  async function hasHead() {
    return succeeds(['rev-parse', '--verify', '-q', 'HEAD']);
  }

  // An enclosing repo (e.g. a dotfiles repo in $HOME) is only adopted when it
  // already tracks files in the workspace; otherwise a nested repo is created.
  async function usableRepo() {
    let top;
    try { top = (await raw(['rev-parse', '--show-toplevel'])).trim(); } catch { return false; }
    if (fs.realpathSync(top) === fs.realpathSync(cwd)) return true;
    try { return (await raw(['ls-files', '--', '.'])).trim().length > 0; } catch { return false; }
  }

  async function dirty() {
    return (await raw(['status', '--porcelain', '--', '.'])).trim().length > 0;
  }

  // `initial` commits whatever is staged (possibly nothing) to give HEAD a root;
  // otherwise only paths under cwd are committed, leaving other staged work alone.
  async function commit(subject, sessionId, initial) {
    await raw(['add', '-A', '--', '.']);
    if (!initial && await succeeds(['diff', '--cached', '--quiet', '--', '.'])) return null;
    const msg = ['-m', subject];
    if (sessionId) msg.push('-m', `${SESSION_TRAILER}: ${sessionId}`);
    const scope = initial ? ['--allow-empty'] : ['--', '.'];
    await raw([...(await identityArgs()), 'commit', '-q', ...msg, ...scope]);
    return (await raw(['rev-parse', 'HEAD'])).trim();
  }

  return {
    /** True when a `git` binary can be executed. */
    isAvailable: () => serial(() => succeeds(['--version'])),

    /**
     * Initializes a repo in `cwd` unless `cwd` is a repo root or already tracked by
     * an enclosing repo, appends missing `ignoreLines` to `<cwd>/.gitignore`, and
     * creates an initial commit if HEAD is unborn.
     */
    ensureRepo: (ignoreLines = [], initialMessage = 'Initialize workspace') => serial(async () => {
      if (!(await usableRepo())) await raw(['init', '-q']);
      const ignorePath = path.join(cwd, '.gitignore');
      let existing = '';
      try { existing = fs.readFileSync(ignorePath, 'utf-8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
      const missing = ignoreLines.filter((l) => !present.has(l));
      if (missing.length) {
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(ignorePath, existing + sep + missing.join('\n') + '\n');
      }
      if (!(await hasHead())) await commit(initialMessage, null, true);
    }),

    /** True when tracked or untracked, non-ignored changes exist under `cwd`. */
    isDirty: () => serial(dirty),

    /**
     * Stages everything under `cwd` and commits it.
     * @param {string} subject first message line.
     * @param {{sessionId?: string}} [meta] stored as a `ClawSCAD-Session:` trailer.
     * @returns {Promise<string|null>} new commit SHA, or null when nothing changed.
     */
    commitAll: (subject, { sessionId } = {}) => serial(() => commit(subject, sessionId, false)),

    /** @returns {Promise<{sha: string|null, branch: string|null}>} branch is null when detached. */
    head: () => serial(async () => {
      if (!(await hasHead())) return { sha: null, branch: null };
      const sha = (await raw(['rev-parse', 'HEAD'])).trim();
      let branch = null;
      try { branch = (await raw(['symbolic-ref', '-q', '--short', 'HEAD'])).trim() || null; } catch {}
      return { sha, branch };
    }),

    /** @returns {Promise<Object<string, string>>} local branch name → tip SHA. */
    localBranches: () => serial(async () => {
      const out = await raw(['for-each-ref', `--format=%(refname:short)${FIELD}%(objectname)`, 'refs/heads']);
      const branches = {};
      for (const line of out.split('\n')) {
        const [name, sha] = line.split(FIELD);
        if (name && sha) branches[name] = sha;
      }
      return branches;
    }),

    /**
     * Commits reachable from any ref that touch `cwd`, newest first. Parents are
     * rewritten to the nearest ancestor that also touches `cwd`.
     * @returns {Promise<{sha, parents: string[], date, subject, body, refs: string[], sessionId}[]>}
     *   `body` excludes the session trailer; `refs` are decoration names (`main`, `origin/main`, `tag: v1`).
     */
    log: ({ limit = 500 } = {}) => serial(async () => {
      if (!(await hasHead())) return [];
      const format = ['%H', '%P', '%aI', '%s', '%b', '%D'].join(FIELD) + RECORD;
      const out = await raw(['log', '--exclude=refs/stash', '--all', '--parents', '--date-order',
        `-n${limit}`, `--format=${format}`, '--', '.']);
      const trailer = new RegExp(`^${SESSION_TRAILER}:\\s*(\\S+)\\s*$`, 'm');
      return out.split(RECORD).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
        const [sha, parents, date, subject, body = '', refs = ''] = rec.split(FIELD);
        const m = body.match(trailer);
        return {
          sha,
          parents: parents ? parents.split(' ') : [],
          date,
          subject,
          body: body.replace(trailer, '').trim(),
          refs: refs.trim() ? refs.trim().split(', ').map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD') : [],
          sessionId: m ? m[1] : null,
        };
      });
    }),

    /** Checks out a branch name (stays attached) or a SHA (detached HEAD). */
    checkout: (ref) => serial(() => raw(['checkout', '-q', ref])),

    /** Creates `name` at HEAD and switches to it. */
    createBranch: (name) => serial(() => raw(['checkout', '-q', '-b', name])),

    /** Force-deletes a local branch; its commits disappear from `log` unless reachable elsewhere. */
    deleteBranch: (name) => serial(() => raw(['branch', '-D', name])),

    /** Names of the files directly under `cwd` at commit `sha`. */
    listFiles: (sha) => serial(async () => {
      const out = await raw(['ls-tree', '--name-only', `${sha}:./`]);
      return out.split('\n').filter(Boolean);
    }),

    /** Text of `<cwd>/<name>` at commit `sha`. */
    showFile: (sha, name) => serial(() => raw(['show', `${sha}:./${name}`])),

    /** `git push -u origin HEAD` using the user's remote and credential config. */
    push: () => serial(() => raw(['push', '-u', 'origin', 'HEAD'])),
  };
}

module.exports = { createGit, GitError, SESSION_TRAILER };
