'use strict';

const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const { readConversations, writeConversations } = require('../lib/conversation-store');

const FIXTURE_WORKSPACE = path.join(__dirname, 'fixtures', 'workspace');

let app;
let tempDir;
let convPath;

// A captured entry carrying every field the two skills own, so the patch route can be
// checked for leaving them alone.
const ENTRY = {
  id: 'D02333SVD51:1756890473.730989',
  channel: 'DM (self)',
  channelId: 'D02333SVD51',
  threadTs: null,
  permalink: 'https://gooddata.slack.com/archives/D02333SVD51/p1756890473730989',
  author: 'Miroslav Koldus',
  excerpt: 'Describe InsightView the way Thoughtspot described Muze',
  type: 'idea',
  status: 'open',
  projectPath: 'ps-projects/mekko-chart',
  projectName: 'Mekko Chart',
  source: 'inbox',
  captureNote: 'into the geochart project as an open idea',
  notes: null,
  notesUpdatedAt: null,
  firstSeen: '2026-09-22T08:00:00Z',
  lastUpdated: '2026-09-22T08:00:00Z',
  draftResponse: 'a draft that propose-response wrote',
  draftUpdatedAt: '2026-09-22T09:00:00Z',
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-conv-test-'));
  fs.cpSync(FIXTURE_WORKSPACE, tempDir, { recursive: true });
  convPath = path.join(tempDir, 'conversations.json');

  const registryPath = path.join(tempDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    workspaces: [{
      id: 'test',
      name: 'Test Workspace',
      path: tempDir,
      // 'conversations' must be present or every route below 403s.
      features: ['projects', 'meetings', 'conversations'],
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

// ── lib/conversation-store ───────────────────────────────────────────────

describe('conversation-store', () => {
  test('returns [] when the file does not exist', () => {
    expect(fs.existsSync(convPath)).toBe(false);
    expect(readConversations(tempDir)).toEqual([]);
  });

  test('round-trips an array as 2-space indented JSON', () => {
    writeConversations(tempDir, [ENTRY]);
    expect(readConversations(tempDir)).toEqual([ENTRY]);
    expect(fs.readFileSync(convPath, 'utf8')).toBe(JSON.stringify([ENTRY], null, 2));
  });
});

// ── GET / PUT /api/conversations ─────────────────────────────────────────

describe('GET /api/conversations', () => {
  test('returns [] rather than 500 when conversations.json is absent', async () => {
    const res = await request(app).get('/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns the stored entries', async () => {
    writeConversations(tempDir, [ENTRY]);
    const res = await request(app).get('/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(ENTRY.id);
  });
});

describe('PUT /api/conversations', () => {
  test('persists a full array', async () => {
    const res = await request(app).put('/api/conversations').send([ENTRY]);
    expect(res.status).toBe(200);
    expect(readConversations(tempDir)).toEqual([ENTRY]);
  });

  test('rejects a non-array', async () => {
    const res = await request(app).put('/api/conversations').send({ nope: true });
    expect(res.status).toBe(400);
  });
});

// ── PUT /api/conversations/:id ───────────────────────────────────────────

describe('PUT /api/conversations/:id', () => {
  beforeEach(() => writeConversations(tempDir, [ENTRY]));

  test('sets notes and notesUpdatedAt', async () => {
    const res = await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ notes: 'worth raising at the next sync' });

    expect(res.status).toBe(200);
    const stored = readConversations(tempDir)[0];
    expect(stored.notes).toBe('worth raising at the next sync');
    expect(stored.notesUpdatedAt).toEqual(expect.any(String));
  });

  // The field-ownership guarantee the whole design rests on: the dashboard may move
  // status and edit notes, and must not touch anything the skills own.
  test('leaves skill-owned fields untouched', async () => {
    await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ notes: 'mine' });

    const stored = readConversations(tempDir)[0];
    expect(stored.captureNote).toBe(ENTRY.captureNote);
    expect(stored.draftResponse).toBe(ENTRY.draftResponse);
    expect(stored.draftUpdatedAt).toBe(ENTRY.draftUpdatedAt);
    expect(stored.excerpt).toBe(ENTRY.excerpt);
    expect(stored.type).toBe(ENTRY.type);
    expect(stored.status).toBe(ENTRY.status);
    expect(stored.source).toBe(ENTRY.source);
    expect(stored.firstSeen).toBe(ENTRY.firstSeen);
  });

  test('ignores fields outside the whitelist', async () => {
    await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ excerpt: 'rewritten', type: 'question', captureNote: 'hijacked' });

    const stored = readConversations(tempDir)[0];
    expect(stored.excerpt).toBe(ENTRY.excerpt);
    expect(stored.type).toBe(ENTRY.type);
    expect(stored.captureNote).toBe(ENTRY.captureNote);
  });

  test('changes status without disturbing notes', async () => {
    await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ notes: 'kept' });
    await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ status: 'saved' });

    const stored = readConversations(tempDir)[0];
    expect(stored.status).toBe('saved');
    expect(stored.notes).toBe('kept');
  });

  test('clearing notes nulls both notes and notesUpdatedAt', async () => {
    await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ notes: 'temporary' });
    await request(app)
      .put(`/api/conversations/${encodeURIComponent(ENTRY.id)}`)
      .send({ notes: '' });

    const stored = readConversations(tempDir)[0];
    expect(stored.notes).toBeNull();
    expect(stored.notesUpdatedAt).toBeNull();
  });

  test('404s on an unknown id', async () => {
    const res = await request(app).put('/api/conversations/nope').send({ status: 'saved' });
    expect(res.status).toBe(404);
  });
});
