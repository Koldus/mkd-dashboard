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
                                  tasks.json           ← local Kanban task store
registry.json  (app directory, gitignored)
    └─ maps workspace IDs → local paths
```

### Configuration chain

At startup, `server.js` reads two config files:

1. **`registry.json`** (in the app directory, gitignored) — picks the active workspace by `WORKSPACE` env var (defaults to `'work'`). Provides:
   - `ws.path` → `REPO_ROOT` (absolute path to the workspace directory)
   - `ws.features` → `ALLOWED_ROOTS` (Set of enabled root names; doubles as the feature flag list)
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

### Task system

Tasks live in `REPO_ROOT/tasks.json` — a flat array read/written wholesale (same pattern as `links.json`), via `lib/task-store.js` (`readTasks`, `writeTasks`, `splitTasks`). Each task is `{ id, title, status, project, activity[], createdAt, updatedAt }`.

**`project` is a project-folder key, not a display name** — the same value as `project.path` (from `/api/projects`) with the trailing `/README.md` stripped, and the same value `project.html`'s own `?path=` query param carries. This is what lets a project page's Tasks tab filter tasks for that project with an exact match (`GET /api/tasks?project=<path>`), and it's why the task-modal's Project field is a `<select>` populated from `/api/projects` rather than free text.

Routes (`server.js`, mirroring the `links.json` GET/PUT pattern plus per-id mutation):
- `GET /api/tasks` (optional `?project=`) → `{ connected, today, backlog }`, split via `TODAY_STATUSES`/`IGNORED_STATUSES` in `lib/task-store.js`
- `POST /api/tasks` → append a new task (`crypto.randomUUID()` id)
- `PUT /api/tasks/:id` → patch fields on an existing task

**UI**: both `index.html` (global board, left column) and `project.html` (a "Tasks" tab alongside "README", added via `editorApi.openCustomPane`) render a Kanban board through the shared `public/kanban.js` module (`renderKanbanBoard`) — one column per status, drag-and-drop between columns changes status via `PUT /api/tasks/:id`. Don't duplicate board-rendering logic in either page; extend `kanban.js` instead.

### Slack scan review

`/slack-scan` doesn't write `conversations.json` directly. It writes a temp approval file, `REPO_ROOT/.slack-scan-review.md` (gitignored), and waits. The user edits each card's **Your decision** bullets and **Comment**; those edits *are* the approval. When they tell Claude "done", the skill validates every card, writes `conversations.json`, advances the watermark in `.slack-scan-state.json`, and deletes the review file. A pending review blocks the next scan.

`public/scan-review.html` is a one-card-at-a-time reader for that file, backed by `lib/scan-review-store.js` and two routes (`GET /api/scan-review`, `PUT /api/scan-review/:id`). **It is an editor for the same bytes, not a second copy of them** — there is no separate state, and the skill's contract is untouched.

The store is deliberately **not a markdown parser**. It finds the lines it owns and rewrites only those:

- A card runs from its `### <n> · …` heading to its `<!-- card-end id=… kind=… last=… -->` marker. **The marker, not the array position, identifies a card** — so a file edited by hand in the meantime can't cause a mis-write. Same discipline as `mutateMeeting`.
- A write touches only the `- Save|Apply|Type|Status|Project:` bullets named in the patch, keeping each bullet's own indentation and spacing, plus the comment body when `comment` is given. Everything else — the quoted message, thread context, overview tables, markers — is written back byte for byte. The tests assert this by diffing the whole file.
- A missing bullet is an error, not something to append: the shape the skill parses must not change.
- Sections are read generically from their `**Name**` markers, so the `kind=update` and `kind=close` card shapes (`New replies`, `Proposed update`, `Why close`, and `Apply` instead of `Save`) work without being special-cased.
- `PUT` validates against the shared vocabulary and refuses anything the skill would reject at "done" — stricter than `PUT /api/conversations/:id`, because a bad value sitting in the file blocks the whole run.

It rides on the `conversations` feature gate (it feeds that tracker and shares its vocabulary); the filename is a fixed constant joined to `REPO_ROOT`, so there is no path to guard. Progress ("seen" cards) is localStorage only, keyed on the review's header line — never written to the file. `index.html` shows a banner while a review is pending; `.split-layout` gets `.has-banner` because its height is a viewport calc.

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

## Markdown editor

The editor lives in `public/editor-core.js` and is **TipTap 2**, imported as ES modules from `esm.sh` — not Toast UI, which this file used to claim and which is no longer present anywhere in the codebase.

**YAML frontmatter is preserved but invisible.** `splitFrontmatter` strips a leading `---…---` block before the content reaches TipTap, holds it verbatim in a closure, and re-prepends it in `currentMarkdown()` on every save. Source mode re-splits on edit, so frontmatter can be edited by hand there. Consequences worth knowing:

- A file's frontmatter never appears in the WYSIWYG view. Anything a user needs to *see* belongs in the body, not the frontmatter.
- Anything that edits frontmatter programmatically must go through a route, not the editor — this is why handoff status is changed from the sidebar.
- TipTap normalises the **body** on load (list markers, escaping, image syntax), so a saved file is frequently not byte-identical to the one opened. The dirty check compares against serializer output rather than the raw file for exactly this reason.

## Handoffs

Instruction documents written in the workspace and carried out in `gd-design-studio` — "write this scenario, produce that one-pager". **Not `tasks.json` tasks**: a task is a row on a Kanban board, a handoff is a document handed to another repo and another session.

- One markdown file per handoff at `projects/<group>/<project>/handoffs/<name>.md`.
- State is `status: open|closed` in YAML frontmatter, alongside `created`. Frontmatter rather than `open/`/`closed/` folders because the path is what gets handed across the repo boundary — closing one must not break a link to it.
- `lib/handoff-store.js` owns parsing and writing. Its YAML handling is deliberately minimal: flat `key: value` pairs, and any line it doesn't recognise is preserved untouched on write. Don't grow it into a general YAML parser; add a dependency if that is ever genuinely needed.
- Routes mirror the `conversations` pattern: `GET /api/handoffs?project=`, `POST /api/handoffs`, `PUT /api/handoffs/*` (status only). They ride on the `projects` feature gate and the projects-root path guard — no separate root.
- UI is the Handoffs panel in `project.html`'s sidebar, below Files. It is deliberately **not** a third Files tab: handoffs bridge the project and its worktree, so the panel stays visible whichever Files tab is active.
- A file with no frontmatter, or an unrecognised status, reads as `open` — an unreadable handoff should surface rather than disappear into Closed.

## Workspace configuration

- `registry.json` (gitignored) maps workspace IDs to local paths.
- `workspace.json` in each workspace root defines `projectGroups` for that workspace.
- `/api/workspace` exposes `{ id, name, features, projectGroups }` — use this on the frontend to drive nav visibility and the new-project group dropdown.
