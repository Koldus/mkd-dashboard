'use strict';

const fs = require('fs');
const path = require('path');

const TODAY_STATUSES = new Set(['In progress', 'Today']);
const IGNORED_STATUSES = new Set(['Done']);

/**
 * Reads REPO_ROOT/tasks.json. Returns [] if the file doesn't exist yet.
 *
 * @param {string} repoRoot
 * @returns {Array}
 */
function readTasks(repoRoot) {
  const tasksPath = path.join(repoRoot, 'tasks.json');
  if (!fs.existsSync(tasksPath)) return [];
  return JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
}

/**
 * Writes the full tasks array back to REPO_ROOT/tasks.json.
 *
 * @param {string} repoRoot
 * @param {Array} tasks
 */
function writeTasks(repoRoot, tasks) {
  const tasksPath = path.join(repoRoot, 'tasks.json');
  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');
}

/**
 * Pure core of GET /api/tasks: filters out Done tasks, optionally by project,
 * then splits into today vs backlog based on status.
 *
 * @param {Array} tasks
 * @param {string|null} projectFilter
 * @returns {{today: Array, backlog: Array}}
 */
function splitTasks(tasks, projectFilter) {
  let visible = tasks.filter(t => !IGNORED_STATUSES.has(t.status));
  if (projectFilter) visible = visible.filter(t => t.project === projectFilter);
  const today = visible.filter(t => TODAY_STATUSES.has(t.status));
  const backlog = visible.filter(t => !TODAY_STATUSES.has(t.status));
  return { today, backlog };
}

module.exports = { readTasks, writeTasks, splitTasks, TODAY_STATUSES, IGNORED_STATUSES };
