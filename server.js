require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const app = express();
const PORT = process.env.PORT || 3001;
const WORKSPACE_ID = process.env.WORKSPACE || 'work';
const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry.json'), 'utf8'));
const ws = registry.workspaces.find(w => w.id === WORKSPACE_ID);
if (!ws) throw new Error(`Unknown workspace: ${WORKSPACE_ID}`);
const workspaceConfig = JSON.parse(fs.readFileSync(path.join(ws.path, 'workspace.json'), 'utf8'));

const REPO_ROOT = ws.path;
const NOTION_DATA_SOURCE = ws.notionDatabaseId;
const ALLOWED_ROOTS = new Set(ws.features);
const PROJECT_GROUP_PREFIXES = workspaceConfig.projectGroups;

function getSectionRoot(rootName) {
  const custom = ws.customRoots && ws.customRoots[rootName];
  return custom ? path.normalize(custom) : path.join(REPO_ROOT, rootName);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Project overview helpers ────────────────────────────────────────────────

// Groups that live one level deep from their prefix (group/project/README.md)

function detectProjectReadme(relPath) {
  for (const g of PROJECT_GROUP_PREFIXES) {
    if (!relPath.startsWith(g.prefix)) continue;
    const rest  = relPath.slice(g.prefix.length).split('/');
    // must be exactly {folder-name}/README.md
    if (rest.length === 2 && rest[1] === 'README.md') return { ...g, folderName: rest[0] };
  }
  return null;
}

function addToProjectsOverview(relPath, status, name) {
  const match = detectProjectReadme(relPath);
  if (!match) return;

  const overviewPath = path.join(REPO_ROOT, 'projects', 'README.md');
  if (!fs.existsSync(overviewPath)) return;

  const lines = fs.readFileSync(overviewPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const projectName = name || match.folderName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const newRow = `| [${projectName}](${match.prefix}${match.folderName}/README.md) | ${status} |`;

  let inSection = false, inSub = match.sub === null, insertAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === match.section)           { inSection = true; inSub = match.sub === null; continue; }
    if (inSection && line === match.sub)  { inSub = true; continue; }
    if (inSection && inSub) {
      if (line.startsWith('|'))           { insertAt = i + 1; }
      // stop at next section/subsection heading
      if (line.startsWith('## ') || (match.sub && line.startsWith('### '))) break;
    }
  }

  if (insertAt === -1) return;
  lines.splice(insertAt, 0, newRow);
  fs.writeFileSync(overviewPath, lines.join('\n'), 'utf8');
}

const README_TEMPLATE_WORK = (title, status) =>
`# ${title}

**Status:** ${status}
**Notion Project:** ${title}

## Goal

## Context

## To-Do

- [ ]

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
**Notion Project:** ${title}

## Goal

## To-Do

- [ ]

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
    const rowMatch = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(\S+)\s*\|/);
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
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
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
  if (!relPath || !relPath.endsWith('.md')) return res.status(400).json({ error: 'Path must end with .md' });

  const sectionRoot = getSectionRoot(rootName);
  const absPath = path.resolve(sectionRoot, relPath);
  if (!absPath.startsWith(sectionRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  if (fs.existsSync(absPath)) return res.status(409).json({ error: 'File already exists' });

  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const heading = path.basename(relPath, '.md').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const projectMatch = rootName === 'projects' && detectProjectReadme(relPath);
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
  if (!relPath || !relPath.endsWith('.md')) return res.status(400).json({ error: 'Only .md files can be deleted' });

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
  if (!relPath || !relPath.endsWith('.md')) return res.status(400).json({ error: 'Path must end with .md' });

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
  if (!fromAbs.endsWith('.md')) return res.status(400).json({ error: 'Only .md files can be moved' });
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

  const content = fs.readFileSync(overviewPath, 'utf8').replace(/\r\n/g, '\n');
  const groups = [];
  let cur = null;

  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      if (cur) groups.push(cur);
      cur = { label: h2[1].trim(), prefix: null };
      continue;
    }
    if (cur && cur.prefix === null) {
      const m = line.match(/\[.*?\]\((.+?)\/[^/]+\/README\.md\)/);
      if (m) cur.prefix = m[1] + '/';
    }
  }
  if (cur) groups.push(cur);

  for (const g of groups) {
    if (g.prefix === null) {
      g.prefix = g.label.toLowerCase()
        .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '/';
    }
  }

  res.json(groups);
});

// GET /api/tasks — live data from Notion
const TODAY_STATUSES   = new Set(['In progress', 'Today']);
const IGNORED_STATUSES = new Set(['Done']);

const mapPage = (page) => ({
  id: page.id,
  title: page.properties['Name']?.title[0]?.plain_text ?? '(untitled)',
  status: page.properties['Status']?.status?.name ?? null,
  project: page.properties['Project']?.select?.name ?? null,
  jobType: page.properties['Job Type']?.select?.name ?? null,
  activity: (page.properties['Activity']?.multi_select ?? []).map(a => a.name),
  folder: page.properties['Folder']?.select?.name ?? null,
  url: page.url,
});

app.get('/api/tasks', async (req, res) => {
  if (!process.env.NOTION_API_KEY) {
    console.log('[tasks] NOTION_API_KEY not set — returning disconnected');
    return res.json({ connected: false });
  }

  console.log('[tasks] fetching from Notion...');
  try {
    const response = await notion.dataSources.query({
      data_source_id: NOTION_DATA_SOURCE,
      page_size: 100,
    });

    console.log(`[tasks] got ${response.results.length} pages`);

    const projectFilter = req.query.project || null;

    let tasks = response.results.map(mapPage).filter(t => t.status && !IGNORED_STATUSES.has(t.status));
    if (projectFilter) tasks = tasks.filter(t => t.project === projectFilter);
    const today   = tasks.filter(t => TODAY_STATUSES.has(t.status));
    const backlog = tasks.filter(t => !TODAY_STATUSES.has(t.status));

    console.log(`[tasks] today=${today.length} backlog=${backlog.length}`);
    res.json({ connected: true, today, backlog });
  } catch (err) {
    console.error('[tasks] Notion error:', err.message);
    res.status(500).json({ connected: false, error: err.message });
  }
});

// POST /api/tasks — create a new task in Notion
app.post('/api/tasks', async (req, res) => {
  const { title, project, status, jobType, activity, folder } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const properties = {
      Name: { title: [{ text: { content: title } }] },
    };
    if (project)          properties['Project']  = { select: { name: project } };
    if (status)           properties['Status']   = { status: { name: status } };
    if (jobType)          properties['Job Type'] = { select: { name: jobType } };
    if (activity?.length) properties['Activity'] = { multi_select: activity.map(a => ({ name: a })) };
    if (folder)           properties['Folder']   = { select: { name: folder } };
    const page = await notion.pages.create({
      parent: { data_source_id: NOTION_DATA_SOURCE },
      properties,
    });
    res.json({ ok: true, task: mapPage(page) });
  } catch (err) {
    console.error('[tasks] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tasks/:id — update a task
app.put('/api/tasks/:id', async (req, res) => {
  const { title, status, project, jobType, activity, folder } = req.body;
  try {
    const properties = {};
    if (title)               properties['Name']     = { title: [{ text: { content: title } }] };
    if (status)              properties['Status']   = { status: { name: status } };
    if (project !== undefined)  properties['Project']  = project ? { select: { name: project } } : { select: null };
    if (jobType !== undefined)  properties['Job Type'] = jobType ? { select: { name: jobType } } : { select: null };
    if (folder !== undefined)   properties['Folder']   = folder  ? { select: { name: folder  } } : { select: null };
    if (activity !== undefined) properties['Activity'] = { multi_select: (activity || []).map(a => ({ name: a })) };
    await notion.pages.update({ page_id: req.params.id, properties });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] update error:', err.message);
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

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
