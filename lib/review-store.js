'use strict';

const fs = require('fs');
const path = require('path');

// The Slack skills don't write conversations.json directly. Each writes a temp approval
// file at the workspace root and waits — /slack-scan writes .slack-scan-review.md,
// /slack-inbox writes .slack-inbox-review.md. Both use the same card format:
//
//   ### 1 · Zdenek Ornst · #proj-object-level-permissions · Sep 25 18:54
//
//   question · unanswered · object-level-permissions · proposed: **reply**
//   Thread: top-level post, no replies · [Open in Slack](https://…)
//
//   **Message** … **Thread context** … **Where it stands** …
//
//   **Your decision**
//
//   - Save: yes
//   - Type: question
//   - Status: unanswered
//   - Project: active-features/object-level-permissions
//
//   **Comment**
//
//   Proposed action: reply. …
//
//   <!-- card-end id=C0AR3D0J1CY:1790355247.541499 kind=new last=1790355247.541499 -->
//
// The user edits the decision block and the comment; those edits *are* the approval.
// When they tell Claude "done", the skill validates every card, writes conversations.json,
// advances the watermark and deletes this file.
//
// This module exists so the dashboard can be a nicer way to make those same edits. It is
// deliberately NOT a markdown parser: it finds the handful of lines it owns and rewrites
// only those, leaving every other byte — headings, quoted messages, thread context, the
// overview tables, the card-end markers — exactly as the skill wrote them. A review the
// dashboard has touched must still be processable by the skill, and still hand-editable
// in an editor.

// Which review file is which. A fixed allowlist, so a `which` from the URL can never name
// any other path. The routines run both skills side by side, hence two files, not one.
const REVIEW_FILES = {
  scan:  { file: '.slack-scan-review.md',  title: 'Slack scan review' },
  inbox: { file: '.slack-inbox-review.md', title: 'Slack inbox review' },
};

// Shared with /slack-scan, /slack-inbox and the conversations UI.
const TYPES = ['question', 'customer-request', 'reference', 'idea'];
const STATUSES = ['unanswered', 'answered', 'saved', 'open'];
// `Save` is asked of a new thread, `Apply` of one that is already tracked.
const SAVE_VALUES = ['yes', 'ignore'];
const APPLY_VALUES = ['yes', 'keep'];

// The `## ` sections that hold cards rather than prose. /slack-inbox uses the first two.
const CARD_SECTIONS = ['New threads', 'Updates to tracked threads', 'Suggested to close'];

const HEADING_RE = /^###\s+(\d+)\s*(?:·\s*)?(.*)$/;
const CARD_END_RE = /^<!--\s*card-end\s+(.+?)\s*-->\s*$/;
const SECTION_RE = /^\*\*([^*]+)\*\*/;
const BULLET_RE = /^(\s*-\s*)([A-Za-z]+)(\s*:\s*)(.*)$/;
const META_RE = /^([^·]+)·([^·]+)·([^·]+)·\s*proposed:\s*\*\*(.+?)\*\*\s*$/;

/** The review's allowlist entry, or throws on anything not in REVIEW_FILES. */
function reviewKind(which) {
  if (!Object.prototype.hasOwnProperty.call(REVIEW_FILES, which)) {
    throw new Error(`Unknown review: ${which}`);
  }
  return REVIEW_FILES[which];
}

function reviewPath(repoRoot, which) {
  return path.join(repoRoot, reviewKind(which).file);
}

/** `id=… kind=… last=…` from a card-end marker, as a plain object. */
function parseMarkerAttrs(attrs) {
  const out = {};
  for (const pair of attrs.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Locates every card in the file by its heading and its card-end marker, without
 * interpreting the contents. Returns line ranges — the marker, not the position in the
 * array, is what identifies a card, so a file edited elsewhere in the meantime can still
 * be written to safely.
 *
 * @param {string[]} lines
 * @returns {Array<{ id, kind, last, section, startIdx, endIdx }>}  endIdx is the marker line
 */
function splitCards(lines) {
  const cards = [];
  let section = null;
  let startIdx = -1;

  lines.forEach((line, i) => {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) section = h2[1];

    if (startIdx < 0 && HEADING_RE.test(line)) { startIdx = i; return; }

    const end = line.match(CARD_END_RE);
    if (end && startIdx >= 0) {
      const attrs = parseMarkerAttrs(end[1]);
      cards.push({
        id: attrs.id || null,
        kind: attrs.kind || null,
        last: attrs.last || null,
        section,
        startIdx,
        endIdx: i,
      });
      startIdx = -1;
    }
  });

  return cards;
}

/** Trims leading and trailing blank lines, keeping the ones in between. */
function trimBlanks(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
}

/**
 * Reads one card's line range into structured fields. `sections` keeps every `**Name**`
 * block in file order, so the update and close card shapes (`New replies`,
 * `Proposed update`, `Why close`) render without being special-cased here.
 *
 * @param {string[]} lines  the whole file
 * @param {object} range    one entry from splitCards()
 */
function parseCard(lines, range) {
  const { startIdx, endIdx } = range;
  const heading = lines[startIdx];
  const hm = heading.match(HEADING_RE);
  const number = hm ? Number(hm[1]) : null;
  const title = hm ? hm[2].trim() : heading.replace(/^###\s*/, '');

  // Head = everything between the heading and the first `**Section**` marker: the meta
  // line on a new card, the "Tracked since …" line on a tracked one, then the Thread line.
  let firstSection = endIdx;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (SECTION_RE.test(lines[i])) { firstSection = i; break; }
  }
  const head = trimBlanks(lines.slice(startIdx + 1, firstSection));

  let type = null;
  let status = null;
  let project = null;
  let proposed = null;
  const mm = head.length ? head[0].match(META_RE) : null;
  if (mm) {
    type = mm[1].trim();
    status = mm[2].trim();
    project = mm[3].trim();
    proposed = mm[4].trim();
  }
  const infoLine = head.length && !mm ? head[0].trim() : null;
  const threadLine = (head.find(l => /^Thread:/.test(l)) || '').replace(/^Thread:\s*/, '').trim() || null;

  const permalinkMatch = lines.slice(startIdx, endIdx).join('\n').match(/\[Open in Slack\]\(([^)]+)\)/);

  // Split the body into `**Name**` sections.
  const marks = [];
  for (let i = firstSection; i < endIdx; i++) {
    const m = lines[i].match(SECTION_RE);
    if (m) marks.push({ name: m[1].trim(), idx: i });
  }

  const sections = [];
  let decision = {};
  let comment = '';
  let commentIdx = -1;
  let decisionRange = null;

  marks.forEach((mark, n) => {
    const bodyStart = mark.idx + 1;
    const bodyEnd = n + 1 < marks.length ? marks[n + 1].idx : endIdx;
    const body = trimBlanks(lines.slice(bodyStart, bodyEnd));

    if (mark.name === 'Your decision') {
      decisionRange = { start: bodyStart, end: bodyEnd };
      for (const line of body) {
        const b = line.match(BULLET_RE);
        if (b) decision[b[2].toLowerCase()] = b[4].trim();
      }
    } else if (mark.name === 'Comment') {
      commentIdx = mark.idx;
      comment = body.join('\n');
    } else {
      sections.push({ name: mark.name, markdown: body.join('\n') });
    }
  });

  const sectionByName = name => (sections.find(s => s.name === name) || {}).markdown || null;

  return {
    id: range.id,
    kind: range.kind,
    last: range.last,
    section: range.section,
    number,
    title,
    type,
    status,
    project,
    proposed,
    infoLine,
    threadLine,
    permalink: permalinkMatch ? permalinkMatch[1] : null,
    sections,
    messageMd: sectionByName('Message'),
    threadContextMd: sectionByName('Thread context'),
    whereItStandsMd: sectionByName('Where it stands'),
    decision,
    comment,
    // Line bookkeeping the writer needs; harmless to send to the client.
    startIdx,
    endIdx,
    commentIdx,
    decisionRange,
  };
}

/** Card numbers flagged `⚠` in the overview tables, e.g. `| 8 ⚠ | Sep 24 15:38 | …`. */
function uncertainNumbers(lines) {
  const out = new Set();
  for (const line of lines) {
    const m = line.match(/^\|\s*(\d+)\s*⚠/);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/**
 * Reads a pending review file. Returns `{ exists: false }` when there is none — between
 * a processed "done" and the next run there is no review, and that is the normal state,
 * not an error.
 *
 * @param {string} repoRoot
 * @param {'scan'|'inbox'} which
 */
function readReview(repoRoot, which) {
  const p = reviewPath(repoRoot, which);
  if (!fs.existsSync(p)) return { exists: false };

  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const ranges = splitCards(lines);
  const flagged = uncertainNumbers(lines);
  const cards = ranges.map(r => {
    const card = parseCard(lines, r);
    card.uncertain = flagged.has(card.number);
    return card;
  });

  // Everything above the first card is prose the dashboard shows read-only: the overview
  // tables, the uncertain calls and what the scan left out.
  const headEnd = ranges.length ? ranges[0].startIdx : lines.length;
  const head = lines.slice(0, headEnd);
  const prose = [];
  let current = null;
  for (const line of head) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = { name: h2[1], lines: [] };
      if (!CARD_SECTIONS.includes(current.name)) prose.push(current);
      continue;
    }
    if (current && !CARD_SECTIONS.includes(current.name)) current.lines.push(line);
  }

  const firstLine = name => (head.find(l => l.startsWith(name)) || '').trim() || null;

  return {
    exists: true,
    which,
    title: (head.find(l => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim() || reviewKind(which).title,
    window: firstLine('Window:'),
    summary: firstLine('Found '),
    sections: prose.map(s => ({ name: s.name, markdown: trimBlanks(s.lines).join('\n') })),
    cards,
  };
}

/**
 * Checks a patch against the vocabulary before anything is written. Deliberately stricter
 * than PUT /api/conversations/:id: a value outside these sets makes the skill refuse the
 * whole review at "done", so it must not be possible to save one from the UI.
 */
function validatePatch(patch, kind) {
  if (patch.save !== undefined) {
    if (kind !== 'new') throw new Error(`Save applies to new threads, not kind=${kind}`);
    if (!SAVE_VALUES.includes(patch.save)) throw new Error(`Invalid Save: ${patch.save}`);
  }
  if (patch.apply !== undefined) {
    if (kind === 'new') throw new Error('Apply applies to tracked threads, not kind=new');
    if (!APPLY_VALUES.includes(patch.apply)) throw new Error(`Invalid Apply: ${patch.apply}`);
  }
  if (patch.type !== undefined && !TYPES.includes(patch.type)) {
    throw new Error(`Invalid Type: ${patch.type}`);
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
    throw new Error(`Invalid Status: ${patch.status}`);
  }
  if (patch.project !== undefined) {
    // A project folder path, or `none`. The set of valid paths lives in projects/README.md,
    // which this module has no business reading — the UI offers only real ones, and the
    // skill checks them again at "done". Here we only keep the line well-formed.
    if (typeof patch.project !== 'string' || !patch.project.trim() || /[\r\n]/.test(patch.project)) {
      throw new Error(`Invalid Project: ${patch.project}`);
    }
  }
  if (patch.comment !== undefined && typeof patch.comment !== 'string') {
    throw new Error('Comment must be a string');
  }
}

/**
 * Rewrites one `- Key: value` bullet in place, keeping the bullet's own indentation,
 * spelling and spacing. Returns the new line, or null if this line isn't that key.
 */
function rewriteDecisionLine(line, key, value) {
  const m = line.match(BULLET_RE);
  if (!m || m[2].toLowerCase() !== key.toLowerCase()) return null;
  return `${m[1]}${m[2]}${m[3]}${value}`;
}

/**
 * Applies a decision patch to one card, identified by its card-end `id`. Only the bullets
 * named in the patch and — when `comment` is given — the comment body are touched; every
 * other line of the file is written back byte for byte.
 *
 * @param {string} repoRoot
 * @param {'scan'|'inbox'} which
 * @param {string} id     the card-end id, e.g. C0AR3D0J1CY:1790355247.541499
 * @param {{save?, apply?, type?, status?, project?, comment?}} patch
 * @returns {object|null} the re-parsed card, or null when there is no such review or card
 */
function setCardDecision(repoRoot, which, id, patch) {
  const p = reviewPath(repoRoot, which);
  if (!fs.existsSync(p)) return null;

  const original = fs.readFileSync(p, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);

  const range = splitCards(lines).find(c => c.id === id);
  if (!range) return null;

  const card = parseCard(lines, range);
  validatePatch(patch, card.kind);

  const bullets = { save: 'Save', apply: 'Apply', type: 'Type', status: 'Status', project: 'Project' };
  for (const [key, label] of Object.entries(bullets)) {
    if (patch[key] === undefined) continue;
    if (!card.decisionRange) throw new Error(`Card ${id} has no decision block`);

    let written = false;
    for (let i = card.decisionRange.start; i < card.decisionRange.end; i++) {
      const next = rewriteDecisionLine(lines[i], label, patch[key]);
      if (next !== null) { lines[i] = next; written = true; break; }
    }
    // A missing bullet means the card is malformed. Appending one would quietly change the
    // shape the skill parses, so refuse instead.
    if (!written) throw new Error(`Card ${id} has no "${label}:" line`);
  }

  if (patch.comment !== undefined) {
    if (card.commentIdx < 0) throw new Error(`Card ${id} has no comment block`);
    const body = patch.comment.replace(/\s+$/, '').split('\n');
    const replacement = patch.comment.trim() ? ['', ...body, ''] : [''];
    // From the line after `**Comment**` up to the line before the card-end marker: the
    // region the comment owns outright.
    lines.splice(card.commentIdx + 1, card.endIdx - card.commentIdx - 1, ...replacement);
  }

  fs.writeFileSync(p, lines.join(eol), 'utf8');

  const fresh = splitCards(lines).find(c => c.id === id);
  const updated = parseCard(lines, fresh);
  updated.uncertain = uncertainNumbers(lines).has(updated.number);
  return updated;
}

module.exports = {
  REVIEW_FILES,
  TYPES,
  STATUSES,
  SAVE_VALUES,
  APPLY_VALUES,
  readReview,
  setCardDecision,
  // exported for tests
  splitCards,
  parseCard,
  rewriteDecisionLine,
  validatePatch,
};
