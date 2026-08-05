'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { readTasks, writeTasks, splitTasks } = require('../lib/task-store');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-tasks-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── readTasks / writeTasks ───────────────────────────────────────────────

describe('readTasks / writeTasks', () => {
  test('returns [] when tasks.json does not exist yet', () => {
    expect(readTasks(tempDir)).toEqual([]);
  });

  test('round-trips tasks written to tasks.json', () => {
    const tasks = [{ id: '1', title: 'Write docs', status: 'Backlog', project: null }];
    writeTasks(tempDir, tasks);

    expect(fs.existsSync(path.join(tempDir, 'tasks.json'))).toBe(true);
    expect(readTasks(tempDir)).toEqual(tasks);
  });
});

// ── splitTasks ────────────────────────────────────────────────────────────

describe('splitTasks', () => {
  const tasks = [
    { id: '1', title: 'In progress task', status: 'In progress', project: 'projects/a' },
    { id: '2', title: 'Today task',       status: 'Today',       project: 'projects/a' },
    { id: '3', title: 'Backlog task',     status: 'Backlog',     project: 'projects/b' },
    { id: '4', title: 'This week task',   status: 'This Week',   project: 'projects/b' },
    { id: '5', title: 'Done task',        status: 'Done',        project: 'projects/a' },
  ];

  test('splits into today vs backlog and drops Done tasks', () => {
    const { today, backlog } = splitTasks(tasks, null);
    expect(today.map(t => t.id)).toEqual(['1', '2']);
    expect(backlog.map(t => t.id)).toEqual(['3', '4']);
  });

  test('filters by project when a project filter is given', () => {
    const { today, backlog } = splitTasks(tasks, 'projects/a');
    expect(today.map(t => t.id)).toEqual(['1', '2']);
    expect(backlog).toEqual([]);
  });

  test('ignores the project filter when null', () => {
    const { today } = splitTasks(tasks, null);
    expect(today).toHaveLength(2);
  });
});
