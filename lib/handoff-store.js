'use strict';

const fs = require('fs');
const path = require('path');

// Handoffs are instruction documents written in the working station and carried out in
// gd-design-studio. One markdown file per handoff, under <project>/handoffs/, with its
// state in YAML frontmatter:
//
//   ---
//   status: open
//   created: 2026-09-27
//   ---
//
// Frontmatter rather than open/ and closed/ folders because the path is the thing handed
// across the repo boundary — closing a handoff must not invalidate a link to it.
//
// Only `status` is ever written by the dashboard. The parser below is deliberately not a
// general YAML implementation: it reads flat `key: value` pairs and preserves every line
// it doesn't recognise, so anything else in the block survives a round-trip untouched.

const HANDOFF_DIR = 'handoffs';
const STATUSES = ['open', 'closed'];

/** Splits leading `---\n…\n---` off a markdown string. Mirrors editor-core.js's splitFrontmatter. */
function splitFrontmatter(md) {
  const m = (md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { raw: m[0], yaml: m[1], body: md.slice(m[0].length) } : { raw: '', yaml: '', body: md || '' };
}

/** Flat `key: value` pairs. Lines that aren't a pair are ignored for reading (but kept on write). */
function parseYamlBlock(yaml) {
  const out = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Rewrites one key inside an existing frontmatter block, leaving every other line — order,
 * spacing, unknown keys, comments — exactly as it was. Appends the key if absent.
 */
function setYamlKey(yaml, key, value) {
  const lines = yaml.split('\n');
  let found = false;
  const updated = lines.map(line => {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1] === key) { found = true; return `${key}: ${value}`; }
    return line;
  });
  if (!found) updated.push(`${key}: ${value}`);
  return updated.join('\n');
}

/** First `# Heading` in the body, falling back to the filename. */
function titleOf(body, name) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : name;
}

function handoffDirFor(projectsRoot, projectPath) {
  return path.join(projectsRoot, projectPath, HANDOFF_DIR);
}

/**
 * Reads one project's handoffs. Returns [] when the project has no handoffs/ folder —
 * most projects won't, and that is not an error.
 *
 * @param {string} projectsRoot  absolute path to the projects section root
 * @param {string} projectPath   project folder path relative to it, e.g. active-features/parameters
 */
function readHandoffs(projectsRoot, projectPath) {
  const dir = handoffDirFor(projectsRoot, projectPath);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(file => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { yaml, body } = splitFrontmatter(raw);
      const meta = parseYamlBlock(yaml);
      const name = file.replace(/\.md$/, '');
      return {
        id: path.posix.join(projectPath, HANDOFF_DIR, file),
        project: projectPath,
        name,
        title: titleOf(body, name),
        // A file with no frontmatter, or an unrecognised status, counts as open: an
        // unreadable handoff should surface rather than silently vanish into Closed.
        status: STATUSES.includes(meta.status) ? meta.status : 'open',
        created: meta.created || null,
        path: path.posix.join(projectPath, HANDOFF_DIR, file),
      };
    })
    .sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.name.localeCompare(b.name));
}

/** Groups a project's handoffs for the sidebar panel. */
function splitHandoffs(handoffs) {
  return {
    open: handoffs.filter(h => h.status === 'open'),
    closed: handoffs.filter(h => h.status === 'closed'),
  };
}

function toKebab(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Creates a new handoff from the template. Returns the created handoff, or throws if a
 * file of that name already exists — overwriting someone's instructions silently would be
 * the worst possible failure mode here.
 */
function createHandoff(projectsRoot, projectPath, name) {
  const slug = toKebab(name);
  if (!slug) throw new Error('Handoff name is empty after slugifying');

  const dir = handoffDirFor(projectsRoot, projectPath);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${slug}.md`);
  if (fs.existsSync(file)) throw new Error(`Handoff already exists: ${slug}.md`);

  const today = new Date().toISOString().slice(0, 10);
  const content =
    `---\nstatus: open\ncreated: ${today}\n---\n\n` +
    `# ${name}\n\n` +
    `## What to produce\n\n\n` +
    `## Context\n\n\n` +
    `## Done when\n\n\n`;

  fs.writeFileSync(file, content, 'utf8');
  return readHandoffs(projectsRoot, projectPath).find(h => h.name === slug);
}

/**
 * Sets a handoff's status, rewriting only the `status:` line. The body is never touched,
 * and a file that somehow has no frontmatter gets one prepended.
 */
function setHandoffStatus(projectsRoot, relPath, status) {
  if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);

  const abs = path.join(projectsRoot, relPath);
  if (!fs.existsSync(abs)) return null;

  const original = fs.readFileSync(abs, 'utf8');
  const { raw, yaml, body } = splitFrontmatter(original);

  const nextYaml = setYamlKey(raw ? yaml : `created: ${new Date().toISOString().slice(0, 10)}`, 'status', status);
  fs.writeFileSync(abs, `---\n${nextYaml}\n---\n${raw ? body : '\n' + body}`, 'utf8');

  const projectPath = path.posix.dirname(path.posix.dirname(relPath));
  return readHandoffs(projectsRoot, projectPath).find(h => h.path === relPath) || null;
}

module.exports = {
  HANDOFF_DIR,
  STATUSES,
  readHandoffs,
  splitHandoffs,
  createHandoff,
  setHandoffStatus,
  // exported for tests
  splitFrontmatter,
  parseYamlBlock,
  setYamlKey,
  toKebab,
};
