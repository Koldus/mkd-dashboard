'use strict';

/**
 * Checks whether relPath is a project-level README under one of the known group prefixes.
 * A match requires exactly {prefix}{folder-name}/README.md — no extra path segments.
 *
 * @param {string} relPath  - path relative to the projects section root
 * @param {Array}  prefixes - projectGroups array from workspace.json
 * @returns match object (includes folderName) or null
 */
function detectProjectReadme(relPath, prefixes) {
  for (const g of prefixes) {
    if (!relPath.startsWith(g.prefix)) continue;
    const rest = relPath.slice(g.prefix.length).split('/');
    if (rest.length === 2 && rest[1] === 'README.md') return { ...g, folderName: rest[0] };
  }
  return null;
}

/**
 * Pure core of addToProjectsOverview.
 * Given the current lines of projects/README.md, returns a new array with a row inserted
 * for the new project, or null if no matching section was found.
 *
 * Does NOT mutate the input array.
 *
 * @param {string[]} lines    - current lines of projects/README.md
 * @param {string}   relPath  - project README path (relative to projects root)
 * @param {string}   status   - initial status string
 * @param {string}   name     - display name (null → humanized from folder name)
 * @param {Array}    prefixes - projectGroups array from workspace.json
 * @returns updated lines array, or null if insertion point not found
 */
function insertProjectOverviewRow(lines, relPath, status, name, prefixes) {
  const match = detectProjectReadme(relPath, prefixes);
  if (!match) return null;

  const projectName = name ||
    match.folderName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const newRow = `| [${projectName}](${match.prefix}${match.folderName}/README.md) | ${status} |`;

  let inSection = false, inSub = match.sub === null, insertAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === match.section)          { inSection = true; inSub = match.sub === null; continue; }
    if (inSection && line === match.sub) { inSub = true; continue; }
    if (inSection && inSub) {
      if (line.startsWith('|'))          { insertAt = i + 1; }
      if (line.startsWith('## ') || (match.sub && line.startsWith('### '))) break;
    }
  }

  if (insertAt === -1) return null;

  const updated = [...lines];
  updated.splice(insertAt, 0, newRow);
  return updated;
}

/**
 * Pure core of GET /api/project-groups.
 * Parses projects/README.md content and returns [{label, prefix}] for each ## section.
 *
 * The prefix for each group is derived from the first link found in that section —
 * everything up to the last two path segments (folder/README.md).
 *
 * IMPORTANT: if the first link in a section has a wrong path prefix, that wrong
 * prefix is returned for the whole group. This is the known failure mode — always
 * ensure link paths in projects/README.md match the workspace.json prefixes.
 *
 * @param {string} content - full text of projects/README.md
 * @returns {Array<{label: string, prefix: string}>}
 */
function parseProjectGroupsFromOverview(content) {
  const groups = [];
  let cur = null;

  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
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

  return groups;
}

module.exports = { detectProjectReadme, insertProjectOverviewRow, parseProjectGroupsFromOverview };
