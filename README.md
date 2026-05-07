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
# Work (default)
WORKSPACE=work npm start           # port 3001

# Home
WORKSPACE=home PORT=3002 npm start # port 3002
```

On Windows (PowerShell):
```powershell
$env:WORKSPACE="work"; npm start
$env:WORKSPACE="home"; $env:PORT="3002"; npm start
```

## registry.json

Gitignored. Maps workspace IDs to local paths and Notion config. See `registry.sample.json` for the format.

Each workspace directory must contain a `workspace.json` with its `projectGroups` array and a `links.json` at its root.

## .env variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKSPACE` | No | Which workspace to load (default: `work`) |
| `NOTION_API_KEY` | No | Notion integration token — enables the task widget |
| `PORT` | No | Override the default port 3001 |

## Project Structure

```
mkd-dashboard/
├── server.js          # Express server — all API routes and file I/O
├── package.json
├── registry.json      # gitignored — your local workspace paths
├── registry.sample.json
└── public/
    ├── index.html     # Home / Tasks + Projects + Meetings tabs
    ├── project.html   # Project view — README widget + file editor
    ├── editor.html    # Generic markdown editor (Notebook)
    ├── meeting.html   # Meetings
    ├── links.html     # Quick Links
    ├── style.css      # Global dark-theme styles
    ├── resize.js      # Shared sidebar resize logic
    └── quotes.js      # Random quote helper
```

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
