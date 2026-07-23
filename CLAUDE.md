# MKD Dashboard — Claude Instructions

## Architecture

### System overview

MKD Dashboard is a personal workspace dashboard: a Node/Express server (`server.js`) that reads and writes markdown files in a workspace directory, with a plain-HTML/CSS/JS frontend (`public/`). There is no build step and no database — files on disk are the source of truth. The server starts with `npm start`; frontend changes take effect on page reload, server changes require a restart.

```
browser (public/*.html)
    ↕ fetch /api/*
server.js  ──reads/writes──▶  REPO_ROOT/  (workspace directory on disk)
                                  projects/README.md   ← project index
                                  projects/<group>/<project>/README.md
                                  meetings/README.md   ← meeting index
                                  meetings/<type>/<name>.md
                                  links.json
                                  workspace.json
registry.json  (app directory, gitignored)
    └─ maps workspace IDs → local paths + Notion DB IDs
```

### Configuration chain

At startup, `server.js` reads two config files:

1. **`registry.json`** (in the app directory, gitignored) — picks the active workspace by `WORKSPACE` env var (defaults to `'work'`). Provides:
   - `ws.path` → `REPO_ROOT` (absolute path to the workspace directory)
   - `ws.features` → `ALLOWED_ROOTS` (Set of enabled root names; doubles as the feature flag list)
   - `ws.notionDatabaseId` → Notion data source
   - `ws.worktreeDirs` → directories to scan for git worktrees (F1 feature)
   - `ws.customRoots` → optional overrides for section root paths (see Path model below)

2. **`workspace.json`** (inside `REPO_ROOT`) — workspace-specific config. Provides:
   - `projectGroups` → `PROJECT_GROUP_PREFIXES` — defines project group prefixes, section headings, and optional subsection headings (used by `detectProjectReadme` and `addToProjectsOverview`)

### Path model and security

All file-serving routes resolve paths through `getSectionRoot(rootName)`:

```
getSectionRoot(rootName)
  → ws.customRoots[rootName]  if defined in registry.json
  → REPO_ROOT/rootName        otherwise
```

Every route that touches files does:
1. `ALLOWED_ROOTS.has(rootName)` — the root must be in `ws.features`
2. `absPath = path.resolve(sectionRoot, relPath)` — resolve canonically
3. `absPath.startsWith(sectionRoot + path.sep)` — assert it stays inside the root

**Exception:** `projects/README.md` (the overview index) and `meetings/README.md` are always resolved relative to `REPO_ROOT`, not through `getSectionRoot` — even if `projects` has a `customRoot`. This is intentional (the overview index lives in the workspace root), but is easy to forget.

### Project groups — the critical coupling

This is where bugs recur. There are **two separate sources of truth for project group prefixes**, and they must stay in sync:

**Source 1: `workspace.json` → `PROJECT_GROUP_PREFIXES`** (server-side, static)

Used by:
- `detectProjectReadme(relPath)` — determines whether a file being created/saved is a project-level README, and which group it belongs to
- `addToProjectsOverview(relPath, ...)` — locates the right section in `projects/README.md` to insert a new row

**Source 2: `projects/README.md`** (runtime, dynamic)

Used by:
- `/api/project-groups` — builds the group dropdown for the New Project modal. **Derives each group's prefix by reading the first link in each `## section`** and extracting the path up to the last two segments (`folder/README.md`).
- `/api/projects` (`parseProjects`) — renders the project list on `index.html`

**The invariant that must hold:**

> Every link in `projects/README.md` must use a path that begins with the `prefix` defined for that section in `workspace.json`. The first link in each section is especially load-bearing — it determines the prefix that `/api/project-groups` returns for that group, which becomes the directory where new projects are created.

**What breaks when it doesn't hold:**

If the first link in a section has a wrong prefix (e.g. `feature-backlog/other-projects/foo/README.md` in the `## Other Projects` section), then:
1. `/api/project-groups` returns the wrong prefix for that group (`feature-backlog/other-projects/` instead of `other-projects/`)
2. New projects get created in the wrong directory
3. `detectProjectReadme` (which uses workspace.json prefixes) doesn't match the wrong path → no README template is applied, and `projects/README.md` is not updated

**When editing `projects/README.md` directly**, always verify that each link's path prefix matches the `prefix` field for its section in `workspace.json`.

**The `sub` field**: some groups have a two-level structure — a `## Section` heading and a `### Subsection` heading. The `sub` field in workspace.json holds the `### Subsection` string (or `null`). Both `addToProjectsOverview` and `/api/project-groups` need to handle this. The Feature Backlog group uses this pattern (Q3 2026 / Q4 2026+).

### Project creation lifecycle

When the user creates a new project from the UI:

1. `index.html` calls `/api/project-groups` to populate the group dropdown. The dropdown option values are the prefix strings (e.g. `other-projects/`).
2. On submit, `index.html` constructs `relPath = prefix + toKebab(name) + '/README.md'` and POSTs to `/api/project-file` with `{ root: 'projects', path: relPath, name }`.
3. `POST /api/project-file` calls `detectProjectReadme(relPath)`:
   - If it matches a group prefix from `workspace.json` → writes the README template (`README_TEMPLATE_WORK` or `README_TEMPLATE_HOME`) and calls `addToProjectsOverview` to insert a row in `projects/README.md`
   - If no match → writes a plain `# Heading\n` file and skips the overview update
4. `addToProjectsOverview` scans `projects/README.md` for the correct `## section` (and `### sub` if applicable), finds the last `|` table row in that section, and inserts a new row after it.

### Meeting system

Meetings have two layers:

**Index layer** (`meetings/README.md`): a flat markdown file listing meeting files grouped under `## Section` headings as bullet links. `parseMeetingList()` reads this into `{ sectionName: [{ name, path }] }` for `index.html`'s Meetings tab.

**File layer** (`meetings/<type>/<name>.md`): individual meeting files with `## Section` headings containing either checklists or tables. `parseMeetingFile(absPath)` parses these into structured objects for `meeting.html`.

**Mutation pattern**: all mutations (`toggle`, `add-item`, `delete-line`, `update-line`, `replace-section`, `add-decision`) go through `mutateMeeting(relPath, mutatorFn)`. The mutator receives the file as an array of raw lines and returns the modified array. **Lines are matched by their exact raw string including leading whitespace** — never by index. This is intentional so that a stale client can't corrupt an unrelated line.

### F1 / worktree feature

The `f1` root uses a separate path model. It has its own `customRoot` entry in `registry.json` pointing to a different directory. Projects within it are discovered by scanning `Active/` and `Backlog/` subdirectories rather than a README index. The worktree routes (`/api/worktree-dirs`, `/api/worktree-files`, `/api/worktree-md`) allow browsing and editing markdown files in git worktrees registered under `ws.worktreeDirs`. These routes validate that the `worktree` path is within a configured worktree directory before allowing access.

### Feature gates

A root name (e.g. `projects`, `meetings`, `f1`, `notebook`) is "active" if it appears in `ws.features` in `registry.json`. On the server this is `ALLOWED_ROOTS`; on the frontend every page calls `/api/workspace` on load and hides elements with `data-feature="<name>"` for any inactive feature. The `[data-feature]` attribute pattern is the standard way to add conditionally-visible nav links or tabs.

---

## General

- All server logic lives in `server.js`. All frontend assets are in `public/`.
- The server reads/writes files in the **active workspace directory** — `REPO_ROOT` is loaded from `registry.json` based on the `WORKSPACE` env var. Keep this in mind when reasoning about file paths.
- No build step — changes to `.html`, `.css`, or `.js` files in `public/` take effect on page reload.
- Server changes require restarting `npm start`.

## Adding a new API route

1. Add the route handler to `server.js`.
2. Follow the existing security pattern: validate `rootName` against `ALLOWED_ROOTS`, resolve the absolute path, assert it starts with `sectionRoot + path.sep`.
3. Keep mutation logic in a dedicated helper (like `mutateMeeting`) — don't inline file I/O directly inside route handlers.

## Adding a new view

1. Create a new `.html` file in `public/`.
2. Reuse CSS classes from `style.css` — don't add view-specific styles unless the pattern is genuinely new.
3. Shared UI patterns to reuse:
   - Sidebar file tree: see `project.html`
   - Tab bar with dirty-state dot: see `project.html`
   - Editable checklist sections: see `meeting.html` — `.meeting-task`, `.meeting-section-heading`, `.add-item-row`
   - Link widgets: see `links.html` — `.links-card`, `.links-item`, `.links-action-btn`
4. All pages fetch `/api/workspace` on load to hide nav links for inactive features (e.g. no Notebook link when `notebook` is absent from `features`).

## Style conventions

- Dark theme variables are defined in the `:root` block at the top of `style.css`. Always use `var(--...)` tokens — never hardcode colors.
- Status colors: `--status-active` (green), `--status-backlog` (yellow), `--status-on-hold` / `--status-paused` (orange), `--status-done` (muted).

## Meeting file mutations

Mutations match lines by their **exact raw string** (including leading whitespace). When adding a new mutation type, follow this pattern — don't use line indices. The `mutateMeeting` helper handles read/write and returns the fresh parsed sections.

## Project README auto-registration

`detectProjectReadme(relPath)` identifies a file as a project-level README if it matches `{group-prefix}/{folder-name}/README.md` exactly (two path segments after the prefix). Project groups come from `workspace.json` in the workspace root — not hardcoded in `server.js`.

## Toast UI Editor

The markdown editor in `project.html` uses Toast UI v3 loaded from CDN. Dark-theme CSS overrides live in `style.css` under the `/* Toast UI Editor overrides */` block. The `style.css` `<link>` must load **after** the Toast UI CDN links — specificity depends on this order. Don't reorder the `<head>` links.

## Workspace configuration

- `registry.json` (gitignored) maps workspace IDs to local paths and Notion DB IDs.
- `workspace.json` in each workspace root defines `projectGroups` for that workspace.
- `/api/workspace` exposes `{ id, name, features, projectGroups }` — use this on the frontend to drive nav visibility and the new-project group dropdown.
