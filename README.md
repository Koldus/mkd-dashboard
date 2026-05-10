# MKD Dashboard

A local browser-based workspace dashboard. Works against any registered workspace via `registry.json`. Built with Node/Express — no build step required.

## Setup

```bash
npm install
cp registry.sample.json registry.json   # then fill in your paths
cp .env.sample .env                      # then add NOTION_API_KEY if needed
npm start
```

Opens at `http://localhost:3001`.

## Running multiple workspaces

```bash
# Convenience scripts (defined in package.json)
npm run work   # WORKSPACE=work, port 3001
npm run home   # WORKSPACE=home, port 3002
```

Or manually:

```bash
WORKSPACE=work npm start
WORKSPACE=home PORT=3002 npm start
```

On Windows (PowerShell):
```powershell
$env:WORKSPACE="work"; npm start
$env:WORKSPACE="home"; $env:PORT="3002"; npm start
```

## registry.json

Gitignored. Maps workspace IDs to local paths and Notion config. See `registry.sample.json` for the full format.

```json
{
  "workspaces": [
    {
      "id": "work",
      "name": "Work",
      "root": "/path/to/workspace",
      "features": ["projects", "meetings", "notebook", "f1"],
      "customRoots": {
        "f1": "/path/to/external/projects/F1"
      },
      "notionTasksDbId": "..."
    }
  ]
}
```

`customRoots` maps root names to absolute paths outside the workspace directory — used for browsing external project trees (e.g. an F1 design project folder in a separate repo).

Each workspace directory must contain:
- `workspace.json` — defines `projectGroups` (array of folder name prefixes shown in the project list)
- `links.json` — quick links shown on the Links page

## .env variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKSPACE` | No | Which workspace to load (default: `work`) |
| `NOTION_API_KEY` | No | Notion integration token — enables the task widget |
| `PORT` | No | Override the default port 3001 |

## Project Structure

```
mkd-dashboard/
├── server.js            # Express server — all API routes and file I/O
├── package.json
├── registry.json        # gitignored — your local workspace paths
├── registry.sample.json
└── public/
    ├── index.html       # Home — Tasks, Projects, Meetings tabs
    ├── project.html     # Project view — file tree + markdown editor
    ├── editor.html      # Generic markdown editor (Notebook, Ideas, …)
    ├── meeting.html     # Meeting view — editable sections and tasks
    ├── links.html       # Quick links manager
    ├── editor-core.js   # Shared file tree, tab manager, TipTap editor
    ├── style.css        # Global dark-theme styles (CSS variable tokens)
    ├── resize.js        # Shared sidebar resize logic
    └── quotes.js        # Random quote helper
```

## Editor

`project.html` and `editor.html` share a [TipTap](https://tiptap.dev/) v2 WYSIWYG editor loaded from CDN (no build step). Features:

- Toolbar: headings, bold/italic/strike, code, blockquote, lists, task lists, tables, HR, link, image
- **MD button** — toggle raw markdown source mode (edits in source mode are saved directly)
- **Link tooltip** — clicking into a link shows an inline popover with Open / Edit / Remove actions
- **Image support** — images stored alongside the `.md` file are served via `/files/:root/…`; width and height attributes are preserved across save/reload
- **File rename** — pencil icon (✎) on hover in the sidebar file tree; inline edit with Enter to confirm, Escape to cancel

## API Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/workspace` | Workspace identity, active features, and project groups |
| GET | `/api/projects` | Parse `projects/README.md` into a project list |
| GET | `/api/meetings` | Parse `meetings/README.md` into a meeting list |
| GET | `/api/meeting` | Read and parse a single meeting file into sections |
| POST | `/api/meeting/toggle` | Toggle a checkbox in a meeting file |
| POST | `/api/meeting/add-item` | Append a task item to a section |
| POST | `/api/meeting/delete-line` | Delete a line by its exact content |
| POST | `/api/meeting/update-line` | Replace a line by its exact content |
| POST | `/api/meeting/replace-section` | Replace an entire `## Section` block |
| POST | `/api/meeting/add-decision` | Insert a row into a Decisions table |
| GET | `/api/project-files` | List `.md` files under a repo root |
| GET | `/api/md` | Read a file; returns `{ html, markdown }` |
| POST | `/api/project-file` | Create a new `.md` file |
| PUT | `/api/project-file` | Save content to an existing `.md` file |
| DELETE | `/api/project-file` | Delete a `.md` file |
| POST | `/api/project-folder` | Create a directory |
| DELETE | `/api/project-folder` | Delete a directory recursively |
| POST | `/api/project-file/move` | Rename or move a `.md` file |
| PUT | `/api/project-status` | Update a project's status |
| GET | `/api/links` | Read `links.json` from workspace root |
| PUT | `/api/links` | Persist updated `links.json` |
| GET | `/api/tasks` | Fetch today/backlog tasks from Notion |
| POST | `/api/tasks` | Create a new Notion task |
| PUT | `/api/tasks/:id` | Update a task's status |
| GET | `/files/:root/*` | Serve workspace files (images, attachments) |
| GET | `/api/f1/projects` | List F1 design projects from `customRoots.f1` |
