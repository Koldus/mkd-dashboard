'use strict';

const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const {
  readHandoffs,
  splitHandoffs,
  createHandoff,
  setHandoffStatus,
  splitFrontmatter,
  setYamlKey,
} = require('../lib/handoff-store');

const FIXTURE_WORKSPACE = path.join(__dirname, 'fixtures', 'workspace');
const PROJECT = 'active-features/existing-project';

let app;
let tempDir;
let projectsRoot;
let handoffDir;

function writeHandoff(name, content) {
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(path.join(handoffDir, name), content, 'utf8');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-handoff-test-'));
  fs.cpSync(FIXTURE_WORKSPACE, tempDir, { recursive: true });
  projectsRoot = path.join(tempDir, 'projects');
  handoffDir   = path.join(projectsRoot, PROJECT, 'handoffs');

  const registryPath = path.join(tempDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    workspaces: [{
      id: 'test',
      name: 'Test Workspace',
      path: tempDir,
      features: ['projects', 'meetings'],
    }],
  }));

  process.env.REGISTRY_PATH = registryPath;
  process.env.WORKSPACE     = 'test';
  jest.resetModules();
  app = require('../server');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── lib/handoff-store ────────────────────────────────────────────────────

describe('handoff-store', () => {
  test('returns [] when the project has no handoffs folder', () => {
    expect(readHandoffs(projectsRoot, PROJECT)).toEqual([]);
  });

  test('reads status and created from frontmatter, title from the first heading', () => {
    writeHandoff('column-level.md', '---\nstatus: open\ncreated: 2026-09-20\n---\n\n# Column-level permissions\n\nbody\n');
    const [h] = readHandoffs(projectsRoot, PROJECT);
    expect(h).toMatchObject({
      project: PROJECT,
      name: 'column-level',
      title: 'Column-level permissions',
      status: 'open',
      created: '2026-09-20',
      path: `${PROJECT}/handoffs/column-level.md`,
    });
  });

  test('falls back to the filename when there is no heading', () => {
    writeHandoff('no-heading.md', '---\nstatus: open\n---\n\njust text\n');
    expect(readHandoffs(projectsRoot, PROJECT)[0].title).toBe('no-heading');
  });

  test('a file with no frontmatter counts as open rather than vanishing', () => {
    writeHandoff('bare.md', '# Bare handoff\n\nno frontmatter at all\n');
    const [h] = readHandoffs(projectsRoot, PROJECT);
    expect(h.status).toBe('open');
    expect(h.created).toBeNull();
  });

  test('an unrecognised status counts as open', () => {
    writeHandoff('weird.md', '---\nstatus: banana\n---\n\n# Weird\n');
    expect(readHandoffs(projectsRoot, PROJECT)[0].status).toBe('open');
  });

  test('splitHandoffs groups by status', () => {
    writeHandoff('a.md', '---\nstatus: open\ncreated: 2026-09-01\n---\n\n# A\n');
    writeHandoff('b.md', '---\nstatus: closed\ncreated: 2026-09-02\n---\n\n# B\n');
    const { open, closed } = splitHandoffs(readHandoffs(projectsRoot, PROJECT));
    expect(open.map(h => h.title)).toEqual(['A']);
    expect(closed.map(h => h.title)).toEqual(['B']);
  });

  test('createHandoff writes the template with today\'s date and open status', () => {
    const h = createHandoff(projectsRoot, PROJECT, 'Column-level permissions — scenario');
    expect(h.name).toBe('column-level-permissions-scenario');
    expect(h.status).toBe('open');

    const raw = fs.readFileSync(path.join(handoffDir, 'column-level-permissions-scenario.md'), 'utf8');
    expect(raw).toMatch(/^---\nstatus: open\ncreated: \d{4}-\d{2}-\d{2}\n---\n/);
    expect(raw).toContain('# Column-level permissions — scenario');
    expect(raw).toContain('## What to produce');
  });

  test('createHandoff refuses to overwrite an existing handoff', () => {
    createHandoff(projectsRoot, PROJECT, 'Same name');
    expect(() => createHandoff(projectsRoot, PROJECT, 'Same name')).toThrow(/already exists/);
  });

  test('setHandoffStatus changes only the status line, leaving the body byte-identical', () => {
    const body = '\n# Keep me\n\nBody with *markdown* and a - [ ] checkbox.\n\n## Section\n\ntext\n';
    writeHandoff('keep.md', `---\nstatus: open\ncreated: 2026-09-20\n---${body}`);

    setHandoffStatus(projectsRoot, `${PROJECT}/handoffs/keep.md`, 'closed');

    const raw = fs.readFileSync(path.join(handoffDir, 'keep.md'), 'utf8');
    expect(raw).toBe(`---\nstatus: closed\ncreated: 2026-09-20\n---${body}`);
  });

  test('setHandoffStatus preserves unknown frontmatter keys', () => {
    writeHandoff('extra.md', '---\nstatus: open\ncreated: 2026-09-20\nconfluence: https://example/x\n---\n\n# Extra\n');
    setHandoffStatus(projectsRoot, `${PROJECT}/handoffs/extra.md`, 'closed');
    const raw = fs.readFileSync(path.join(handoffDir, 'extra.md'), 'utf8');
    expect(raw).toContain('confluence: https://example/x');
    expect(raw).toContain('status: closed');
  });

  test('setHandoffStatus adds frontmatter to a file that has none', () => {
    writeHandoff('bare.md', '# Bare\n\ntext\n');
    setHandoffStatus(projectsRoot, `${PROJECT}/handoffs/bare.md`, 'closed');
    const raw = fs.readFileSync(path.join(handoffDir, 'bare.md'), 'utf8');
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain('status: closed');
    expect(raw).toContain('# Bare');
  });

  test('setYamlKey rewrites in place and appends when missing', () => {
    expect(setYamlKey('status: open\ncreated: x', 'status', 'closed')).toBe('status: closed\ncreated: x');
    expect(setYamlKey('created: x', 'status', 'open')).toBe('created: x\nstatus: open');
  });

  test('splitFrontmatter matches editor-core: only a leading block counts', () => {
    expect(splitFrontmatter('# Title\n\n---\nnot: frontmatter\n---\n').raw).toBe('');
    expect(splitFrontmatter('---\na: 1\n---\nbody').raw).toBe('---\na: 1\n---\n');
  });
});

// ── routes ───────────────────────────────────────────────────────────────

describe('GET /api/handoffs', () => {
  test('returns grouped handoffs for a project', async () => {
    writeHandoff('a.md', '---\nstatus: open\ncreated: 2026-09-01\n---\n\n# A\n');
    writeHandoff('b.md', '---\nstatus: closed\ncreated: 2026-09-02\n---\n\n# B\n');

    const res = await request(app).get('/api/handoffs').query({ project: PROJECT });
    expect(res.status).toBe(200);
    expect(res.body.open.map(h => h.title)).toEqual(['A']);
    expect(res.body.closed.map(h => h.title)).toEqual(['B']);
  });

  test('returns empty groups for a project with no handoffs', async () => {
    const res = await request(app).get('/api/handoffs').query({ project: PROJECT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: [], closed: [] });
  });

  test('400s without a project', async () => {
    expect((await request(app).get('/api/handoffs')).status).toBe(400);
  });

  test('403s on a path that escapes the projects root', async () => {
    const res = await request(app).get('/api/handoffs').query({ project: '../../etc' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/handoffs', () => {
  test('creates a handoff and returns it', async () => {
    const res = await request(app).post('/api/handoffs').send({ project: PROJECT, name: 'New Handoff' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'new-handoff', status: 'open', project: PROJECT });
    expect(fs.existsSync(path.join(handoffDir, 'new-handoff.md'))).toBe(true);
  });

  test('400s on a duplicate name rather than overwriting', async () => {
    await request(app).post('/api/handoffs').send({ project: PROJECT, name: 'Dup' });
    const res = await request(app).post('/api/handoffs').send({ project: PROJECT, name: 'Dup' });
    expect(res.status).toBe(400);
  });

  test('403s on a path that escapes the projects root', async () => {
    const res = await request(app).post('/api/handoffs').send({ project: '../../etc', name: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/handoffs/*', () => {
  test('flips status and returns the updated handoff', async () => {
    writeHandoff('a.md', '---\nstatus: open\ncreated: 2026-09-01\n---\n\n# A\n');

    const res = await request(app)
      .put(`/api/handoffs/${PROJECT}/handoffs/a.md`)
      .send({ status: 'closed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(fs.readFileSync(path.join(handoffDir, 'a.md'), 'utf8')).toContain('status: closed');
  });

  test('rejects a status outside the vocabulary', async () => {
    writeHandoff('a.md', '---\nstatus: open\n---\n\n# A\n');
    const res = await request(app)
      .put(`/api/handoffs/${PROJECT}/handoffs/a.md`)
      .send({ status: 'archived' });
    expect(res.status).toBe(400);
  });

  test('404s for a handoff that does not exist', async () => {
    const res = await request(app)
      .put(`/api/handoffs/${PROJECT}/handoffs/missing.md`)
      .send({ status: 'closed' });
    expect(res.status).toBe(404);
  });
});
