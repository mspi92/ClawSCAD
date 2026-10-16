<p align="center">
  <img src="icon.png" alt="ClawSCAD" width="128" height="128">
</p>

<h1 align="center">ClawSCAD</h1>

<p align="center">
  <strong>AI-powered 3D CAD environment</strong><br>
  OpenSCAD + Claude Code with checkpoint branching, auto-iteration, and multi-viewport support
</p>

<p align="center">
  <img src="screenshot.png" alt="ClawSCAD Screenshot" width="900">
</p>

---

## What is ClawSCAD?

ClawSCAD glues together [OpenSCAD](https://openscad.org/) and [Claude Code](https://github.com/anthropics/claude-code) into a single desktop application. Tell Claude what to build, and it writes OpenSCAD code, renders it, validates the output, and auto-iterates until the model is correct — all while you watch in a live 3D viewport.

The workspace is a git repository: Claude edits a single `model.scad`, and every change is committed automatically. Click any commit to go back; editing from there starts a new branch, so you can explore different design directions and push the whole history to GitHub or GitLab.

## Features

**3D Viewport**
- PBR rendering with environment-mapped reflections
- Orbit, pan, zoom (mouse + touch + keyboard)
- Wireframe, edge overlay, orthographic/perspective toggle
- 7 camera presets (Front/Back/Left/Right/Top/Bottom/Iso)
- Click any part to see dimensions, volume, weight, estimated print cost
- Parts panel: every top-level statement is a separate, named part you can hide, show, or solo (double-click)
- 6 customizable color swatches for instant model coloring
- Screenshot export
- Split viewport — open a second 3D view with independent camera

**Git History**
- Changes to `model.scad` are auto-committed (debounced); the first-line comment is the commit message
- The History panel shows `git log --all` as a flat, newest-first table with a lane graph and branch badges
- Click any commit to check it out; renders are cached by content, so revisits are instant
- Editing from an older commit creates a `clawscad/<timestamp>` branch automatically
- Push button runs `git push -u origin HEAD` with your normal git remote and credentials
- Right-click context menu: rename (display only), delete branch, view source, resume session
- Commits made outside the app (pull, terminal) show up when the window regains focus
- Requires `git` on PATH; a workspace already tracked by an enclosing repo commits into that repo, scoped to the workspace folder

**Source Editor**
- Monaco editor with OpenSCAD syntax highlighting (Monarch grammar)
- Custom dark theme matching the app
- Find (Ctrl+F) and Replace (Ctrl+H)
- Read-only by default, toggle to edit mode
- OpenSCAD error markers (red squiggles on error lines)

**Claude Code Integration**
- Embedded terminal running Claude Code
- OpenSCAD MCP server auto-configured for every workspace
- CLAUDE.md with mandatory rules: edit `model.scad` in place, one top-level statement per part, use colors, validate with MCP tools
- Auto-iteration: when a render fails, ClawSCAD writes errors to RENDER_ERRORS.md and nudges Claude to fix them
- Session management: browse, resume, or start new Claude sessions
- Dual terminal support (up to 2 Claude instances)
- Multi-window support (up to 4 projects, Claude sees all workspaces)

**Export**
- STL, 3MF, and PNG export buttons in the header
- 3MF export preserves per-part colors (when OpenSCAD supports it) and keeps top-level parts as separate objects
- Print cost estimation with configurable infill, material, and cost/kg

## Install

```bash
git clone https://github.com/levkropp/ClawSCAD.git
cd ClawSCAD
npm install
npm start
```

**Prerequisites:**
- [Node.js](https://nodejs.org/) 18+
- [OpenSCAD](https://openscad.org/downloads.html) installed and in PATH (or set `OPENSCAD_BINARY` env var)
- [Claude Code](https://github.com/anthropics/claude-code) installed globally: `npm install -g @anthropic-ai/claude-code`
- [git](https://git-scm.com/) in PATH (for the history panel)

## Usage

1. Launch ClawSCAD — it creates a workspace at `~/clawscad-workspace/`
2. Claude Code starts in the terminal panel on the right
3. Tell Claude what to build: *"Make a gear with 20 teeth and a shaft hole"*
4. Claude edits `model.scad`, ClawSCAD auto-renders it in the 3D viewport and commits the change
5. If the render fails, ClawSCAD tells Claude to fix it automatically
6. Click any commit in the History panel to go back; the next change branches from there
7. Use the color swatches to try different colors instantly
8. Export to STL/3MF when you're happy with the design

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New viewport (split view) |
| `Ctrl+F` | Find in source editor |
| `Ctrl+H` | Find and replace |
| `F5` | Force re-render |
| `1`-`7` | Camera presets (when viewport focused) |
| `R` | Reset view |
| `F` | Zoom to fit |
| `W` | Toggle wireframe |
| `E` | Toggle edges |
| `O` | Toggle ortho/perspective |
| `+`/`-` | Zoom in/out |
| `Escape` | Deselect part |

## Architecture

```
ClawSCAD
├── main.js          Electron main process — multi-window, git history, render queue + cache, MCP client
├── git.js           Git CLI wrapper scoped to the workspace (commit, log, checkout, branch, push)
├── scad-parts.js    Top-level statement parser that names the parts of a lazy-union render
├── renderer.js      3D viewport (three.js), parts panel, terminal (xterm.js), editor (Monaco), history tree
├── preload.js       IPC bridge between main and renderer
├── index.html       Layout
├── style.css        Dark theme
└── icon.png         App icon
```

- **Rendering**: OpenSCAD CLI (`openscad -o output.3mf --enable=lazy-union input.scad`), tries 3MF first (preserves colors, one object per top-level statement), falls back to STL; outputs cached in `.clawscad/cache/` by source hash
- **3D engine**: three.js with MeshStandardMaterial, RoomEnvironment, EdgesGeometry, raycaster picking
- **Terminal**: xterm.js + node-pty, spawns `claude` directly
- **Editor**: Monaco with custom Monarch grammar for OpenSCAD
- **MCP**: Spawns `openscad-mcp-server` as a JSON-RPC subprocess for direct render/validate access

## License

MIT — see [LICENSE](LICENSE).

OpenSCAD (GPLv2+) and Claude Code (Apache 2.0) are launched as separate subprocesses. ClawSCAD does not incorporate or link against code from either project.
