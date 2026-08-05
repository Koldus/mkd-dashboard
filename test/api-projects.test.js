'use strict';

const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const FIXTURE_WORKSPACE = path.join(__dirname, 'fixtures', 'workspace');

let app;
let tempDir;

beforeAll(() => {
  // Copy fixture workspace to a fresh temp directory so mutations don't affect fixtures.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-test-'));
  fs.cpSync(FIXTURE_WORKSPACE, tempDir, { recursive: true });

  // Write a registry that points at the temp directory.
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

  // Reset module cache so server.js boots fresh with the new env vars.
  jest.resetModules();
  app = require('../server');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── GET /api/project-groups ──────────────────────────────────────────────

describe('GET /api/project-groups', () => {
  test('returns groups with prefixes derived from projects/README.md', async () => {
    const res = await request(app).get('/api/project-groups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Active Features', prefix: 'active-features/' }),
      expect.objectContaining({ label: 'Other Projects',  prefix: 'other-projects/'  }),
    ]));
  });

  test('returns the correct prefix for a sub-group section', async () => {
    const res    = await request(app).get('/api/project-groups');
    const backlog = res.body.find(g => g.label === 'Feature Backlog');
    expect(backlog).toBeDefined();
    expect(backlog.prefix).toBe('feature-backlog/q3/');
  });

  test('returns a wrong prefix when the first link in a section has a wrong path', async () => {
    // Temporarily corrupt the overview to reproduce the bug scenario.
    const overviewPath = path.join(tempDir, 'projects', 'README.md');
    const original     = fs.readFileSync(overviewPath, 'utf8');
    const corrupted    = original.replace(
      '| [Other Item](other-projects/other-item/README.md) | backlog |',
      '| [Misplaced](feature-backlog/other-projects/misplaced/README.md) | backlog |'
    );
    fs.writeFileSync(overviewPath, corrupted);

    const res   = await request(app).get('/api/project-groups');
    const group = res.body.find(g => g.label === 'Other Projects');
    expect(group.prefix).toBe('feature-backlog/other-projects/');

    // Restore the overview for subsequent tests.
    fs.writeFileSync(overviewPath, original);
  });
});

// ── GET /api/projects ────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  test('returns projects parsed from the overview README', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name:     'Existing Project',
        path:     'active-features/existing-project/README.md',
        status:   'active',
        category: 'Active Features',
      }),
    ]));
  });
});

// ── POST /api/project-file ───────────────────────────────────────────────

describe('POST /api/project-file', () => {
  test('creates a project README with the template and registers it in the overview', async () => {
    const res = await request(app)
      .post('/api/project-file')
      .send({ root: 'projects', path: 'other-projects/brand-new/README.md', name: 'Brand New' });
    expect(res.status).toBe(200);

    const filePath = path.join(tempDir, 'projects', 'other-projects', 'brand-new', 'README.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('**Status:** backlog');
    expect(content).toContain('## Goal');

    const overview = fs.readFileSync(path.join(tempDir, 'projects', 'README.md'), 'utf8');
    expect(overview).toContain('| [Brand New](other-projects/brand-new/README.md) | backlog |');
  });

  test('creates a plain file and does not touch the overview for a non-project path', async () => {
    const overviewBefore = fs.readFileSync(path.join(tempDir, 'projects', 'README.md'), 'utf8');

    const res = await request(app)
      .post('/api/project-file')
      .send({ root: 'projects', path: 'active-features/existing-project/notes.md' });
    expect(res.status).toBe(200);

    const filePath = path.join(tempDir, 'projects', 'active-features', 'existing-project', 'notes.md');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Notes\n');

    const overviewAfter = fs.readFileSync(path.join(tempDir, 'projects', 'README.md'), 'utf8');
    expect(overviewAfter).toBe(overviewBefore);
  });

  test('returns 409 when the file already exists', async () => {
    const res = await request(app)
      .post('/api/project-file')
      .send({ root: 'projects', path: 'active-features/existing-project/README.md' });
    expect(res.status).toBe(409);
  });

  test('returns 403 for a path that escapes the section root', async () => {
    const res = await request(app)
      .post('/api/project-file')
      .send({ root: 'projects', path: '../escape/README.md' });
    expect(res.status).toBe(403);
  });

  test('returns 403 for a root not in ws.features', async () => {
    const res = await request(app)
      .post('/api/project-file')
      .send({ root: 'f1', path: 'Active/something/README.md' });
    expect(res.status).toBe(403);
  });
});

// ── PUT /api/project-status ──────────────────────────────────────────────

describe('PUT /api/project-status', () => {
  test('updates status in the overview row and in the project README', async () => {
    const res = await request(app)
      .put('/api/project-status')
      .send({ path: 'active-features/existing-project/README.md', status: 'on hold' });
    expect(res.status).toBe(200);

    const overview = fs.readFileSync(path.join(tempDir, 'projects', 'README.md'), 'utf8');
    expect(overview).toContain('active-features/existing-project/README.md) | on hold |');

    const readme = fs.readFileSync(
      path.join(tempDir, 'projects', 'active-features', 'existing-project', 'README.md'), 'utf8'
    );
    expect(readme).toContain('**Status:** on hold');
  });

  test('returns 404 for a project not present in the overview', async () => {
    const res = await request(app)
      .put('/api/project-status')
      .send({ path: 'active-features/nonexistent/README.md', status: 'backlog' });
    expect(res.status).toBe(404);
  });

  test('returns 400 for an invalid status value', async () => {
    const res = await request(app)
      .put('/api/project-status')
      .send({ path: 'active-features/existing-project/README.md', status: 'invented' });
    expect(res.status).toBe(400);
  });
});
