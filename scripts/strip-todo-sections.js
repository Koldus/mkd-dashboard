'use strict';

// One-time cleanup: removes the "## To-Do" section (heading + content) from every
// project README, now that its content has been migrated into tasks.json by
// migrate-tasks.js. Safe to delete after running. Run migrate-tasks.js FIRST.
//
// Usage: WORKSPACE=work node scripts/strip-todo-sections.js

const fs = require('fs');
const path = require('path');

const WORKSPACE_ID = process.env.WORKSPACE || 'work';
const REGISTRY_PATH = process.env.REGISTRY_PATH || path.join(__dirname, '..', 'registry.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const ws = registry.workspaces.find(w => w.id === WORKSPACE_ID);
if (!ws) throw new Error(`Unknown workspace: ${WORKSPACE_ID}`);
const REPO_ROOT = path.resolve(path.dirname(REGISTRY_PATH), ws.path);

function findReadmes(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findReadmes(full));
    } else if (entry.name === 'README.md') {
      results.push(full);
    }
  }
  return results;
}

function stripTodoSection(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '## To-Do') {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(/^## /)) { end = j; break; }
      }
      break;
    }
  }
  if (start === -1) return null;

  // Rebuild: keep everything before the heading, then everything from the next heading on,
  // collapsing to exactly one blank line between the previous section and the next.
  const before = lines.slice(0, start);
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  const after = lines.slice(end);
  return [...before, '', ...after].join('\n');
}

const readmes = findReadmes(path.join(REPO_ROOT, 'projects'));
let changed = 0;
for (const file of readmes) {
  const content = fs.readFileSync(file, 'utf8');
  const updated = stripTodoSection(content);
  if (updated === null) continue;
  fs.writeFileSync(file, updated, 'utf8');
  changed++;
  console.log(`stripped: ${path.relative(REPO_ROOT, file)}`);
}

console.log(`\nDone. Stripped "## To-Do" from ${changed} file(s). Review with git diff before committing.`);
