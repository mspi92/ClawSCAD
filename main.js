const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const chokidar = require('chokidar');
const { execFile, spawn } = require('child_process');
const { createGit } = require('./git');
const { parseTopLevelParts } = require('./scad-parts');

// Resolve the OpenSCAD binary: prefer bundled copy, fall back to env / system.
// In packaged builds, extraResources lands at process.resourcesPath.
// In dev, look in the repo's vendors/ directory (populated by download-openscad.js).
function resolveOpenSCAD() {
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, 'vendors');
  const candidates = {
    linux:  path.join(base, 'openscad-linux.AppImage'),
    darwin: path.join(base, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'),
    win32:  path.join(base, 'openscad-win', 'openscad.exe'),
  };
  const bundled = candidates[process.platform];
  if (bundled && fs.existsSync(bundled)) return bundled;
  return process.env.OPENSCAD_BINARY || 'openscad';
}
const OPENSCAD_BIN = resolveOpenSCAD();

// Resolve the Claude Code CLI binary. Checks the standalone installer location
// (~/.claude/local/claude), user/system PATH, and other common install paths.
// Returns null if not found — startTerminal will auto-install via npm in that case.
let _claudeBin = null;
function resolveClaude() {
  if (_claudeBin) return _claudeBin;
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'), // standalone installer
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  // Search every directory on this process's PATH (catches npm global and others)
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'claude'));
  }
  // On Windows the executable is claude.exe (standalone / ~/.local/bin) or
  // claude.cmd (npm global), so probe platform extensions before the bare name.
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const c of candidates) {
    for (const ext of exts) {
      try { if (fs.existsSync(c + ext)) { _claudeBin = c + ext; return c + ext; } } catch {}
    }
  }
  return null;
}

// Interactive shell to fall back to when Claude can't be launched. On Windows
// process.env.SHELL is unset, so a bare '/bin/bash' fallback would fail to spawn.
const DEFAULT_SHELL = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');

// Extra env vars needed when running OpenSCAD on specific platforms.
// On Linux, APPIMAGE_EXTRACT_AND_RUN=1 lets a bundled AppImage run inside
// the Electron AppImage without needing nested FUSE mounts.
function openscadEnv() {
  if (process.platform === 'linux' && OPENSCAD_BIN.endsWith('.AppImage')) {
    return { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
  }
  return process.env;
}
const STATE_FILE = 'clawscad.json';
const ENTRY_FILE = 'model.scad';
// Snapshot of the selected checkpoint in the file-per-version workflow; only read to seed ENTRY_FILE.
const LEGACY_ACTIVE_FILE = 'active.scad';
const CACHE_DIR = path.join('.clawscad', 'cache');
// CLAUDE.md and .claude/ are rewritten per machine and per open-window set; tracking them would add noise commits.
const GITIGNORE_LINES = ['*.stl', '*.3mf', '.clawscad/', 'RENDER_ERRORS.md', LEGACY_ACTIVE_FILE, STATE_FILE, 'CLAUDE.md', '.claude/'];
const COMMIT_DEBOUNCE_MS = 2000;
const MAX_WINDOWS = 4;

// ── OpenSCAD MCP Client ─────────────────────────────────────────────────
// Spawns openscad-mcp-server as a subprocess and calls its tools via JSON-RPC.
// This gives ClawSCAD direct rendering/validation without relying on Claude's MCP.

class McpClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.buffer = '';
    this.ready = false;
  }

  async start() {
    if (this.proc) return;

    try {
      this.proc = spawn('npx', ['-y', 'openscad-mcp-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
    } catch (err) {
      console.error('Failed to start openscad-mcp-server:', err.message);
      return;
    }

    const proc = this.proc;
    const onError = (err) => {
      console.error('openscad-mcp-server process error:', err.message);
      this._disconnect(proc, err);
    };
    proc.on('error', onError);
    proc.stdin.on('error', onError);

    proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return;
      this.buffer += chunk.toString();
      this._processBuffer();
    });

    this.proc.stderr.on('data', (chunk) => {
      // MCP server logs go to stderr — ignore unless debugging
    });

    proc.on('exit', () => this._disconnect(proc, new Error('MCP server exited')));

    // MCP handshake
    try {
      await this._send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ClawSCAD', version: '0.1.0' },
      });
      if (this.proc !== proc) return;
      this._notify('notifications/initialized');
      this.ready = true;
    } catch (err) {
      console.error('MCP handshake failed:', err.message);
    }
  }

  stop() {
    if (this.proc) {
      const proc = this.proc;
      try { proc.kill(); } catch {}
      this._disconnect(proc, new Error('MCP server stopped'));
    }
  }

  _disconnect(proc, err) {
    // An old child's delayed exit must not clear a replacement connection.
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = false;
    this.buffer = '';
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _processBuffer() {
    // MCP uses newline-delimited JSON
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message || 'MCP error'));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {}
    }
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('MCP not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(msg);
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('MCP timeout'));
        }
      }, 30000);
    });
  }

  _notify(method, params) {
    if (!this.proc) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n';
    this.proc.stdin.write(msg);
  }

  async callTool(name, args) {
    if (!this.ready) await this.start();
    if (!this.ready) throw new Error('MCP server not available');
    const result = await this._send('tools/call', { name, arguments: args });
    if (result && result.isError) {
      throw new Error(result.content?.[0]?.text || 'Tool error');
    }
    return result;
  }

  async renderPng(scadCode, opts = {}) {
    return this.callTool('render_scad_png', {
      scadCode,
      width: opts.width || 800,
      height: opts.height || 600,
      cameraPreset: opts.cameraPreset || 'isometric',
    });
  }

  async exportStl(scadCode, filename) {
    return this.callTool('export_scad_stl', { scadCode, filename });
  }
}

const mcpClient = new McpClient();

// ── Multi-Window State ──────────────────────────────────────────────────
// Each BrowserWindow gets its own context: workspace, checkpoints, pty, watcher.
// Claude in each window sees all other open workspaces via CLAUDE.md.

const windows = new Map(); // webContents.id -> ctx

function getCtx(event) {
  return windows.get(event.sender.id);
}

// ── Open / Close Windows ────────────────────────────────────────────────

function openWindow(wsDir) {
  if (windows.size >= MAX_WINDOWS) return null;

  wsDir = wsDir || path.join(os.homedir(), 'clawscad-workspace');

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'ClawSCAD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d0d1a',
    icon: path.join(__dirname, 'icon.png'),
  });

  Menu.setApplicationMenu(null);

  const ctx = {
    window: win,
    workspaceDir: wsDir,
    state: { labels: {} },
    history: emptyHistory(null),
    historyReady: Promise.resolve(),
    historyLock: Promise.resolve(),
    git: null,
    commitTimer: null,
    fileWatcher: null,
    ptyProcess: null,
    renderQueue: [],
    isRendering: false,
    stlFallbackFor: null,
  };

  const wcId = win.webContents.id;
  windows.set(wcId, ctx);

  win.loadFile('index.html');

  activateWorkspace(ctx);

  win.webContents.once('did-finish-load', () => {
    ctx.historyReady.then(() => {
      sendCheckpoints(ctx);
      showCurrentModel(ctx);
    });
  });

  win.on('closed', () => {
    clearTimeout(ctx.commitTimer);
    withHistoryLock(ctx, () => autoCommit(ctx)).catch(() => {});
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
    if (ctx.ptyProcess2) try { ctx.ptyProcess2.kill(); } catch {}
    ctx.window = null; // Mark as destroyed so ctxSend won't touch it
    windows.delete(wcId);
    updateAllClaudeMd();
  });

  updateAllClaudeMd();
  addRecentPath(wsDir);
  return ctx;
}

// ── Workspace Init ──────────────────────────────────────────────────────

const CLAUDE_MD_RULES = `## File Rules (NEVER break these)
- **The model lives in \`${ENTRY_FILE}\`. Edit it in place** (create it if it does not exist). Do NOT create new copies or versioned files like \`model-v2.scad\` — ClawSCAD commits every change to git automatically, and the History panel shows the git log.
- **Line 1 of \`${ENTRY_FILE}\` MUST be a comment describing your latest change**, e.g.: \`// Hollowed center, added 6 bolt holes around the flange\`. Rewrite it on every edit — it becomes the commit message shown in the history.
- **Never run git commands yourself** (no commit, checkout, reset, push). The app owns the repository; the user switches versions from the History panel.
- Helper files (\`include\`/\`use\` libraries) are allowed next to \`${ENTRY_FILE}\`; they are committed with it.

## Parts — one top-level statement per independent component
ClawSCAD renders each top-level statement as a separate part the user can show or hide in the viewer. Define every independent component as a module and call each one on its own top-level line:
\`\`\`scad
module base() { ... }
module lid() { ... }
color("SteelBlue") base();
color("Gold") translate([0, 0, 30]) lid();
\`\`\`
Do NOT wrap the whole assembly in one outer \`union()\`, \`translate()\` or \`{ }\` block — that merges everything into a single part.
For view switches (e.g. \`part = "assembly";\`), write one independent line per component — \`if (part == "assembly") lid();\` — not an \`if/else\` chain or a wrapper module like \`assembly()\`, which render as one part.

## Colors — use them extensively
OpenSCAD's \`color()\` function is fully supported. **Color every part** of your models to make them visually clear:
\`\`\`scad
color("SteelBlue") body();
color([0.8, 0.2, 0.1]) accent_ring();
color("#44cc88", 0.8) transparent_cover();
\`\`\`
Supported formats: named colors (CSS/SVG names like "Red", "SteelBlue", "Gold"), \`[r,g,b]\` floats 0-1, \`[r,g,b,a]\` with alpha, hex \`"#rrggbb"\`, \`"#rrggbbaa"\`.

## Workflow
1. Read \`${ENTRY_FILE}\` to understand the current model — it always reflects the version the user selected in the history
2. Edit \`${ENTRY_FILE}\` in place and update its first-line comment
3. **Use the OpenSCAD MCP server to validate your work** — this is critical:
   - After editing, use the MCP \`render\` tool to render it and visually inspect the result
   - Use \`validate_scad\` to check for syntax errors before rendering
   - Use \`analyze_model\` to check bounding box and dimensions match what the user asked for
   - If the render shows problems, fix \`${ENTRY_FILE}\` again
   - Use \`render_perspectives\` to check the model from multiple angles
4. The app re-renders on every save and commits the change a moment later
5. Users can click any commit in the history to go back; editing from an older commit starts a new branch automatically

## MCP Tools Available
You have access to the \`openscad\` MCP server with these tools — **use them proactively**:
- \`render_single\` / \`render_perspectives\` — render the model to see what it looks like
- \`validate_scad\` — check syntax before rendering (saves time)
- \`analyze_model\` — get bounding box, dimensions, triangle count
- \`export\` — export to STL, 3MF, AMF, etc.
- \`check_openscad\` — verify OpenSCAD is installed and working
- \`get_libraries\` — discover installed OpenSCAD libraries

**Always render and visually verify your output.** Don't just write code and hope — use the MCP tools to see the result and iterate if needed.

## Auto-Iteration
ClawSCAD automatically renders \`${ENTRY_FILE}\` whenever a .scad file changes. If a render fails:
- Errors are written to \`RENDER_ERRORS.md\` in this workspace
- You will receive a message asking you to fix the issue
- **Read RENDER_ERRORS.md**, understand the problem, and fix it in place
- Keep iterating until the render succeeds — don't present broken models to the user
- Only stop when you have a clean render with no errors`;

function updateAllClaudeMd() {
  // Filter out destroyed windows
  const live = Array.from(windows.values()).filter((c) => c.window !== null);
  const allWorkspaces = live.map((c) => c.workspaceDir);
  for (const ctx of live) {
    try { writeClaudeMd(ctx, allWorkspaces); } catch {}
  }
}

const CLAUDE_MD_START = '<!-- clawscad:rules:start -->';
const CLAUDE_MD_END = '<!-- clawscad:rules:end -->';

function buildClaudeMdBlock(ctx, allWorkspaces) {
  const others = allWorkspaces.filter((w) => w !== ctx.workspaceDir);
  let md = `# ClawSCAD Workspace — MANDATORY RULES\n\n${CLAUDE_MD_RULES}\n`;

  if (others.length > 0) {
    md += `\n## Multi-Project Context\n`;
    md += `ClawSCAD currently has ${allWorkspaces.length} projects open. You can reference designs across projects:\n`;
    for (const w of allWorkspaces) {
      const label = path.basename(w);
      if (w === ctx.workspaceDir) {
        md += `- **This workspace** (${label}): \`${w}\`\n`;
      } else {
        md += `- ${label}: \`${w}\`\n`;
      }
    }
    md += `\nTo import a part from another project:\n\`\`\`scad\nuse <${others[0]}/filename.scad>\n\`\`\`\n`;
    md += `You can read any file from these paths. If the user asks you to combine or reference designs from other projects, read the relevant .scad files directly.\n`;
  }

  return md.replace(/\n+$/, '');
}

function writeClaudeMd(ctx, allWorkspaces) {
  const filePath = path.join(ctx.workspaceDir, 'CLAUDE.md');
  const managed = `${CLAUDE_MD_START}\n${buildClaudeMdBlock(ctx, allWorkspaces)}\n${CLAUDE_MD_END}`;
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const start = existing.indexOf(CLAUDE_MD_START);
  const end = existing.indexOf(CLAUDE_MD_END, start + CLAUDE_MD_START.length);
  const output = start !== -1 && end !== -1
    ? existing.slice(0, start) + managed + existing.slice(end + CLAUDE_MD_END.length)
    : managed + (existing ? '\n\n' + existing : '\n');
  fs.writeFileSync(filePath, output);
}

function initWorkspace(ctx) {
  fs.mkdirSync(ctx.workspaceDir, { recursive: true });

  // MCP server config — merge into existing settings
  const claudeDir = path.join(ctx.workspaceDir, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  let settings = {};
  try {
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }
  } catch {}
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers.openscad = {
    command: 'npx',
    args: ['-y', 'openscad-mcp-server'],
    // Point the MCP server at the same bundled binary ClawSCAD uses
    env: { OPENSCAD_PATH: OPENSCAD_BIN },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ── State Management ────────────────────────────────────────────────────

function statePath(ctx) {
  return path.join(ctx.workspaceDir, STATE_FILE);
}

// clawscad.json holds UI-only state: `labels` maps commit SHA → display name.
// Keys from the file-per-version format (`checkpoints`, `active`) are dropped.
function loadState(ctx) {
  ctx.state = { labels: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(ctx), 'utf-8'));
    const { checkpoints, active, ...rest } = saved || {};
    ctx.state = { ...rest, labels: rest.labels && typeof rest.labels === 'object' ? rest.labels : {} };
  } catch {}
}

function saveState(ctx) {
  fs.writeFileSync(statePath(ctx), JSON.stringify(ctx.state, null, 2));
}

function extractDescription(scadPath) {
  try {
    const content = fs.readFileSync(scadPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        const comment = trimmed.slice(2).trim();
        if (comment.length > 0) return comment;
      }
      if (trimmed.length > 0 && !trimmed.startsWith('//')) break;
    }
  } catch {}
  return '';
}

function getEncodedCwd(dir) {
  return dir.replace(/\//g, '-').replace(/^-/, '');
}

function detectCurrentSessionId(ctx) {
  const encoded = getEncodedCwd(ctx.workspaceDir);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  try {
    if (!fs.existsSync(projectDir)) return null;
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({
        name: path.basename(f, '.jsonl'),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].name : null;
  } catch {
    return null;
  }
}

// ── History (git) ───────────────────────────────────────────────────────
// The workspace is a git repo; ENTRY_FILE is edited in place and every change
// is auto-committed. ctx.history mirrors `git log --all` for the renderer:
// { checkpoints: {sha: node}, active: HEAD sha, branch: HEAD branch | null,
//   activeKey: render-cache key of the working tree, gitError: string | null }.

function emptyHistory(gitError) {
  return { checkpoints: {}, active: null, branch: null, activeKey: null, gitError };
}

/** Runs `fn` once every history operation queued before it on this window has settled. */
function withHistoryLock(ctx, fn) {
  const run = ctx.historyLock.then(fn, fn);
  ctx.historyLock = run.catch(() => {});
  return run;
}

/**
 * (Re)binds the window to ctx.workspaceDir: workspace files, state, terminal,
 * watcher, and git history. ctx.historyReady settles once history is loaded.
 */
function activateWorkspace(ctx) {
  clearTimeout(ctx.commitTimer);
  ctx.commitTimer = null;
  ctx.git = null;
  ctx.history = emptyHistory(null);
  initWorkspace(ctx);
  loadState(ctx);
  startTerminal(ctx);
  startFileWatcher(ctx);
  ctx.historyReady = initHistory(ctx);
  if (ctx.window) ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
}

/**
 * Opens or creates the workspace repo and loads its log. Without usable git,
 * ctx.git stays null and ctx.history.gitError says why. Never rejects.
 */
async function initHistory(ctx) {
  const dir = ctx.workspaceDir;
  seedEntryFromLegacy(dir);
  const git = createGit(dir, { execFile });
  let error = null;
  try {
    if (await git.isAvailable()) await git.ensureRepo(GITIGNORE_LINES, 'Initialize ClawSCAD workspace');
    else error = 'git was not found on PATH — install git to enable history';
  } catch (err) {
    error = `git: ${err.message}`;
  }
  if (ctx.workspaceDir !== dir) return;
  if (error) {
    ctx.history = emptyHistory(error);
    return;
  }
  ctx.git = git;
  try {
    await refreshHistory(ctx);
  } catch (err) {
    ctx.history = emptyHistory(`git: ${err.message}`);
  }
}

// A workspace from the file-per-version workflow continues from its selected checkpoint.
function seedEntryFromLegacy(dir) {
  const entry = path.join(dir, ENTRY_FILE);
  const legacy = path.join(dir, LEGACY_ACTIVE_FILE);
  try {
    if (!fs.existsSync(entry) && fs.existsSync(legacy)) fs.copyFileSync(legacy, entry);
  } catch {}
}

/** Reloads the git log into ctx.history and pushes it to the renderer. */
async function refreshHistory(ctx) {
  const git = ctx.git;
  if (!git) return;
  const entries = await git.log();
  const head = await git.head();
  const branches = await git.localBranches();
  if (ctx.git !== git) return;

  const branchesAt = {};
  for (const [name, sha] of Object.entries(branches)) (branchesAt[sha] ||= []).push(name);
  const checkpoints = {};
  for (const [order, e] of entries.entries()) {
    checkpoints[e.sha] = {
      sha: e.sha,
      order,
      parent: e.parents[0] || null,
      subject: e.subject,
      label: ctx.state.labels[e.sha] || e.subject,
      description: e.body || e.subject,
      sessionId: e.sessionId,
      created: e.date,
      refs: e.refs,
      branches: branchesAt[e.sha] || [],
      file: ENTRY_FILE,
    };
  }
  ctx.history = {
    checkpoints,
    active: head.sha,
    branch: head.branch,
    activeKey: modelKey(ctx.workspaceDir, ENTRY_FILE),
    gitError: null,
  };
  sendCheckpoints(ctx);
}

/** Debounces an auto-commit after file changes; errors surface as `git:error` toasts. */
function scheduleCommit(ctx) {
  if (!ctx.git) return;
  clearTimeout(ctx.commitTimer);
  ctx.commitTimer = setTimeout(() => {
    ctx.commitTimer = null;
    withHistoryLock(ctx, () => autoCommit(ctx)).catch((err) => reportGitError(ctx, err));
  }, COMMIT_DEBOUNCE_MS);
}

/**
 * Commits all pending workspace changes; no-op when clean. A detached HEAD
 * (editing from an older commit) first gets a new `clawscad/<timestamp>` branch.
 * Subject = first-line comment of ENTRY_FILE, unless it repeats HEAD's subject.
 * Caller must hold the history lock.
 */
async function autoCommit(ctx) {
  const git = ctx.git;
  if (!git || !(await git.isDirty())) return;
  const head = await git.head();
  if (head.sha && !head.branch) await git.createBranch(newBranchName());
  const fallback = `Update ${ENTRY_FILE}`;
  let subject = extractDescription(path.join(ctx.workspaceDir, ENTRY_FILE)) || fallback;
  const previous = head.sha && ctx.history.checkpoints[head.sha];
  if (previous && previous.subject === subject) subject = fallback;
  await git.commitAll(subject, { sessionId: detectCurrentSessionId(ctx) });
  await refreshHistory(ctx);
}

function newBranchName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `clawscad/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Commits pending work, then checks out `sha`: by branch name when a local branch
 * points at it (HEAD stays attached), otherwise as a detached HEAD.
 * Unknown SHAs are ignored. Rejects with GitError if the checkout fails.
 */
async function selectCheckpoint(ctx, sha) {
  await withHistoryLock(ctx, async () => {
    const git = ctx.git;
    if (!git || !ctx.history.checkpoints[sha]) return;
    clearTimeout(ctx.commitTimer);
    ctx.commitTimer = null;
    await autoCommit(ctx);
    const head = await git.head();
    const atSha = Object.entries(await git.localBranches()).filter(([, tip]) => tip === sha).map(([name]) => name);
    const target = atSha.includes(head.branch) ? head.branch : atSha[0] || sha;
    if (target !== (head.branch || head.sha)) await git.checkout(target);
    await refreshHistory(ctx);
  });
  showCurrentModel(ctx);
}

/**
 * Deletes every local branch whose tip is `sha`, except the checked-out one.
 * @returns {Promise<string[]>} deleted branch names (empty if none qualified).
 */
function deleteBranchesAt(ctx, sha) {
  return withHistoryLock(ctx, async () => {
    const git = ctx.git;
    if (!git) return [];
    const head = await git.head();
    const names = Object.entries(await git.localBranches())
      .filter(([name, tip]) => tip === sha && name !== head.branch)
      .map(([name]) => name);
    for (const name of names) await git.deleteBranch(name);
    await refreshHistory(ctx);
    return names;
  });
}

function reportGitError(ctx, err) {
  ctxSend(ctx, 'git:error', { message: err.message });
}

function sendCheckpoints(ctx) {
  ctxSend(ctx, 'checkpoint:update', ctx.history);
}

// ── Render Cache ────────────────────────────────────────────────────────
// Renders are cached in CACHE_DIR by content, so revisiting any commit whose
// sources were rendered before needs no OpenSCAD run.

function isSourceName(name) {
  return name.endsWith('.scad') && name !== LEGACY_ACTIVE_FILE;
}

/**
 * Cache key for rendering `entry` given the top-level .scad files it may include.
 * Files in subdirectories are not part of the key.
 * @param {[string, string][]} files [name, text] pairs.
 */
function hashSources(entry, files) {
  const hash = crypto.createHash('sha1');
  hash.update(`${entry}\0`);
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, text] of sorted) hash.update(`${name}\0${text}\0`);
  return hash.digest('hex');
}

/** hashSources over the current files in `dir`; null if `dir` is unreadable. */
function modelKey(dir, entry) {
  try {
    const names = fs.readdirSync(dir).filter(isSourceName);
    return hashSources(entry, names.map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf-8')]));
  } catch {
    return null;
  }
}

function cachePath(ctx, key, format) {
  return path.join(ctx.workspaceDir, CACHE_DIR, `${key}.${format}`);
}

/** Cached render for `key` as {path, format}, preferring 3MF; null on a miss. */
function findCachedModel(ctx, key) {
  if (!key) return null;
  for (const format of ['3mf', 'stl']) {
    const p = cachePath(ctx, key, format);
    if (fs.existsSync(p)) return { path: p, format };
  }
  return null;
}

function storeCachedModel(ctx, key, outputPath, format) {
  if (!key) return;
  try {
    fs.mkdirSync(path.join(ctx.workspaceDir, CACHE_DIR), { recursive: true });
    fs.copyFileSync(outputPath, cachePath(ctx, key, format));
  } catch {}
}

function readParts(scadPath) {
  try { return parseTopLevelParts(fs.readFileSync(scadPath, 'utf-8')); } catch { return []; }
}

/** Shows ENTRY_FILE in the editor and the viewer, from the cache or via a queued render. */
function showCurrentModel(ctx) {
  const entryPath = path.join(ctx.workspaceDir, ENTRY_FILE);
  if (!fs.existsSync(entryPath)) return;
  sendFileContent(ctx, ENTRY_FILE);
  const key = modelKey(ctx.workspaceDir, ENTRY_FILE);
  const cached = findCachedModel(ctx, key);
  if (cached) sendModel(ctx, cached.path, cached.format, { modelKey: key, parts: readParts(entryPath) });
  else enqueueRender(ctx, entryPath);
}

// ── Render Queue ────────────────────────────────────────────────────────

function enqueueRender(ctx, scadPath) {
  ctx.renderQueue = ctx.renderQueue.filter((p) => p !== scadPath);
  ctx.renderQueue.push(scadPath);
  processRenderQueue(ctx);
}

function processRenderQueue(ctx) {
  if (ctx.isRendering || ctx.renderQueue.length === 0) return;
  ctx.isRendering = true;
  const scadPath = ctx.renderQueue.shift();
  // Key and parts are captured before rendering so later edits can't mislabel this output.
  const key = modelKey(path.dirname(scadPath), path.basename(scadPath));
  const parts = readParts(scadPath);
  const cached = findCachedModel(ctx, key);
  if (cached) {
    ctx.isRendering = false;
    sendModel(ctx, cached.path, cached.format, { modelKey: key, parts });
    processRenderQueue(ctx);
    return;
  }
  // A 3MF failure affects only this file; later models still retain colour.
  const format = ctx.stlFallbackFor === scadPath ? 'stl' : '3mf';
  const outputExt = format === '3mf' ? '.3mf' : '.stl';
  const outputPath = scadPath.replace(/\.scad$/, outputExt);
  // lazy-union keeps each top-level statement a separate 3MF object (one viewer part each).
  const args = format === '3mf'
    ? ['-o', outputPath, '--enable=lazy-union', scadPath]
    : ['-o', outputPath, scadPath];

  ctxSend(ctx, 'render:start', { file: path.basename(scadPath) });

  execFile(OPENSCAD_BIN, args, { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
    ctx.isRendering = false;

    const fault = classifyRenderFailure(err, outputPath);
    if (fault) {
      if (format === '3mf' && fault === 'model') {
        ctx.stlFallbackFor = scadPath;
        ctx.renderQueue.unshift(scadPath);
        processRenderQueue(ctx);
        return;
      }
      ctx.stlFallbackFor = null;
      const errorText = stderr || (err && err.message) || 'OpenSCAD produced no model';
      const errors = parseOpenSCADErrors(errorText);
      ctxSend(ctx, 'render:error', {
        file: path.basename(scadPath),
        error: errorText,
        errors,
        fault,
      });
      // Installation faults and timeouts do not mean the model needs rewriting.
      if (fault === 'model') writeRenderErrors(ctx, path.basename(scadPath), errorText, errors);
    } else {
      ctx.stlFallbackFor = null;
      if (stderr && stderr.includes('WARNING')) {
        ctxSend(ctx, 'render:warning', { file: path.basename(scadPath), warnings: stderr });
      }
      storeCachedModel(ctx, key, outputPath, format);
      sendModel(ctx, outputPath, format, { modelKey: key, parts });
      ctxSend(ctx, 'render:complete', { file: path.basename(scadPath) });
      clearRenderErrors(ctx);
    }

    processRenderQueue(ctx);
  });
}

function classifyRenderFailure(err, outputPath) {
  if (err) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(err.code)) return 'environment';
    if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return 'timeout';
    return 'model';
  }
  try {
    const output = fs.statSync(outputPath);
    return output.isFile() && output.size > 0 ? null : 'model';
  } catch {
    return 'model';
  }
}

function parseOpenSCADErrors(stderr) {
  const errors = [];
  if (!stderr) return errors;
  const regex = /(?:ERROR|WARNING):\s*(.*?)(?:\s+in file\s+"([^"]+)",\s*line\s*(\d+))?$/gm;
  let match;
  while ((match = regex.exec(stderr)) !== null) {
    errors.push({ message: match[1], file: match[2] || '', line: match[3] ? parseInt(match[3]) : 0 });
  }
  return errors;
}

function writeRenderErrors(ctx, filename, errorText, errors) {
  // Write a RENDER_ERRORS.md that Claude can read to understand what went wrong
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  const errorLines = errors.map((e) => `- Line ${e.line}: ${e.message}`).join('\n');
  fs.writeFileSync(
    errFile,
    `# Render Failed: ${filename}\n\n` +
      `The last render of \`${filename}\` failed with errors.\n` +
      `**Fix \`${filename}\` in place** — ClawSCAD re-renders it on save.\n\n` +
      `## Errors\n${errorLines || errorText}\n\n` +
      `## Raw Output\n\`\`\`\n${errorText.substring(0, 2000)}\n\`\`\`\n`
  );

  // Send a nudge to Claude's terminal — a visible prompt that there are errors to fix
  if (ctx.ptyProcess) {
    // Only nudge if Claude seems idle (don't interrupt mid-generation)
    // Write to pty so it appears in the conversation as user input
    const nudge =
      `The render of ${filename} failed. Read RENDER_ERRORS.md for details and fix ${filename}.\n`;
    // Small delay to avoid interrupting Claude mid-output
    setTimeout(() => {
      if (ctx.ptyProcess) ctx.ptyProcess.write(nudge);
    }, 2000);
  }
}

function clearRenderErrors(ctx) {
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  try { if (fs.existsSync(errFile)) fs.unlinkSync(errFile); } catch {}
}

function scadToStl(scadPath) {
  return scadPath.replace(/\.scad$/, '.stl');
}

/**
 * Sends a rendered model to the viewer.
 * @param {{modelKey?: string|null, parts?: {label: string, repeated: boolean}[]}} [meta]
 *   modelKey: render-cache key, used by the renderer as its in-memory cache id;
 *   parts: top-level statements of the source, for naming 3MF objects.
 */
function sendModel(ctx, filePath, format, { modelKey = null, parts = [] } = {}) {
  try {
    const data = fs.readFileSync(filePath);
    ctxSend(ctx, 'model:update', {
      data,
      path: filePath,
      format: format || 'stl',
      modelKey,
      parts,
    });
  } catch {}
}

function ctxSend(ctx, channel, data) {
  try {
    if (ctx.window && !ctx.window.isDestroyed() && ctx.window.webContents && !ctx.window.webContents.isDestroyed()) {
      ctx.window.webContents.send(channel, data);
    }
  } catch {
    // Window was destroyed during send — safe to ignore
  }
}

function sendFileContent(ctx, scadFilename) {
  const filePath = path.join(ctx.workspaceDir, scadFilename);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    ctxSend(ctx, 'file:content', { path: filePath, name: scadFilename, content });
  } catch {}
}

// ── Session Discovery ───────────────────────────────────────────────────

function discoverSessions(ctx) {
  const encoded = getEncodedCwd(ctx.workspaceDir);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const sessions = [];
  try {
    if (!fs.existsSync(projectDir)) return sessions;
    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const sessionId = path.basename(file, '.jsonl');
      const fp = path.join(projectDir, file);
      const stat = fs.statSync(fp);
      let firstMessage = '';
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message) {
              const msg = typeof entry.message === 'string'
                ? entry.message
                : entry.message.content || JSON.stringify(entry.message);
              firstMessage = msg.substring(0, 80);
              break;
            }
          } catch {}
        }
      } catch {}
      sessions.push({ sessionId, firstMessage, lastModified: stat.mtimeMs, date: stat.mtime.toISOString() });
    }
    sessions.sort((a, b) => b.lastModified - a.lastModified);
  } catch {}
  return sessions;
}

// ── Terminal ────────────────────────────────────────────────────────────

function spawnPty(ctx, cmd, args = []) {
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: ctx.workspaceDir,
    env: { ...process.env, COLORTERM: 'truecolor' },
  });
  proc.onData((data) => ctxSend(ctx, 'terminal:data', data));
  return proc;
}

function spawnPty2(ctx, cmd, args = []) {
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: ctx.workspaceDir,
    env: { ...process.env, COLORTERM: 'truecolor' },
  });
  proc.onData((data) => ctxSend(ctx, 'terminal2:data', data));
  return proc;
}

// Spawn a pty running the Claude Code CLI. If the binary can't be found (or
// fails to launch), drop the user into a normal shell with a hint on how to
// install it — we don't silently install global npm packages on their behalf.
function spawnClaude(ctx, args = []) {
  const bin = resolveClaude();
  if (bin) {
    try { return spawnPty(ctx, bin, args); } catch {}
  }
  const proc = spawnPty(ctx, DEFAULT_SHELL, []);
  ctxSend(ctx, 'terminal:data',
    '\r\n\x1b[33mClaude Code CLI not found.\x1b[0m Install it from ' +
    'https://docs.claude.com/en/docs/claude-code/setup then restart the terminal.\r\n\r\n');
  return proc;
}

function startTerminal(ctx) {
  ctx.ptyProcess = spawnClaude(ctx, []);
  ctx.ptyProcess.onExit(() => {
    ctx.ptyProcess = spawnPty(ctx, DEFAULT_SHELL, []);
    ctx.ptyProcess.onExit(() => {});
  });
}

function restartTerminal(ctx, args = []) {
  if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
  ctx.ptyProcess = spawnClaude(ctx, args);
  ctx.ptyProcess.onExit(() => {
    ctx.ptyProcess = spawnPty(ctx, DEFAULT_SHELL, []);
    ctx.ptyProcess.onExit(() => {});
  });
}

// ── File Watcher ────────────────────────────────────────────────────────

function startFileWatcher(ctx) {
  ctx.fileWatcher = chokidar.watch(ctx.workspaceDir, {
    ignored: /(^|[/\\])(\.|node_modules|clawscad\.json)/,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });
  ctx.fileWatcher.on('add', (fp) => handleFileEvent(ctx, fp));
  ctx.fileWatcher.on('change', (fp) => handleFileEvent(ctx, fp));
  ctx.fileWatcher.on('error', (err) => {
    console.warn(`File watcher error for ${ctx.workspaceDir}:`, err.message);
  });
}

// Any .scad change (entry or an included helper) re-renders ENTRY_FILE and
// schedules a commit. Checkouts trigger this too; the commit is then a no-op.
function handleFileEvent(ctx, filePath) {
  const basename = path.basename(filePath);
  if (path.extname(basename).toLowerCase() !== '.scad' || basename === LEGACY_ACTIVE_FILE) return;
  showCurrentModel(ctx);
  scheduleCommit(ctx);
}

// ── IPC Handlers ────────────────────────────────────────────────────────

ipcMain.on('terminal:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) ctx.ptyProcess.write(data);
});

ipcMain.handle('terminal2:spawn', (event) => {
  const ctx = getCtx(event);
  if (!ctx || ctx.ptyProcess2) return;
  try {
    ctx.ptyProcess2 = spawnPty2(ctx, resolveClaude() || 'claude', []);
  } catch {
    ctx.ptyProcess2 = spawnPty2(ctx, DEFAULT_SHELL, []);
  }
  ctx.ptyProcess2.onExit(() => { ctx.ptyProcess2 = null; });
});

ipcMain.handle('terminal2:kill', (event) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) {
    try { ctx.ptyProcess2.kill(); } catch {}
    ctx.ptyProcess2 = null;
  }
});

ipcMain.on('terminal2:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) ctx.ptyProcess2.write(data);
});

ipcMain.on('terminal2:resize', (event, { cols, rows }) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) try { ctx.ptyProcess2.resize(cols, rows); } catch {}
});

ipcMain.on('terminal:resize', (event, { cols, rows }) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) try { ctx.ptyProcess.resize(cols, rows); } catch {}
});

ipcMain.handle('workspace:get', (event) => {
  const ctx = getCtx(event);
  return ctx ? ctx.workspaceDir : '';
});

ipcMain.handle('file:read', (_, filePath) => {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
});

ipcMain.handle('file:read-model', (_, filePath, format) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return { data, format };
  } catch {
    return null;
  }
});

ipcMain.handle('file:save', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return true; } catch { return false; }
});

ipcMain.handle('checkpoint:list', (event) => {
  const ctx = getCtx(event);
  return ctx ? ctx.history : emptyHistory(null);
});

ipcMain.handle('checkpoint:refresh', async (event) => {
  const ctx = getCtx(event);
  if (ctx) await refreshHistory(ctx).catch((err) => reportGitError(ctx, err));
});

ipcMain.handle('sessions:list', (event) => {
  const ctx = getCtx(event);
  return ctx ? discoverSessions(ctx) : [];
});

ipcMain.handle('sessions:new', (event) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, []);
});

ipcMain.handle('sessions:continue', (event) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, ['--continue']);
});

ipcMain.handle('sessions:resume', (event, sessionId) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, ['--resume', sessionId]);
});

ipcMain.handle('checkpoint:select', async (event, id) => {
  const ctx = getCtx(event);
  if (ctx) await selectCheckpoint(ctx, id).catch((err) => reportGitError(ctx, err));
});

ipcMain.handle('checkpoint:restore-session', (event, id) => {
  const ctx = getCtx(event);
  if (!ctx) return false;
  const cp = ctx.history.checkpoints[id];
  if (cp && cp.sessionId) {
    restartTerminal(ctx, ['--resume', cp.sessionId]);
    return true;
  }
  return false;
});

// Display-only rename; commit messages are never rewritten.
ipcMain.handle('checkpoint:rename', (event, id, label) => {
  const ctx = getCtx(event);
  if (ctx && ctx.history.checkpoints[id]) {
    ctx.state.labels[id] = label;
    ctx.history.checkpoints[id].label = label;
    saveState(ctx);
    sendCheckpoints(ctx);
  }
});

ipcMain.handle('checkpoint:delete', async (event, id) => {
  const ctx = getCtx(event);
  if (!ctx) return [];
  return deleteBranchesAt(ctx, id).catch((err) => {
    reportGitError(ctx, err);
    return [];
  });
});

// Source and cached render of a commit, without touching the working tree.
ipcMain.handle('checkpoint:get', async (event, id) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.git || !ctx.history.checkpoints[id]) return null;
  try {
    const names = (await ctx.git.listFiles(id)).filter(isSourceName);
    const files = [];
    for (const name of names) files.push([name, await ctx.git.showFile(id, name)]);
    const source = (files.find(([name]) => name === ENTRY_FILE) || [])[1] ?? null;
    const cached = findCachedModel(ctx, hashSources(ENTRY_FILE, files));
    return {
      file: ENTRY_FILE,
      source,
      data: cached ? fs.readFileSync(cached.path) : null,
      format: cached ? cached.format : null,
      parts: source ? parseTopLevelParts(source) : [],
    };
  } catch (err) {
    reportGitError(ctx, err);
    return null;
  }
});

ipcMain.handle('git:push', async (event) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.git) return { error: ctx && ctx.history.gitError ? ctx.history.gitError : 'git is not available' };
  try {
    await withHistoryLock(ctx, async () => {
      clearTimeout(ctx.commitTimer);
      ctx.commitTimer = null;
      await autoCommit(ctx);
      await ctx.git.push();
    });
    await refreshHistory(ctx);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ── MCP Direct Access ───────────────────────────────────────────────────

ipcMain.handle('mcp:render-png', async (event, scadCode, opts) => {
  try {
    return await mcpClient.renderPng(scadCode, opts);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mcp:export-stl', async (event, scadCode, filename) => {
  try {
    return await mcpClient.exportStl(scadCode, filename);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mcp:status', async () => {
  return { ready: mcpClient.ready };
});

ipcMain.handle('render:force', (event) => {
  const ctx = getCtx(event);
  if (!ctx) return;
  const scadPath = path.join(ctx.workspaceDir, ENTRY_FILE);
  if (!fs.existsSync(scadPath)) return;
  // Drop the cached and stale outputs so it re-renders fresh
  const key = modelKey(ctx.workspaceDir, ENTRY_FILE);
  const stale = [scadToStl(scadPath), scadPath.replace(/\.scad$/, '.3mf')];
  if (key) stale.push(cachePath(ctx, key, '3mf'), cachePath(ctx, key, 'stl'));
  for (const p of stale) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  enqueueRender(ctx, scadPath);
});

/** Commits pending work of the current workspace, then rebinds the window to `dir`. */
async function switchWorkspace(ctx, dir) {
  clearTimeout(ctx.commitTimer);
  ctx.commitTimer = null;
  await withHistoryLock(ctx, () => autoCommit(ctx)).catch(() => {});
  if (ctx.fileWatcher) ctx.fileWatcher.close();
  if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
  ctx.workspaceDir = dir;
  activateWorkspace(ctx);
  updateAllClaudeMd();
  await ctx.historyReady;
  sendCheckpoints(ctx);
  showCurrentModel(ctx);
}

ipcMain.handle('app:new-project-window', async (event) => {
  if (windows.size >= MAX_WINDOWS) return null;
  const ctx = getCtx(event);
  // Default to current workspace name + "-2"
  const currentBase = ctx ? path.basename(ctx.workspaceDir) : 'clawscad-workspace';
  const defaultDir = path.join(
    ctx ? path.dirname(ctx.workspaceDir) : os.homedir(),
    currentBase + '-2'
  );
  const result = await dialog.showOpenDialog(ctx ? ctx.window : null, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'New Project Workspace',
    defaultPath: defaultDir,
  });
  if (!result.canceled && result.filePaths[0]) {
    openWindow(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('app:open-workspace', async (event) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  const result = await dialog.showOpenDialog(ctx.window, {
    properties: ['openDirectory'],
    title: 'Open Workspace',
  });
  if (!result.canceled && result.filePaths[0]) {
    await switchWorkspace(ctx, result.filePaths[0]);
    return ctx.workspaceDir;
  }
  return null;
});

ipcMain.handle('app:open-workspace-in-files', (event) => {
  const ctx = getCtx(event);
  if (ctx) shell.openPath(ctx.workspaceDir);
});

ipcMain.handle('app:get-print-settings-path', (event) => {
  const ctx = getCtx(event);
  return ctx ? path.join(ctx.workspaceDir, 'clawscad.json') : '';
});

ipcMain.handle('app:export', async (event, format) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  const scadPath = path.join(ctx.workspaceDir, ENTRY_FILE);
  if (!fs.existsSync(scadPath)) return null;

  const filters = {
    stl: [{ name: 'STL', extensions: ['stl'] }],
    '3mf': [{ name: '3MF', extensions: ['3mf'] }],
    png: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const ext = format === 'png' ? '.png' : format === '3mf' ? '.3mf' : '.stl';
  const defaultName = ENTRY_FILE.replace(/\.scad$/, ext);

  const result = await dialog.showSaveDialog(ctx.window, {
    title: `Export as ${format.toUpperCase()}`,
    defaultPath: path.join(ctx.workspaceDir, defaultName),
    filters: filters[format] || filters.stl,
  });
  if (result.canceled) return null;

  // 3MF keeps top-level parts as separate objects, so slicers can arrange them individually.
  const args = format === 'png'
    ? ['--imgsize=1920,1080', '-o', result.filePath, scadPath]
    : format === '3mf'
      ? ['-o', result.filePath, '--enable=lazy-union', scadPath]
      : ['-o', result.filePath, scadPath];

  return new Promise((resolve) => {
    execFile(OPENSCAD_BIN, args, { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ path: result.filePath });
      }
    });
  });
});

// Recent paths management
const recentPathsFile = path.join(app.getPath('userData'), 'recent-workspaces.json');

function loadRecentPaths() {
  try {
    if (fs.existsSync(recentPathsFile)) {
      return JSON.parse(fs.readFileSync(recentPathsFile, 'utf-8')).slice(0, 20);
    }
  } catch {}
  return [];
}

function addRecentPath(wsPath) {
  let recent = loadRecentPaths();
  recent = recent.filter((p) => p !== wsPath);
  recent.unshift(wsPath);
  recent = recent.slice(0, 20);
  fs.writeFileSync(recentPathsFile, JSON.stringify(recent, null, 2));
}

ipcMain.handle('app:list-recent', () => loadRecentPaths());

ipcMain.handle('app:browse-dir', (_, dirPath) => {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return null;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];
    // Parent directory
    const parent = path.dirname(dirPath);
    if (parent !== dirPath) result.push({ name: '..', path: parent, isDir: true });
    // Directories first, then .scad files
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) result.push({ name: e.name + '/', path: path.join(dirPath, e.name), isDir: true });
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.scad')) {
        result.push({ name: e.name, path: path.join(dirPath, e.name), isDir: false });
      }
    }
    return { dir: dirPath, entries: result };
  } catch {
    return null;
  }
});

ipcMain.handle('app:open-path', async (event, inputPath) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  try {
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      await switchWorkspace(ctx, inputPath);
      addRecentPath(inputPath);
      return { type: 'workspace', path: inputPath };
    } else if (stat.isFile() && inputPath.endsWith('.scad')) {
      // Imported source replaces the model; the previous version stays in git history.
      clearTimeout(ctx.commitTimer);
      ctx.commitTimer = null;
      await withHistoryLock(ctx, () => autoCommit(ctx)).catch(() => {});
      const dest = path.join(ctx.workspaceDir, ENTRY_FILE);
      fs.copyFileSync(inputPath, dest);
      return { type: 'file', path: dest };
    }
  } catch {}
  return null;
});

ipcMain.handle('app:toggle-devtools', (event) => {
  const ctx = getCtx(event);
  if (ctx) ctx.window.webContents.toggleDevTools();
});

ipcMain.handle('app:window-count', () => windows.size);

// ── App Lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Start the MCP server early so it's warm by the time we need it
  mcpClient.start().catch(() => {});

  const cliArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const wsDir = cliArg ? path.resolve(cliArg) : path.join(os.homedir(), 'clawscad-workspace');
  openWindow(wsDir);
});

app.on('window-all-closed', () => {
  mcpClient.stop();
  app.quit();
});
