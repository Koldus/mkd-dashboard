'use strict';

const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const {
  readScanReview,
  setCardDecision,
  splitCards,
  rewriteDecisionLine,
} = require('../lib/scan-review-store');

const FIXTURE_WORKSPACE = path.join(__dirname, 'fixtures', 'workspace');
const FIXTURE_REVIEW    = path.join(__dirname, 'fixtures', 'slack-scan-review.md');

const CARD_1 = 'C0AR3D0J1CY:1790355247.541499';  // kind=new, has Thread context
const CARD_2 = 'D026PA04KNH:1790334372.781269';  // kind=new, no Thread context, 2-para comment
const CARD_3 = 'C05H1HV1J2F:1787563791.649489';  // kind=update, Apply instead of Save

let app;
let tempDir;
let reviewPath;
let original;

/** Drops the fixture review file into the temp workspace, as a scan would. */
function placeReview() {
  fs.copyFileSync(FIXTURE_REVIEW, reviewPath);
  original = fs.readFileSync(reviewPath, 'utf8');
}

function boot(features = ['projects', 'meetings', 'conversations']) {
  const registryPath = path.join(tempDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    workspaces: [{ id: 'test', name: 'Test Workspace', path: tempDir, features }],
  }));

  process.env.REGISTRY_PATH = registryPath;
  process.env.WORKSPACE     = 'test';
  jest.resetModules();
  app = require('../server');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-scan-review-test-'));
  fs.cpSync(FIXTURE_WORKSPACE, tempDir, { recursive: true });
  reviewPath = path.join(tempDir, '.slack-scan-review.md');
  boot();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── lib/scan-review-store, parsing ───────────────────────────────────────

describe('readScanReview', () => {
  test('reports no pending review when the file is absent', () => {
    expect(readScanReview(tempDir)).toEqual({ exists: false });
  });

  test('reads the header and the read-only prose sections', () => {
    placeReview();
    const doc = readScanReview(tempDir);

    expect(doc.exists).toBe(true);
    expect(doc.title).toBe('Slack scan review — 2026-09-27 18:55');
    expect(doc.window).toMatch(/^Window: 2026-09-20 18:55/);
    expect(doc.summary).toBe('Found 2 new threads · 1 update (1 reopened) · 0 to close');
    // The card-bearing sections are not prose; the rest is shown read-only.
    expect(doc.sections.map(s => s.name)).toEqual(['Overview', 'Uncertain calls', 'Left out']);
  });

  test('parses every card, keyed by its card-end marker', () => {
    placeReview();
    const doc = readScanReview(tempDir);

    expect(doc.cards.map(c => c.id)).toEqual([CARD_1, CARD_2, CARD_3]);
    expect(doc.cards.map(c => c.kind)).toEqual(['new', 'new', 'update']);
    expect(doc.cards.map(c => c.number)).toEqual([1, 2, 3]);
    expect(doc.cards.map(c => c.section))
      .toEqual(['New threads', 'New threads', 'Updates to tracked threads']);
  });

  test('parses a new card: meta line, thread line, sections, decision, comment', () => {
    placeReview();
    const card = readScanReview(tempDir).cards[0];

    expect(card).toMatchObject({
      type: 'question',
      status: 'unanswered',
      project: 'object-level-permissions',
      proposed: 'reply',
      last: '1790355247.541499',
      uncertain: false,
    });
    expect(card.permalink)
      .toBe('https://gooddata.slack.com/archives/C0AR3D0J1CY/p1790355247541499');
    expect(card.threadLine).toMatch(/^top-level post, no replies/);
    expect(card.sections.map(s => s.name)).toEqual(['Message', 'Thread context', 'Where it stands']);
    expect(card.messageMd).toMatch(/^> Two product questions/);
    expect(card.threadContextMd).toMatch(/^- Lukas cc'd you on Sep 21\./);
    expect(card.whereItStandsMd).toBe('No replies. Two product-behaviour questions aimed at you and Lukas.');
    expect(card.decision).toEqual({
      save: 'yes',
      type: 'question',
      status: 'unanswered',
      project: 'active-features/object-level-permissions',
    });
    expect(card.comment).toBe('Proposed action: reply. Zdeněk is asking about two migration defaults.');
  });

  test('handles a card with no Thread context and a multi-paragraph comment', () => {
    placeReview();
    const card = readScanReview(tempDir).cards[1];

    expect(card.threadContextMd).toBeNull();
    expect(card.sections.map(s => s.name)).toEqual(['Message', 'Where it stands']);
    expect(card.comment.split('\n\n')).toHaveLength(2);
  });

  test('splits a heading with extra dot-separated parts', () => {
    placeReview();
    // `### 2 · Mirek Koldus · DM · Lukas Ther · Sep 25 13:06` — the channel itself
    // contains a separator, so only the leading number is parsed structurally.
    expect(readScanReview(tempDir).cards[1].title)
      .toBe('Mirek Koldus · DM · Lukas Ther · Sep 25 13:06');
  });

  test('carries the update card shape without special-casing it', () => {
    placeReview();
    const card = readScanReview(tempDir).cards[2];

    expect(card.kind).toBe('update');
    expect(card.type).toBeNull();                       // no meta line on a tracked thread
    expect(card.infoLine).toMatch(/^Tracked since Sep 23/);
    expect(card.sections.map(s => s.name)).toEqual(['New replies', 'Proposed update']);
    expect(card.decision).toEqual({
      apply: 'yes',
      type: 'customer-request',
      status: 'unanswered',
      project: 'active-features/catalog-organization',
    });
  });

  test('flags the cards the overview marked uncertain', () => {
    placeReview();
    expect(readScanReview(tempDir).cards.filter(c => c.uncertain).map(c => c.number)).toEqual([2]);
  });
});

describe('splitCards / rewriteDecisionLine', () => {
  test('finds cards by their marker, not their position', () => {
    placeReview();
    const lines = fs.readFileSync(reviewPath, 'utf8').split('\n');
    const cards = splitCards(lines);

    expect(cards).toHaveLength(3);
    expect(lines[cards[0].endIdx]).toContain(`card-end id=${CARD_1}`);
    expect(lines[cards[0].startIdx]).toMatch(/^### 1 · Zdenek Ornst/);
  });

  test('rewrites only the matching bullet, keeping its spacing', () => {
    expect(rewriteDecisionLine('- Status: answered', 'Status', 'unanswered'))
      .toBe('- Status: unanswered');
    expect(rewriteDecisionLine('  -   Status :  answered', 'Status', 'saved'))
      .toBe('  -   Status :  saved');
    expect(rewriteDecisionLine('- Status: answered', 'Type', 'question')).toBeNull();
    expect(rewriteDecisionLine('> not a bullet', 'Status', 'saved')).toBeNull();
  });
});

// ── lib/scan-review-store, writing ───────────────────────────────────────

describe('setCardDecision', () => {
  test('changes one bullet and leaves every other byte alone', () => {
    placeReview();
    setCardDecision(tempDir, CARD_1, { status: 'answered' });

    const before = original.split('\n');
    const after  = fs.readFileSync(reviewPath, 'utf8').split('\n');
    expect(after).toHaveLength(before.length);

    const changed = after.map((l, i) => (l === before[i] ? null : i)).filter(i => i !== null);
    expect(changed).toHaveLength(1);
    expect(before[changed[0]]).toBe('- Status: unanswered');
    expect(after[changed[0]]).toBe('- Status: answered');
  });

  test('replaces the comment body without disturbing the rest of the card', () => {
    placeReview();
    setCardDecision(tempDir, CARD_1, { comment: 'Rewritten.\n\nSecond paragraph.' });

    const content = fs.readFileSync(reviewPath, 'utf8');
    expect(content).toContain('**Comment**\n\nRewritten.\n\nSecond paragraph.\n\n<!-- card-end');
    // Nothing above the comment moved.
    expect(content).toContain('> Two product questions regarding the Visulization OLP');
    expect(content).toContain('- Project: active-features/object-level-permissions');
    // …and the other two cards are untouched.
    expect(content).toContain('Proposed action: task. File the fix Lukas described.');
    expect(content).toContain('Proposed action: reply + task. Share the shaping doc');
  });

  test('writes Apply on a tracked card', () => {
    placeReview();
    const card = setCardDecision(tempDir, CARD_3, { apply: 'keep' });

    expect(card.decision.apply).toBe('keep');
    expect(fs.readFileSync(reviewPath, 'utf8')).toContain('- Apply: keep');
  });

  test('returns the re-parsed card', () => {
    placeReview();
    const card = setCardDecision(tempDir, CARD_2, { project: 'active-features/parameters' });

    expect(card.id).toBe(CARD_2);
    expect(card.number).toBe(2);
    expect(card.uncertain).toBe(true);
    expect(card.decision.project).toBe('active-features/parameters');
  });

  test('returns null for an unknown card, and when there is no review at all', () => {
    placeReview();
    expect(setCardDecision(tempDir, 'C000:1.2', { status: 'answered' })).toBeNull();

    fs.rmSync(reviewPath);
    expect(setCardDecision(tempDir, CARD_1, { status: 'answered' })).toBeNull();
  });

  test.each([
    ['an unknown status',       CARD_1, { status: 'archived' }],
    ['an unknown type',         CARD_1, { type: 'rumour' }],
    ['a Save value outside the vocabulary', CARD_1, { save: 'maybe' }],
    ['Apply on a new thread',   CARD_1, { apply: 'yes' }],
    ['Save on a tracked thread', CARD_3, { save: 'yes' }],
    ['an empty project',        CARD_1, { project: '   ' }],
    ['a multi-line project',    CARD_1, { project: 'a\nb' }],
  ])('refuses %s and writes nothing', (_label, id, patch) => {
    placeReview();
    expect(() => setCardDecision(tempDir, id, patch)).toThrow();
    expect(fs.readFileSync(reviewPath, 'utf8')).toBe(original);
  });
});

// ── GET /api/scan-review ─────────────────────────────────────────────────

describe('GET /api/scan-review', () => {
  test('reports no pending review', async () => {
    const res = await request(app).get('/api/scan-review').expect(200);
    expect(res.body).toEqual({ exists: false });
  });

  test('returns the cards with their markdown rendered', async () => {
    placeReview();
    const res = await request(app).get('/api/scan-review').expect(200);

    expect(res.body.cards).toHaveLength(3);
    expect(res.body.sections[0].html).toContain('<table>');

    const message = res.body.cards[0].sections.find(s => s.name === 'Message');
    expect(message.html).toContain('<blockquote>');
    expect(message.markdown).toMatch(/^> Two product questions/);
  });

  test('403s when the conversations feature is off', async () => {
    placeReview();
    boot(['projects']);
    await request(app).get('/api/scan-review').expect(403);
  });
});

// ── PUT /api/scan-review/:id ─────────────────────────────────────────────

describe('PUT /api/scan-review/:id', () => {
  test('patches a decision and returns the fresh card', async () => {
    placeReview();
    const res = await request(app)
      .put(`/api/scan-review/${encodeURIComponent(CARD_1)}`)
      .send({ save: 'ignore', status: 'answered' })
      .expect(200);

    expect(res.body.decision).toMatchObject({ save: 'ignore', status: 'answered' });
    const content = fs.readFileSync(reviewPath, 'utf8');
    expect(content).toContain('- Save: ignore');
    expect(content).toContain('- Status: answered');
    // Type and Project were not in the patch, so their lines were not rewritten.
    expect(content).toContain('- Type: question');
    expect(content).toContain('- Project: active-features/object-level-permissions');
  });

  test('patches a comment', async () => {
    placeReview();
    await request(app)
      .put(`/api/scan-review/${encodeURIComponent(CARD_2)}`)
      .send({ comment: 'Ask Lukas to file it himself.' })
      .expect(200);

    expect(fs.readFileSync(reviewPath, 'utf8')).toContain('Ask Lukas to file it himself.');
  });

  test('400s on an empty patch', async () => {
    placeReview();
    await request(app).put(`/api/scan-review/${encodeURIComponent(CARD_1)}`).send({}).expect(400);
  });

  test('400s on a value outside the vocabulary, leaving the file untouched', async () => {
    placeReview();
    const res = await request(app)
      .put(`/api/scan-review/${encodeURIComponent(CARD_1)}`)
      .send({ status: 'archived' })
      .expect(400);

    expect(res.body.error).toMatch(/Invalid Status/);
    expect(fs.readFileSync(reviewPath, 'utf8')).toBe(original);
  });

  test('404s on an unknown card', async () => {
    placeReview();
    await request(app).put('/api/scan-review/C000%3A1.2').send({ status: 'answered' }).expect(404);
  });

  test('403s when the conversations feature is off', async () => {
    placeReview();
    boot(['projects']);
    await request(app)
      .put(`/api/scan-review/${encodeURIComponent(CARD_1)}`)
      .send({ status: 'answered' })
      .expect(403);
  });
});
