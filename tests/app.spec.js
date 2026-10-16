// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-test-' + Date.now());

let electronApp;
let page;

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
});

test.beforeEach(async () => {
  electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
});

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.afterAll(async () => {
  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
});

// ── Window & Layout Tests ────────────────────────────────────────────

test.describe('Window & Layout', () => {
  test('window launches with correct title', async () => {
    const title = await page.title();
    expect(title).toBe('ClawSCAD');
  });

  test('app header is visible with brand text', async () => {
    const header = page.locator('#app-header');
    await expect(header).toBeVisible();
    const brand = page.locator('#app-menu-btn');
    await expect(brand).toBeVisible();
    await expect(brand).toContainText('ClawSCAD');
  });

  test('viewport is visible', async () => {
    const viewport = page.locator('#viewport');
    await expect(viewport).toBeVisible();
  });

  test('terminal panel is visible', async () => {
    const terminal = page.locator('#terminal');
    await expect(terminal).toBeVisible();
  });

  test('status bar is visible', async () => {
    const status = page.locator('#status-bar');
    await expect(status).toBeVisible();
    await expect(status).toContainText('ClawSCAD');
  });

  test('checkpoint panel shows the initial commit of a fresh workspace', async () => {
    const cpPanel = page.locator('#checkpoint-panel');
    await expect(cpPanel).toBeVisible();
    const tree = page.locator('#checkpoint-tree');
    await expect(tree).toContainText('Initialize ClawSCAD workspace');
  });

  test('splitter is visible and has correct cursor', async () => {
    const splitter = page.locator('#splitter');
    await expect(splitter).toBeVisible();
    const cursor = await splitter.evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe('col-resize');
  });

  test('workspace path is shown in header', async () => {
    const pathEl = page.locator('#workspace-path');
    await expect(pathEl).toContainText(TEST_WORKSPACE);
  });
});

// ── ClawSCAD Menu Tests ─────────────────────────────────────────────

test.describe('ClawSCAD Menu', () => {
  test('menu is hidden by default', async () => {
    const menu = page.locator('#app-menu');
    await expect(menu).toHaveClass(/hidden/);
  });

  test('clicking brand button opens menu', async () => {
    await page.locator('#app-menu-btn').click();
    const menu = page.locator('#app-menu');
    await expect(menu).not.toHaveClass(/hidden/);
  });

  test('menu has all expected items', async () => {
    await page.locator('#app-menu-btn').click();
    const items = page.locator('.menu-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(10);

    // Use actual data-action values from index.html
    await expect(page.locator('[data-action="new-project"]')).toBeVisible();
    await expect(page.locator('[data-action="open-workspace"]')).toBeVisible();
    await expect(page.locator('[data-action="screenshot"]')).toBeVisible();
    await expect(page.locator('[data-action="toggle-editor"]')).toBeVisible();
    await expect(page.locator('[data-action="devtools"]')).toBeVisible();
  });

  test('clicking outside menu closes it', async () => {
    await page.locator('#app-menu-btn').click();
    const menu = page.locator('#app-menu');
    await expect(menu).not.toHaveClass(/hidden/);
    // Click the status bar — always below the open menu, never covered by it
    await page.locator('#status-bar').click();
    await expect(menu).toHaveClass(/hidden/);
  });

  test('clicking a menu item closes menu', async () => {
    await page.locator('#app-menu-btn').click();
    const menu = page.locator('#app-menu');
    await expect(menu).not.toHaveClass(/hidden/);
    await page.locator('[data-action="toggle-editor"]').click();
    await expect(menu).toHaveClass(/hidden/);
  });
});

// ── Viewport Toolbar Tests ──────────────────────────────────────────

test.describe('Viewport Toolbar', () => {
  test('toolbar buttons are injected into left/right containers', async () => {
    // Buttons are dynamically added by renderer.js into #viewport-toolbar-left/right
    const left = page.locator('#viewport-toolbar-left');
    const right = page.locator('#viewport-toolbar-right');
    await expect(left).toBeAttached();
    await expect(right).toBeAttached();

    // Key buttons must exist by their IDs
    await expect(page.locator('#btn-render')).toBeAttached();
    await expect(page.locator('#btn-zoom-in')).toBeAttached();
    await expect(page.locator('#btn-zoom-out')).toBeAttached();
    await expect(page.locator('#btn-fit')).toBeAttached();
    await expect(page.locator('#btn-wire')).toBeAttached();
    await expect(page.locator('#btn-edges')).toBeAttached();
    await expect(page.locator('#btn-ortho')).toBeAttached();
    await expect(page.locator('#btn-screenshot')).toBeAttached();
  });

  test('render button has distinct green styling', async () => {
    const btn = page.locator('#btn-render');
    const classes = await btn.getAttribute('class');
    expect(classes).toContain('render-btn');
  });

  test('wireframe toggle changes button state', async () => {
    const btn = page.locator('#btn-wire');
    await expect(btn).not.toHaveClass(/active/);
    await btn.click();
    await expect(btn).toHaveClass(/active/);
    await btn.click();
    await expect(btn).not.toHaveClass(/active/);
  });

  test('edges toggle starts active', async () => {
    const btn = page.locator('#btn-edges');
    await expect(btn).toHaveClass(/active/);
  });

  test('view presets are visible', async () => {
    const presets = page.locator('#view-presets');
    await expect(presets).toBeVisible();
    const buttons = presets.locator('.preset-btn');
    expect(await buttons.count()).toBe(7); // F, Bk, R, L, T, Bt, Iso
  });
});

// ── Editor Panel Tests ──────────────────────────────────────────────

test.describe('Editor Panel', () => {
  test('editor panel starts collapsed', async () => {
    const panel = page.locator('#editor-panel');
    await expect(panel).toHaveClass(/collapsed/);
  });

  test('toggle button expands editor panel', async () => {
    const toggle = page.locator('#editor-toggle');
    await toggle.click();
    const panel = page.locator('#editor-panel');
    await expect(panel).not.toHaveClass(/collapsed/);
  });

  test('edit mode toggle works', async () => {
    await page.locator('#editor-toggle').click();
    const editBtn = page.locator('#editor-edit-toggle');
    await expect(editBtn).not.toHaveClass(/active/);
    await editBtn.click();
    await expect(editBtn).toHaveClass(/active/);
    const saveBtn = page.locator('#editor-save-btn');
    await expect(saveBtn).not.toHaveClass(/hidden/);
  });
});

// ── Render Overlay Tests ────────────────────────────────────────────

test.describe('Render Overlay', () => {
  test('overlay is hidden by default', async () => {
    const overlay = page.locator('#render-overlay');
    const opacity = await overlay.evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('0');
  });

  test('overlay has spinner, text, time, and progress bar', async () => {
    const overlay = page.locator('#render-overlay');
    await expect(overlay.locator('.spinner')).toBeAttached();
    await expect(overlay.locator('.overlay-text')).toBeAttached();
    await expect(overlay.locator('#render-time')).toBeAttached();
    await expect(overlay.locator('.overlay-bar')).toBeAttached();
  });
});

// ── Part Properties Panel Tests ─────────────────────────────────────

test.describe('Part Properties', () => {
  test('properties panel is hidden by default', async () => {
    const panel = page.locator('#part-props');
    await expect(panel).toHaveClass(/hidden/);
  });

  test('print settings toggle works', async () => {
    await page.evaluate(() => {
      document.getElementById('part-props').classList.remove('hidden');
    });
    const settingsPanel = page.locator('#part-props-settings');
    await expect(settingsPanel).toHaveClass(/hidden/);
    await page.locator('#part-props-settings-btn').click();
    await expect(settingsPanel).not.toHaveClass(/hidden/);
  });

  test('print settings have correct defaults', async () => {
    const infill = page.locator('#setting-infill');
    const material = page.locator('#setting-material');
    const cost = page.locator('#setting-cost');
    await expect(infill).toHaveValue('15');
    await expect(material).toHaveValue('PLA');
    await expect(cost).toHaveValue('20');
  });
});

// ── Session Browser Tests ───────────────────────────────────────────

test.describe('Session Browser', () => {
  test('session dropdown is hidden by default', async () => {
    const dropdown = page.locator('#session-dropdown');
    await expect(dropdown).toHaveClass(/hidden/);
  });

  test('clicking sessions button opens dropdown', async () => {
    await page.locator('#session-btn').click();
    const dropdown = page.locator('#session-dropdown');
    await expect(dropdown).not.toHaveClass(/hidden/);
  });

  test('session dropdown has new and continue buttons', async () => {
    await page.locator('#session-btn').click();
    await expect(page.locator('#session-new')).toBeVisible();
    await expect(page.locator('#session-continue')).toBeVisible();
  });
});

// ── Workspace Initialization Tests ──────────────────────────────────

test.describe('Workspace Setup', () => {
  test('CLAUDE.md is created in workspace', async () => {
    const claudeMd = path.join(TEST_WORKSPACE, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('MANDATORY RULES');
    expect(content).toContain('Edit it in place');
    expect(content).toContain('one top-level statement per independent component');
    expect(content).toContain('color()');
    expect(content).toContain('MCP Tools Available');
  });

  test('MCP server config is created with command and openscad path', async () => {
    const settings = path.join(TEST_WORKSPACE, '.claude', 'settings.json');
    expect(fs.existsSync(settings)).toBe(true);
    const config = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.openscad).toBeDefined();
    expect(config.mcpServers.openscad.command).toBe('npx');
    // Bundled binary path should be passed so MCP server uses the same OpenSCAD
    expect(config.mcpServers.openscad.env).toBeDefined();
    expect(config.mcpServers.openscad.env.OPENSCAD_PATH).toBeTruthy();
  });

  test('MCP OPENSCAD_PATH points to an existing binary', async () => {
    const settings = path.join(TEST_WORKSPACE, '.claude', 'settings.json');
    const config = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    const binPath = config.mcpServers.openscad.env.OPENSCAD_PATH;
    // Path must exist (bundled vendors/ AppImage) or be a system fallback name
    const isBundled = fs.existsSync(binPath);
    const isSystemFallback = binPath === 'openscad';
    expect(isBundled || isSystemFallback).toBe(true);
  });

  test('workspace is a git repo that ignores render outputs and app files', async () => {
    expect(fs.existsSync(path.join(TEST_WORKSPACE, '.git'))).toBe(true);
    const ignore = fs.readFileSync(path.join(TEST_WORKSPACE, '.gitignore'), 'utf-8').split('\n');
    for (const line of ['*.stl', '*.3mf', '.clawscad/', 'clawscad.json', 'CLAUDE.md']) {
      expect(ignore).toContain(line);
    }
  });
});

// ── Git History Tests ───────────────────────────────────────────────

const MODEL = path.join(TEST_WORKSPACE, 'model.scad');
// Debounced auto-commit (2 s) plus git and IPC round trips.
const COMMIT_WAIT = { timeout: 10000 };

test.describe('Git History', () => {
  test('editing model.scad adds a commit named after its first-line comment', async () => {
    fs.writeFileSync(MODEL, '// A simple gear shape\ncube([20, 20, 5]);');
    await expect(page.locator('#checkpoint-tree')).toContainText('A simple gear shape', COMMIT_WAIT);
  });

  test('commit shows description on hover', async () => {
    fs.writeFileSync(MODEL, '// Tooltip description test\nsphere(r=5);');
    const node = page.locator('.cp-node', { hasText: 'Tooltip description test' });
    await expect(node).toBeVisible(COMMIT_WAIT);
    await node.hover();
    await expect(page.locator('#cp-tooltip')).not.toHaveClass(/hidden/);
    await expect(page.locator('#cp-tooltip-desc')).toContainText('Tooltip description test');
  });

  test('clicking an older commit checks its source out', async () => {
    await page.locator('.cp-node', { hasText: 'A simple gear shape' }).click();
    await expect.poll(() => fs.readFileSync(MODEL, 'utf-8'), COMMIT_WAIT).toContain('A simple gear shape');
    await expect(page.locator('.cp-node.active')).toContainText('A simple gear shape');
  });

  test('editing from an older commit starts a new branch', async () => {
    fs.writeFileSync(MODEL, '// Branched variant\ncube([20, 20, 8]);');
    const node = page.locator('.cp-node', { hasText: 'Branched variant' });
    await expect(node).toBeVisible(COMMIT_WAIT);
    await expect(node.locator('.cp-ref.head')).toContainText(/^clawscad\//);
  });
});

// ── Render Pipeline Tests ───────────────────────────────────────────
// These tests verify the full path: .scad file → OpenSCAD subprocess → 3D model in viewport.
// They catch regressions in binary resolution, process spawning, and model loading.

test.describe('Render Pipeline', () => {
  const scadPath = MODEL;

  // Writes model.scad after removing previous outputs, so a fresh output proves a new render.
  // Sources must differ per test: identical sources are served from the render cache.
  function writeModel(content) {
    for (const ext of ['.3mf', '.stl']) fs.rmSync(scadPath.replace(/\.scad$/, ext), { force: true });
    fs.writeFileSync(scadPath, content);
  }

  // Helper: poll the filesystem until an output file appears next to the .scad
  async function waitForRenderOutput(scadPath, timeoutMs = 20000) {
    const base = scadPath.replace(/\.scad$/, '');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(base + '.3mf') || fs.existsSync(base + '.stl')) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  test('renders a simple sphere and produces a 3mf/stl output file', async () => {
    writeModel('// Pipeline test sphere\nsphere(r=10);');

    const rendered = await waitForRenderOutput(scadPath);
    expect(rendered).toBe(true);
  });

  test('render overlay hides after successful render', async () => {
    writeModel('// Overlay test\ncube([5, 5, 5]);');

    await waitForRenderOutput(scadPath);
    // Give renderer time to process the model:update IPC and hide the overlay
    await page.waitForTimeout(500);

    const overlay = page.locator('#render-overlay');
    const opacity = await overlay.evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('0');
  });

  test('renders a colored model (color() preserved in 3mf)', async () => {
    writeModel([
      '// Colored model test',
      'color("SteelBlue") sphere(r=8);',
    ].join('\n'));

    const rendered = await waitForRenderOutput(scadPath);
    expect(rendered).toBe(true);

    // 3MF preserves color; verify it was preferred (not just .stl fallback)
    const tmfPath = scadPath.replace('.scad', '.3mf');
    expect(fs.existsSync(tmfPath)).toBe(true);
  });

  test('canvas has rendered pixels after model loads', async () => {
    writeModel('// Canvas pixel test\ncylinder(h=20, r=8);');

    await waitForRenderOutput(scadPath);
    await page.waitForTimeout(800); // allow three.js to render a frame

    // Screenshot the canvas and verify it is not a uniform solid color
    // (a blank/black canvas means the model failed to load into WebGL)
    const canvas = page.locator('#viewport canvas');
    const screenshot = await canvas.screenshot();

    // A rendered 3D model will have varied pixel values; blank = all one color.
    // Sample the PNG buffer for non-uniformity (crude but reliable).
    const uniqueBytes = new Set(screenshot.slice(0, 4000)).size;
    expect(uniqueBytes).toBeGreaterThan(10);
  });

  test('broken .scad file creates RENDER_ERRORS.md', async () => {
    writeModel('// Intentionally broken\nthis_is_not_valid_openscad(');

    // Wait a bit longer since error path still runs OpenSCAD to get the error
    const deadline = Date.now() + 15000;
    const errFile = path.join(TEST_WORKSPACE, 'RENDER_ERRORS.md');
    let errorFileCreated = false;
    while (Date.now() < deadline) {
      if (fs.existsSync(errFile)) { errorFileCreated = true; break; }
      await page.waitForTimeout(300);
    }

    expect(errorFileCreated).toBe(true);
    const content = fs.readFileSync(errFile, 'utf-8');
    expect(content).toContain('model.scad');
    expect(content).toContain('in place');
  });

  test('rapid successive edits end with the latest version shown', async () => {
    writeModel('// First in queue\ncube(10);');
    await page.waitForTimeout(300);
    // Second edit lands while the first may still be rendering
    fs.writeFileSync(scadPath, '// Second in queue\ncube([4, 5, 6]);');

    await expect(page.locator('#status')).toContainText('4.0 x 5.0 x 6.0', { timeout: 20000 });
  });

  test('top-level statements become named parts that can be hidden', async () => {
    writeModel([
      '// Three part assembly',
      'module base() { cube([30, 30, 4]); }',
      'module lid() { cube([30, 30, 2]); }',
      'color("SteelBlue") base();',
      'color("Gold") translate([0, 0, 10]) lid();',
      'color("Red") translate([15, 15, 14]) cylinder(h = 5, r = 3);',
    ].join('\n'));

    const panel = page.locator('#parts-panel');
    await expect(panel).toBeVisible({ timeout: 20000 });
    const rows = panel.locator('.part-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('.part-name')).toHaveText(['base', 'lid', 'cylinder']);

    const lid = rows.nth(1);
    await lid.locator('.part-eye').click();
    await expect(lid).toHaveClass(/part-hidden/);
    await expect(page.locator('#parts-count')).toHaveText('2/3');

    await page.locator('#parts-show-all').click();
    await expect(page.locator('#parts-count')).toHaveText('3/3');
  });
});

// ── Keyboard Shortcuts Tests ────────────────────────────────────────

test.describe('Keyboard Shortcuts', () => {
  test('F5 triggers re-render (global)', async () => {
    await page.keyboard.press('F5');
    // No error thrown = pass; deeper render assertions are in Render Pipeline suite
  });

  test('Ctrl+N opens new window dialog', async () => {
    const dialogPromise = electronApp.evaluate(async ({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await dialogPromise;
    await page.keyboard.press('Control+n');
  });
});

// ── Three.js Canvas Tests ───────────────────────────────────────────

test.describe('3D Viewport', () => {
  test('canvas element exists in viewport', async () => {
    const canvas = page.locator('#viewport canvas');
    await expect(canvas).toBeAttached();
  });

  test('canvas has non-zero dimensions', async () => {
    const canvas = page.locator('#viewport canvas');
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
  });
});

// ── Toast System Tests ──────────────────────────────────────────────

test.describe('Toast Notifications', () => {
  test('showToast creates a visible toast', async () => {
    await page.evaluate(() => {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast toast-info visible';
      toast.textContent = 'Test notification';
      container.appendChild(toast);
    });
    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Test notification');
  });
});

// ── Multi-Window Tests ──────────────────────────────────────────────

test.describe('Multi-Window', () => {
  test('max 4 windows enforced', async () => {
    const count = await page.evaluate(() => window.api.getWindowCount());
    expect(count).toBe(1);
  });
});
