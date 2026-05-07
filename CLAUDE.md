# MKD Dashboard — Claude Instructions

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
