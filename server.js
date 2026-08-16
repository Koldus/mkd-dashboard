require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');
const { detectProjectReadme, insertProjectOverviewRow, parseProjectGroupsFromOverview } = require('./lib/project-helpers');
const { readTasks, writeTasks, splitTasks } = require('./lib/task-store');

const app = express();
const PORT = process.env.PORT || 3001;
const WORKSPACE_ID = process.env.WORKSPACE || 'work';
const REGISTRY_PATH = process.env.REGISTRY_PATH || path.join(__dirname, 'registry.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const ws = registry.workspaces.find(w => w.id === WORKSPACE_ID);
if (!ws) throw new Error(`Unknown workspace: ${WORKSPACE_ID}`);
// Resolve ws.path relative to the registry file so test fixtures can use relative paths.
const REPO_ROOT = path.resolve(path.dirname(REGISTRY_PATH), ws.path);
const workspaceConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'workspace.json'), 'utf8'));
const ALLOWED_ROOTS = new Set(ws.features);
const PROJECT_GROUP_PREFIXES = workspaceConfig.projectGroups;
const WORKTREE_DIRS = ws.worktreeDirs || [];

function validateWorktreePath(p) {
  return WORKTREE_DIRS.some(d => p === d || p.startsWith(d + path.sep));
}

function getSectionRoot(rootName) {
  const custom = ws.customRoots && ws.customRoots[rootName];
  return custom ? path.normalize(custom) : path.join(REPO_ROOT, rootName);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Project overview helpers ────────────────────────────────────────────────

function addToProjectsOverview(relPath, status, name) {
  const overviewPath = path.join(REPO_ROOT, 'projects', 'README.md');
  if (!fs.existsSync(overviewPath)) return;
  const lines = fs.readFileSync(overviewPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const updated = insertProjectOverviewRow(lines, relPath, status, name, PROJECT_GROUP_PREFIXES);
  if (updated) fs.writeFileSync(overviewPath, updated.join('\n'), 'utf8');
}

const README_TEMPLATE_WORK = (title, status) =>
`# ${title}

**Status:** ${status}

## Goal

## Context

## Documentation

## Decisions

| Date | Decision | Reason |
|------|----------|--------|

## Links & Resources

- [GDP Ticket]()
- [One Pager]()
- [Design Studio Branch]()
- [Figma]()
`;

const README_TEMPLATE_HOME = (title, status) =>
`# ${title}

**Status:** ${status}

## Goal

## Shopping List

## Decisions

| Date | Decision | Reason |
|------|----------|--------|

## Links & Resources

`;

const README_TEMPLATE = WORKSPACE_ID === 'home' ? README_TEMPLATE_HOME : README_TEMPLATE_WORK;

// ── Parse markdown tables from projects/README.md ───────────────────────────
function parseProjects() {
  const content = fs.readFileSync(path.join(REPO_ROOT, 'projects', 'README.md'), 'utf8');
  const projects = [];
  let currentCategory = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const headingMatch = line.match(/^## (.+)/);
    if (headingMatch) {
      currentCategory = headingMatch[1].trim();
      continue;
    }

    // Match table rows: | [Name](path) | status |
    const rowMatch = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|/);
    if (rowMatch && currentCategory) {
      projects.push({
        name: rowMatch[1],
        path: rowMatch[2],
        status: rowMatch[3],
        category: currentCategory,
      });
    }
  }

  return projects;
}

// GET /api/projects
app.get('/api/projects', (req, res) => {
  try {
    const projects = parseProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseYamlFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2];
  }
  return meta;
}

// GET /api/f1/projects — scan Active/ and Backlog/ under the f1 custom root
app.get('/api/f1/projects', (req, res) => {
  if (!ALLOWED_ROOTS.has('f1')) return res.status(403).json({ error: 'Forbidden' });
  const f1Root = getSectionRoot('f1');
  const statuses = ['Active', 'Backlog'];
  const projects = [];

  try {
    for (const status of statuses) {
      const dir = path.join(f1Root, status);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.') || name.startsWith('_')) continue;
        const projectDir = path.join(dir, name);
        if (!fs.statSync(projectDir).isDirectory()) continue;
        const mainFile = path.join(projectDir, `${name}.md`);
        const meta = fs.existsSync(mainFile)
          ? parseYamlFrontMatter(fs.readFileSync(mainFile, 'utf8'))
          : {};
        projects.push({ name, status, path: `${status}/${name}`, meta });
      }
    }
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/worktree-dirs — list all worktrees across configured parent dirs
app.get('/api/worktree-dirs', (req, res) => {
  const result = [];
  for (const dir of WORKTREE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        result.push({ name: entry.name, path: path.join(dir, entry.name), parent: dir });
      }
    }
  }
  res.json(result);
});

// GET /api/worktree-files?worktree=/abs&f1path=Active/Name — list .md files in worktree subpath
app.get('/api/worktree-files', (req, res) => {
  const { worktree, f1path } = req.query;
  console.log('[worktree-files] worktree=%s f1path=%s', worktree, f1path);
  if (!worktree || !validateWorktreePath(worktree)) {
    console.log('[worktree-files] FORBIDDEN — not in WORKTREE_DIRS:', WORKTREE_DIRS);
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!f1path) return res.status(400).json({ error: 'f1path required' });
  const targetDir = path.join(worktree, 'projects', 'F1', f1path);
  console.log('[worktree-files] targetDir=%s exists=%s', targetDir, fs.existsSync(targetDir));
  if (!fs.existsSync(targetDir)) return res.json([]);
  try {
    const files = collectMdFiles(targetDir, '');
    console.log('[worktree-files] found %d files', files.length);
    res.json(files);
  } catch (err) {
    console.log('[worktree-files] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/worktree-md — save a file back to the worktree
app.put('/api/worktree-md', (req, res) => {
  const { worktree, f1path, file, content } = req.body;
  if (!worktree || !validateWorktreePath(worktree)) return res.status(403).json({ error: 'Forbidden' });
  if (!f1path || !file) return res.status(400).json({ error: 'f1path and file required' });
  const baseDir = path.join(worktree, 'projects', 'F1', f1path);
  const absPath = path.resolve(baseDir, file);
  if (!absPath.startsWith(baseDir + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.writeFileSync(absPath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/worktree-md?worktree=/abs&f1path=Active/Name&file=rel.md — read a file from worktree
app.get('/api/worktree-md', (req, res) => {
  const { worktree, f1path, file } = req.query;
  if (!worktree || !validateWorktreePath(worktree)) return res.status(403).json({ error: 'Forbidden' });
  if (!f1path || !file) return res.status(400).json({ error: 'f1path and file required' });
  const baseDir = path.join(worktree, 'projects', 'F1', f1path);
  const absPath = path.resolve(baseDir, file);
  if (!absPath.startsWith(baseDir + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });
  const markdown = fs.readFileSync(absPath, 'utf8');
  res.json({ markdown, html: marked(markdown) });
});

// Recursively collect all .md files under a directory, skipping _template dirs and _ files
function collectMdFiles(dir, base) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = collectMdFiles(full, rel);
      if (children.length > 0) {
        results = results.concat(children);
      } else {
        results.push(rel + '/'); // empty directory marker
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(rel);
    }
  }
  return results;
}

// GET /api/project-files?root=projects&path=active-features/parameters
app.get('/api/project-files', (req, res) => {
  const rootName = req.query.root || 'projects';
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });

  const sectionRoot = getSectionRoot(rootName);
  const rel = req.query.path || '';
  const absPath = rel ? path.resolve(sectionRoot, rel) : sectionRoot;

  if (!absPath.startsWith(sectionRoot)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const files = collectMdFiles(absPath, '');
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/md?root=projects&path=active-features/parameters/README.md
app.get('/api/md', (req, res) => {
  const rootName = req.query.root || 'projects';
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });

  const sectionRoot = getSectionRoot(rootName);
  const rel = req.query.path || '';
  const absPath = path.resolve(sectionRoot, rel);

  if (!absPath.startsWith(sectionRoot + path.sep)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const html = marked(content);
    res.json({ html, markdown: content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse meetings/README.md into a structured list grouped by section
function parseMeetingList() {
  const content = fs.readFileSync(path.join(REPO_ROOT, 'meetings', 'README.md'), 'utf8');
  const result = {};
  let currentSection = null;

  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      currentSection = h2[1].trim();
      result[currentSection] = [];
      continue;
    }
    const item = line.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
    if (item && currentSection) {
      result[currentSection].push({ name: item[1], path: item[2] });
    }
  }
  return result;
}

// ── Meeting file structured parsing ──────────────────────────────────────────

function parseListSection(lines) {
  const items = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const h3 = line.match(/^### (.+)/);
    if (h3) { items.push({ type: 'heading', text: h3[1].trim() }); continue; }

    const taskMatch = line.match(/^(\s*)- \[([ xX])\] (.+)$/);
    if (taskMatch) {
      items.push({
        type: 'task',
        checked: taskMatch[2].toLowerCase() === 'x',
        text: taskMatch[3].trim(),
        indent: Math.floor(taskMatch[1].length / 2),
        line, // preserve exact line (with leading whitespace) for mutations
      });
    }
  }
  return { type: 'list', items };
}

function parseTableSection(lines) {
  let headers = null;
  const rows = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.every(c => /^[-: ]+$/.test(c))) continue; // separator row
    if (!headers) { headers = cells; continue; }
    if (cells.some(c => c !== '')) rows.push({ cells, line });
  }
  return { type: 'table', headers: headers || [], rows };
}

function parseMeetingFile(filePath) {
  const result = {};
  let currentSection = null;
  let sectionLines = [];

  const flush = () => {
    if (currentSection === null) return;
    const content = sectionLines.join('\n');
    const isTable = sectionLines.some(l => l.trim().startsWith('|'));
    result[currentSection] = isTable
      ? parseTableSection(sectionLines)
      : parseListSection(sectionLines);
  };

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (line.startsWith('# ')) continue;
    const h2 = line.match(/^## (.+)/);
    if (h2) { flush(); currentSection = h2[1].trim(); sectionLines = []; }
    else if (currentSection !== null) sectionLines.push(line);
  }
  flush();
  return result;
}

// ── Meeting mutation helpers ───────────────────────────────────────────────────

function getMeetingAbs(relPath) {
  const root = path.join(REPO_ROOT, 'meetings');
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep)) throw new Error('Forbidden');
  return abs;
}

function mutateMeeting(relPath, mutatorFn) {
  const abs = getMeetingAbs(relPath);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const updated = mutatorFn([...lines]);
  fs.writeFileSync(abs, updated.join('\n'), 'utf8');
  return parseMeetingFile(abs);
}

function getSectionRange(lines, sectionName) {
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].trim() === `## ${sectionName}`) { start = i + 1; }
    else if (start !== -1 && lines[i].match(/^## /)) { end = i; break; }
  }
  return { start, end };
}

// GET /api/meetings — structured list from meetings/README.md
app.get('/api/meetings', (req, res) => {
  try {
    res.json(parseMeetingList());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meeting?path=1-1/tomas-m.md — structured sections
app.get('/api/meeting', (req, res) => {
  const rel = req.query.path || '';
  try {
    const abs = getMeetingAbs(rel);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
    res.json(parseMeetingFile(abs));
  } catch (err) {
    res.status(err.message === 'Forbidden' ? 403 : 500).json({ error: err.message });
  }
});

// POST /api/meeting/toggle — toggle a checkbox
app.post('/api/meeting/toggle', (req, res) => {
  const { path: relPath, line } = req.body;
  try {
    const sections = mutateMeeting(relPath, lines => {
      const idx = lines.findIndex(l => l.trimEnd() === line);
      if (idx !== -1) {
        lines[idx] = lines[idx].includes('[ ]')
          ? lines[idx].replace('[ ]', '[x]')
          : lines[idx].replace(/\[[xX]\]/, '[ ]');
      }
      return lines;
    });
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/meeting/add-item — append a task to a section
app.post('/api/meeting/add-item', (req, res) => {
  const { path: relPath, section, text } = req.body;
  try {
    const sections = mutateMeeting(relPath, lines => {
      let { end } = getSectionRange(lines, section);
      while (end > 0 && !lines[end - 1].trim()) end--;
      lines.splice(end, 0, `- [ ] ${text}`);
      return lines;
    });
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/meeting/delete-line — remove a line by its exact text
app.post('/api/meeting/delete-line', (req, res) => {
  const { path: relPath, line } = req.body;
  try {
    const sections = mutateMeeting(relPath, lines => {
      const idx = lines.findIndex(l => l.trimEnd() === line);
      if (idx !== -1) lines.splice(idx, 1);
      return lines;
    });
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/meeting/update-line — replace a line's text
app.post('/api/meeting/update-line', (req, res) => {
  const { path: relPath, oldLine, newLine } = req.body;
  try {
    const sections = mutateMeeting(relPath, lines => {
      const idx = lines.findIndex(l => l.trimEnd() === oldLine);
      if (idx !== -1) lines[idx] = newLine;
      return lines;
    });
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/meeting/replace-section — replace entire section content
app.post('/api/meeting/replace-section', (req, res) => {
  const { path: relPath, section, content } = req.body;
  try {
    const sections = mutateMeeting(relPath, lines => {
      const { start, end } = getSectionRange(lines, section);
      if (start === -1) return lines;
      const newLines = content ? content.split('\n') : [];
      lines.splice(start, end - start, ...newLines);
      return lines;
    });
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/meeting/add-decision — insert a table row in Decisions
app.post('/api/meeting/add-decision', (req, res) => {
  const { path: relPath, date, decision, reason } = req.body;
  try {
    const sections = mutateMeeting(relPath, lines => {
      const { start, end } = getSectionRange(lines, 'Decisions');
      let insertAt = end;
      for (let i = start; i < end; i++) {
        if (lines[i].match(/^\|[-| :]+\|$/)) { insertAt = i + 1; break; }
      }
      lines.splice(insertAt, 0, `| ${date || ''} | ${decision} | ${reason || ''} |`);
      return lines;
    });
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/project-file — create a new .md file
app.post('/api/project-file', (req, res) => {
  const { root: rootName, path: relPath, name } = req.body;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });
  if (!relPath || !relPath.toLowerCase().endsWith('.md')) return res.status(400).json({ error: 'Path must end with .md' });

  const sectionRoot = getSectionRoot(rootName);
  const absPath = path.resolve(sectionRoot, relPath);
  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (fs.existsSync(absPath)) return res.status(409).json({ error: 'File already exists' });

  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const heading = path.basename(relPath, '.md').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const projectMatch = rootName === 'projects' && detectProjectReadme(relPath, PROJECT_GROUP_PREFIXES);
    if (projectMatch) {
      const status = 'backlog';
      const projectHeading = name || projectMatch.folderName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      fs.writeFileSync(absPath, README_TEMPLATE(projectHeading, status), 'utf8');
      addToProjectsOverview(relPath, status, projectHeading);
    } else {
      fs.writeFileSync(absPath, `# ${heading}\n`, 'utf8');
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/project-file — delete a .md file
app.delete('/api/project-file', (req, res) => {
  const { root: rootName, path: relPath } = req.body;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });
  if (!relPath || !relPath.toLowerCase().endsWith('.md')) return res.status(400).json({ error: 'Only .md files can be deleted' });

  const sectionRoot = getSectionRoot(rootName);
  const absPath = path.resolve(sectionRoot, relPath);
  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });

  try {
    fs.unlinkSync(absPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/project-file — save content of an existing .md file
app.put('/api/project-file', (req, res) => {
  const { root: rootName, path: relPath, content } = req.body;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });
  if (!relPath || !relPath.toLowerCase().endsWith('.md')) return res.status(400).json({ error: 'Path must end with .md' });

  const sectionRoot = getSectionRoot(rootName);
  const absPath = path.resolve(sectionRoot, relPath);
  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });

  try {
    fs.writeFileSync(absPath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/project-status — update a project's status in overview + its README
app.put('/api/project-status', (req, res) => {
  const { path: relPath, status } = req.body;
  const VALID = new Set(['active', 'on hold', 'paused', 'backlog', 'done']);
  if (!relPath || !VALID.has(status)) return res.status(400).json({ error: 'Invalid request' });

  try {
    const overviewPath = path.join(REPO_ROOT, 'projects', 'README.md');
    const lines = fs.readFileSync(overviewPath, 'utf8').split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`](${relPath})`)) {
        lines[i] = lines[i].replace(/\|\s*[^|]+\s*\|\s*$/, `| ${status} |`);
        found = true;
        break;
      }
    }
    if (!found) return res.status(404).json({ error: 'Project not found' });
    fs.writeFileSync(overviewPath, lines.join('\n'), 'utf8');

    const absPath = path.join(REPO_ROOT, 'projects', relPath);
    if (fs.existsSync(absPath)) {
      let content = fs.readFileSync(absPath, 'utf8');
      content = content.replace(/^\*\*Status:\*\*\s*.+$/m, `**Status:** ${status}`);
      fs.writeFileSync(absPath, content, 'utf8');
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project-folder — create a directory
app.post('/api/project-folder', (req, res) => {
  const { root: rootName, path: relPath } = req.body;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  const sectionRoot = getSectionRoot(rootName);
  const absPath = path.resolve(sectionRoot, relPath);
  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (fs.existsSync(absPath)) return res.status(409).json({ error: 'Folder already exists' });

  try {
    fs.mkdirSync(absPath, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/project-folder — delete a directory and all its contents
app.delete('/api/project-folder', (req, res) => {
  const { root: rootName, path: relPath } = req.body;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  const sectionRoot = getSectionRoot(rootName);
  const absPath = path.resolve(sectionRoot, relPath);
  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (absPath === sectionRoot) return res.status(400).json({ error: 'Cannot delete root' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });

  try {
    fs.rmSync(absPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project-file/move — move / rename a .md file
app.post('/api/project-file/move', (req, res) => {
  const { root: rootName, from: fromRel, to: toRel } = req.body;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).json({ error: 'Forbidden' });

  const sectionRoot = getSectionRoot(rootName);
  const fromAbs = path.resolve(sectionRoot, fromRel);
  const toAbs   = path.resolve(sectionRoot, toRel);

  if (!fromAbs.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (!toAbs.startsWith(sectionRoot + path.sep))   return res.status(403).json({ error: 'Forbidden' });
  if (!fromAbs.toLowerCase().endsWith('.md')) return res.status(400).json({ error: 'Only .md files can be moved' });
  if (!fs.existsSync(fromAbs)) return res.status(404).json({ error: 'Source not found' });
  if (fs.existsSync(toAbs))    return res.status(409).json({ error: 'Destination already exists' });

  try {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/links — static quick links from links.json
app.get('/api/links', (req, res) => {
  try {
    const data = fs.readFileSync(path.join(REPO_ROOT, 'links.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/links — persist full updated array
app.put('/api/links', (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected an array' });
    fs.writeFileSync(path.join(REPO_ROOT, 'links.json'), JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conversations — Slack conversation tracker entries
app.get('/api/conversations', (req, res) => {
  if (!ALLOWED_ROOTS.has('conversations')) return res.status(403).json({ error: 'Forbidden' });
  try {
    const data = fs.readFileSync(path.join(REPO_ROOT, 'conversations.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/conversations — persist full updated array
app.put('/api/conversations', (req, res) => {
  if (!ALLOWED_ROOTS.has('conversations')) return res.status(403).json({ error: 'Forbidden' });
  try {
    const data = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected an array' });
    fs.writeFileSync(path.join(REPO_ROOT, 'conversations.json'), JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workspace — workspace identity and active features
app.get('/api/workspace', (req, res) => {
  res.json({
    id: ws.id,
    name: ws.name,
    features: ws.features,
    projectGroups: PROJECT_GROUP_PREFIXES,
    activityTypes: ws.activityTypes || [],
  });
});

// GET /api/project-groups — dynamic group list from projects/README.md
app.get('/api/project-groups', (req, res) => {
  const overviewPath = path.join(REPO_ROOT, 'projects', 'README.md');
  if (!fs.existsSync(overviewPath)) {
    return res.json(PROJECT_GROUP_PREFIXES.map(g => ({
      label: g.section.replace(/^## /, ''),
      prefix: g.prefix,
    })));
  }
  const content = fs.readFileSync(overviewPath, 'utf8');
  res.json(parseProjectGroupsFromOverview(content));
});

// GET /api/tasks — local tasks.json, optionally filtered by project
app.get('/api/tasks', (req, res) => {
  try {
    const tasks = readTasks(REPO_ROOT);
    const { today, backlog } = splitTasks(tasks, req.query.project || null);
    res.json({ connected: true, today, backlog });
  } catch (err) {
    console.error('[tasks] read error:', err.message);
    res.status(500).json({ connected: false, error: err.message });
  }
});

// POST /api/tasks — create a new task
app.post('/api/tasks', (req, res) => {
  const { title, project, status, activity } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const tasks = readTasks(REPO_ROOT);
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      title,
      status: status || 'Backlog',
      project: project || null,
      activity: activity || [],
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(task);
    writeTasks(REPO_ROOT, tasks);
    res.json({ ok: true, task });
  } catch (err) {
    console.error('[tasks] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tasks/:id — update a task
app.put('/api/tasks/:id', (req, res) => {
  const { title, status, project, activity } = req.body;
  try {
    const tasks = readTasks(REPO_ROOT);
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (title !== undefined)    task.title    = title;
    if (status !== undefined)   task.status   = status;
    if (project !== undefined)  task.project  = project || null;
    if (activity !== undefined) task.activity = activity || [];
    task.updatedAt = new Date().toISOString();
    writeTasks(REPO_ROOT, tasks);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tasks/:id — remove a task
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const tasks = readTasks(REPO_ROOT);
    const next = tasks.filter(t => t.id !== req.params.id);
    if (next.length === tasks.length) return res.status(404).json({ error: 'Task not found' });
    writeTasks(REPO_ROOT, next);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /files/:root/* — serve workspace attachments (images, PDFs, etc.)
// Markdown files are excluded; all paths are validated against the section root.
app.get('/files/:root/*', (req, res) => {
  const rootName = req.params.root;
  if (!ALLOWED_ROOTS.has(rootName)) return res.status(403).send('Forbidden');

  const sectionRoot = getSectionRoot(rootName);
  const relPath = req.params[0];
  const absPath = path.resolve(sectionRoot, relPath);

  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).send('Forbidden');
  if (path.extname(absPath).toLowerCase() === '.md') return res.status(403).send('Forbidden');
  if (!fs.existsSync(absPath)) return res.status(404).send('Not found');

  res.sendFile(absPath);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = app;
