'use strict';

const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { execFileSync } = require('child_process');

const { parseStatusZ, classifyCode } = require('../lib/git-status');

const FIXTURE_WORKSPACE = path.join(__dirname, 'fixtures', 'workspace');

// ── Parser ───────────────────────────────────────────────────────────────
// All of the real risk lives here: the rename two-field consumption, the MM
// precedence and the f[2] separator offset.

describe('parseStatusZ', () => {
  test('returns [] for empty input', () => {
    expect(parseStatusZ('')).toEqual([]);
  });

  test('keeps paths containing spaces verbatim', () => {
    expect(parseStatusZ(' M path with spaces.md\0')).toEqual([
      { code: ' M', path: 'path with spaces.md' },
    ]);
  });

  test('parses several records and ignores the trailing empty field', () => {
    expect(parseStatusZ('?? new.md\0MM both.md\0A  staged.md\0')).toEqual([
      { code: '??', path: 'new.md' },
      { code: 'MM', path: 'both.md' },
      { code: 'A ', path: 'staged.md' },
    ]);
  });

  test('a rename keeps the new path and consumes the original-path field', () => {
    // In -z mode the record carries the NEW path; the original follows as its own field.
    expect(parseStatusZ('R  new.md\0old.md\0?? after.md\0')).toEqual([
      { code: 'R ', path: 'new.md' },
      { code: '??', path: 'after.md' },   // proves the old-path field was consumed
    ]);
  });

  test('a copy consumes its second field too', () => {
    expect(parseStatusZ('C  copy.md\0src.md\0 M next.md\0')).toEqual([
      { code: 'C ', path: 'copy.md' },
      { code: ' M', path: 'next.md' },
    ]);
  });
});

describe('classifyCode', () => {
  test.each([
    ['??', 'untracked'],
    [' M', 'modified'],
    ['M ', 'staged'],
    ['A ', 'staged'],
    ['R ', 'staged'],
    ['MM', 'modified'],   // unstaged on top of staged is the less-captured state
    ['AM', 'modified'],
    ['RM', 'modified'],
    ['UU', 'conflicted'],
    ['AA', 'conflicted'],
    ['DD', 'conflicted'],
    ['DU', 'conflicted'],
    ['  ', null],
  ])('%s -> %s', (code, expected) => {
    expect(classifyCode(code)).toBe(expected);
  });
});

// ── Route ────────────────────────────────────────────────────────────────

describe('GET /api/worktree-status', () => {
  let app, tempDir, worktreeParent, repoDir, f1Dir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-git-test-'));
    fs.cpSync(FIXTURE_WORKSPACE, tempDir, { recursive: true });

    // Build a real repo at runtime rather than committing a fixture .git directory.
    worktreeParent = path.join(tempDir, 'worktrees');
    repoDir = path.join(worktreeParent, 'feat+demo');
    f1Dir   = path.join(repoDir, 'projects', 'F1', 'Active', 'Demo');
    fs.mkdirSync(path.join(f1Dir, 'nested'), { recursive: true });
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repoDir]);

    fs.writeFileSync(path.join(f1Dir, 'a.md'), 'one\n');
    fs.writeFileSync(path.join(f1Dir, 'nested', 'b.md'), 'two\n');
    fs.writeFileSync(path.join(f1Dir, 'image.png'), 'not markdown');
    execFileSync('git', ['-C', repoDir, 'add', 'projects/F1/Active/Demo/a.md']);
    // No commit needed: `git add` then edit yields AM (modified) alongside ?? (untracked).
    fs.appendFileSync(path.join(f1Dir, 'a.md'), 'edited\n');

    // A sibling directory that is not a git repository.
    fs.mkdirSync(path.join(worktreeParent, 'plain', 'projects', 'F1', 'Active', 'Demo'),
      { recursive: true });

    const registryPath = path.join(tempDir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      workspaces: [{
        id: 'test',
        name: 'Test Workspace',
        path: tempDir,
        features: ['projects', 'meetings'],
        worktreeDirs: [worktreeParent],
      }],
    }));

    process.env.REGISTRY_PATH = registryPath;
    process.env.WORKSPACE     = 'test';
    jest.resetModules();
    app = require('../server');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reports modified and untracked markdown, keyed relative to the F1 dir', async () => {
    const res = await request(app)
      .get('/api/worktree-status')
      .query({ worktree: repoDir, f1path: 'Active/Demo' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.statuses).toEqual({
      'a.md': 'modified',
      'nested/b.md': 'untracked',
    });
  });

  test('omits non-markdown files so folder rollups stay explainable', async () => {
    const res = await request(app)
      .get('/api/worktree-status')
      .query({ worktree: repoDir, f1path: 'Active/Demo' });
    expect(Object.keys(res.body.statuses)).not.toContain('image.png');
  });

  test('a directory that is not a git repo returns ok:false, not an error', async () => {
    const res = await request(app)
      .get('/api/worktree-status')
      .query({ worktree: path.join(worktreeParent, 'plain'), f1path: 'Active/Demo' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'not-a-repo', statuses: {} });
  });

  test('requires f1path', async () => {
    const res = await request(app).get('/api/worktree-status').query({ worktree: repoDir });
    expect(res.status).toBe(400);
  });

  test('rejects a worktree outside the configured dirs', async () => {
    const res = await request(app)
      .get('/api/worktree-status')
      .query({ worktree: path.join(tempDir, 'elsewhere'), f1path: 'Active/Demo' });
    expect(res.status).toBe(403);
  });
});

// ── Path traversal (regression) ──────────────────────────────────────────

describe('worktree path validation', () => {
  let app, tempDir, worktreeParent, repoDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-trav-test-'));
    fs.cpSync(FIXTURE_WORKSPACE, tempDir, { recursive: true });
    worktreeParent = path.join(tempDir, 'worktrees');
    repoDir = path.join(worktreeParent, 'wt');
    fs.mkdirSync(path.join(repoDir, 'projects', 'F1', 'Active', 'Demo'), { recursive: true });

    const registryPath = path.join(tempDir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      workspaces: [{
        id: 'test', name: 'Test Workspace', path: tempDir,
        features: ['projects', 'meetings'], worktreeDirs: [worktreeParent],
      }],
    }));
    process.env.REGISTRY_PATH = registryPath;
    process.env.WORKSPACE     = 'test';
    jest.resetModules();
    app = require('../server');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a worktree that walks out with .. is rejected', async () => {
    const res = await request(app)
      .get('/api/worktree-files')
      .query({ worktree: `${repoDir}/../../..`, f1path: 'Active/Demo' });
    expect(res.status).toBe(403);
  });

  test('an f1path that walks out of the worktree is rejected', async () => {
    const res = await request(app)
      .get('/api/worktree-files')
      .query({ worktree: repoDir, f1path: '../../../../.ssh' });
    expect(res.status).toBe(403);
  });

  test('a legitimate worktree request is still allowed', async () => {
    const res = await request(app)
      .get('/api/worktree-files')
      .query({ worktree: repoDir, f1path: 'Active/Demo' });
    expect(res.status).toBe(200);
  });
});
