'use strict';

// One-time migration: pulls open tasks from Notion and from project READMEs'
// "## To-Do" sections into REPO_ROOT/tasks.json, ahead of removing both the
// Notion integration and the README To-Do widget. Safe to delete after running.
//
// Usage: WORKSPACE=work node scripts/migrate-tasks.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('@notionhq/client');

const WORKSPACE_ID = process.env.WORKSPACE || 'work';
const REGISTRY_PATH = process.env.REGISTRY_PATH || path.join(__dirname, '..', 'registry.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const ws = registry.workspaces.find(w => w.id === WORKSPACE_ID);
if (!ws) throw new Error(`Unknown workspace: ${WORKSPACE_ID}`);
const REPO_ROOT = path.resolve(path.dirname(REGISTRY_PATH), ws.path);

const IGNORED_STATUSES = new Set(['Done']);

function parseProjects() {
  const content = fs.readFileSync(path.join(REPO_ROOT, 'projects', 'README.md'), 'utf8');
  const projects = [];
  let currentCategory = null;
  for (const line of content.split('\n')) {
    const headingMatch = line.match(/^## (.+)/);
    if (headingMatch) { currentCategory = headingMatch[1].trim(); continue; }
    const rowMatch = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|/);
    if (rowMatch && currentCategory) {
      projects.push({ name: rowMatch[1], path: rowMatch[2], status: rowMatch[3], category: currentCategory });
    }
  }
  return projects;
}

function projectFolder(p) {
  return p.path.replace(/\/[^/]+\.md$/, '');
}

async function migrateNotionTasks(projects) {
  if (!process.env.NOTION_API_KEY || !ws.notionDatabaseId) {
    console.log('[notion] NOTION_API_KEY or notionDatabaseId not set — skipping Notion migration');
    return [];
  }

  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const mapPage = (page) => ({
    title: page.properties['Name']?.title[0]?.plain_text ?? '(untitled)',
    status: page.properties['Status']?.status?.name ?? null,
    project: page.properties['Project']?.select?.name ?? null,
    activity: (page.properties['Activity']?.multi_select ?? []).map(a => a.name),
  });

  let results = [];
  let cursor = undefined;
  do {
    const response = await notion.dataSources.query({
      data_source_id: ws.notionDatabaseId,
      page_size: 100,
      start_cursor: cursor,
    });
    results = results.concat(response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`[notion] fetched ${results.length} pages`);

  const now = new Date().toISOString();
  const tasks = [];
  for (const page of results) {
    const t = mapPage(page);
    if (!t.status || IGNORED_STATUSES.has(t.status)) continue;

    let projectPath = null;
    if (t.project) {
      const match = projects.find(p => p.name.toLowerCase() === t.project.toLowerCase());
      if (match) {
        projectPath = projectFolder(match);
      } else {
        console.log(`[notion] no local project match for "${t.project}" — leaving unassigned (task: "${t.title}")`);
      }
    }

    tasks.push({
      id: crypto.randomUUID(),
      title: t.title,
      status: t.status,
      project: projectPath,
      activity: t.activity,
      createdAt: now,
      updatedAt: now,
    });
  }

  console.log(`[notion] migrated ${tasks.length} open tasks`);
  return tasks;
}

function parseTodoItems(lines) {
  const items = [];
  for (const raw of lines) {
    const item = raw.match(/^\s*- \[([ xX])\] (.+)/);
    if (item) {
      const text = item[2].trim();
      if (text) items.push({ text, checked: item[1].toLowerCase() === 'x' });
    }
  }
  return items;
}

function migrateTodoSections(projects) {
  const now = new Date().toISOString();
  const tasks = [];

  for (const p of projects) {
    const readmePath = path.join(REPO_ROOT, 'projects', p.path);
    if (!fs.existsSync(readmePath)) continue;
    const content = fs.readFileSync(readmePath, 'utf8');
    const lines = content.split('\n');

    let todoLines = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '## To-Do') {
        const start = i + 1;
        let end = lines.length;
        for (let j = start; j < lines.length; j++) {
          if (lines[j].match(/^## /)) { end = j; break; }
        }
        todoLines = lines.slice(start, end);
        break;
      }
    }
    if (!todoLines) continue;

    const items = parseTodoItems(todoLines);
    if (!items.length) continue;

    console.log(`[todo] ${p.path}: migrating ${items.length} item(s)`);
    for (const item of items) {
      tasks.push({
        id: crypto.randomUUID(),
        title: item.text,
        status: item.checked ? 'Done' : 'Backlog',
        project: projectFolder(p),
        activity: [],
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  console.log(`[todo] migrated ${tasks.length} items total`);
  return tasks;
}

async function main() {
  const projects = parseProjects();

  const notionTasks = await migrateNotionTasks(projects);
  const todoTasks = migrateTodoSections(projects);

  const tasksPath = path.join(REPO_ROOT, 'tasks.json');
  const existing = fs.existsSync(tasksPath) ? JSON.parse(fs.readFileSync(tasksPath, 'utf8')) : [];
  const combined = [...existing, ...notionTasks, ...todoTasks];

  fs.writeFileSync(tasksPath, JSON.stringify(combined, null, 2), 'utf8');
  console.log(`\nWrote ${combined.length} total tasks to ${tasksPath}`);
  console.log('Review the file, then hand-strip the "## To-Do" sections from the project READMEs listed above.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
