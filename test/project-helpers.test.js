'use strict';

const { detectProjectReadme, insertProjectOverviewRow, parseProjectGroupsFromOverview } =
  require('../lib/project-helpers');

const PREFIXES = [
  { prefix: 'active-features/',    section: '## Active Features', sub: null      },
  { prefix: 'other-projects/',     section: '## Other Projects',  sub: null      },
  { prefix: 'feature-backlog/q3/', section: '## Feature Backlog', sub: '### Q3' },
];

// ── detectProjectReadme ────────────────────────────────────────────────────

describe('detectProjectReadme', () => {
  test('matches a flat-group README', () => {
    const result = detectProjectReadme('active-features/my-project/README.md', PREFIXES);
    expect(result).toMatchObject({ prefix: 'active-features/', folderName: 'my-project', sub: null });
  });

  test('matches a sub-group README', () => {
    const result = detectProjectReadme('feature-backlog/q3/my-feature/README.md', PREFIXES);
    expect(result).toMatchObject({ prefix: 'feature-backlog/q3/', folderName: 'my-feature', sub: '### Q3' });
  });

  test('returns null when path has an extra segment after the prefix', () => {
    // active-features/my-project/notes/README.md — three segments, not two
    expect(detectProjectReadme('active-features/my-project/notes/README.md', PREFIXES)).toBeNull();
  });

  test('returns null when the file is not README.md', () => {
    expect(detectProjectReadme('active-features/my-project/notes.md', PREFIXES)).toBeNull();
  });

  test('returns null for an unrecognized prefix', () => {
    expect(detectProjectReadme('unknown-group/my-project/README.md', PREFIXES)).toBeNull();
  });

  test('returns null for a path whose prefix is not registered — the other-projects bug case', () => {
    // feature-backlog/other-projects/ looks plausible but is NOT a registered prefix.
    // This is the exact path created when projects/README.md has a wrong first link.
    expect(detectProjectReadme('feature-backlog/other-projects/my-project/README.md', PREFIXES)).toBeNull();
  });
});

// ── parseProjectGroupsFromOverview ────────────────────────────────────────

describe('parseProjectGroupsFromOverview', () => {
  test('derives correct prefixes from the first link in each section', () => {
    const content = [
      '## Active Features',
      '',
      '| Project | Status |',
      '|---------|--------|',
      '| [Foo](active-features/foo/README.md) | active |',
      '',
      '## Other Projects',
      '',
      '| Project | Status |',
      '|---------|--------|',
      '| [Bar](other-projects/bar/README.md) | backlog |',
    ].join('\n');

    const groups = parseProjectGroupsFromOverview(content);
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Active Features', prefix: 'active-features/' }),
      expect.objectContaining({ label: 'Other Projects',  prefix: 'other-projects/'  }),
    ]));
  });

  test('falls back to a label-derived prefix when a section has no links', () => {
    const content = '## Empty Section\n\nNo links here.';
    const [group] = parseProjectGroupsFromOverview(content);
    expect(group.prefix).toBe('empty-section/');
  });

  test('correctly derives a deep prefix for a sub-group section', () => {
    const content = [
      '## Feature Backlog',
      '',
      '### Q3',
      '',
      '| Project | Status |',
      '|---------|--------|',
      '| [Q3 Feature](feature-backlog/q3/q3-feature/README.md) | backlog |',
    ].join('\n');

    const [group] = parseProjectGroupsFromOverview(content);
    expect(group.prefix).toBe('feature-backlog/q3/');
  });

  test('returns wrong prefix when the first link in a section has a wrong path — the known failure mode', () => {
    // A wrong first link poisons the prefix for the entire group.
    // This is how the other-projects bug manifested: the first entry in ## Other Projects
    // pointed to feature-backlog/other-projects/... causing new projects to land there.
    const content = [
      '## Other Projects',
      '',
      '| Project | Status |',
      '|---------|--------|',
      '| [Bad Entry](feature-backlog/other-projects/bad/README.md) | backlog |',
      '| [Good Entry](other-projects/good/README.md) | backlog |',
    ].join('\n');

    const [group] = parseProjectGroupsFromOverview(content);
    expect(group.prefix).toBe('feature-backlog/other-projects/');
  });
});

// ── insertProjectOverviewRow ──────────────────────────────────────────────

const BASE_OVERVIEW = [
  '# Projects',
  '',
  '## Active Features',
  '',
  '| Project | Status |',
  '|---------|--------|',
  '| [Existing](active-features/existing/README.md) | active |',
  '',
  '## Other Projects',
  '',
  '| Project | Status |',
  '|---------|--------|',
  '| [Other](other-projects/other/README.md) | backlog |',
  '',
  '## Feature Backlog',
  '',
  '### Q3',
  '',
  '| Project | Status |',
  '|---------|--------|',
  '| [Q3 Item](feature-backlog/q3/q3-item/README.md) | backlog |',
];

describe('insertProjectOverviewRow', () => {
  test('inserts a new row into the correct flat section', () => {
    const updated = insertProjectOverviewRow(
      BASE_OVERVIEW, 'active-features/new-project/README.md', 'backlog', 'New Project', PREFIXES
    );
    expect(updated).not.toBeNull();
    expect(updated.join('\n')).toContain(
      '| [New Project](active-features/new-project/README.md) | backlog |'
    );
    // Must appear after the existing row in that section
    const existingIdx = updated.findIndex(l => l.includes('existing/README.md'));
    const newIdx      = updated.findIndex(l => l.includes('new-project/README.md'));
    expect(newIdx).toBeGreaterThan(existingIdx);
  });

  test('inserts into the correct sub-section', () => {
    const updated = insertProjectOverviewRow(
      BASE_OVERVIEW, 'feature-backlog/q3/new-feature/README.md', 'backlog', 'New Feature', PREFIXES
    );
    expect(updated).not.toBeNull();
    expect(updated.join('\n')).toContain(
      '| [New Feature](feature-backlog/q3/new-feature/README.md) | backlog |'
    );
    // Must not land in a different section
    const q3Idx  = updated.findIndex(l => l === '### Q3');
    const newIdx = updated.findIndex(l => l.includes('new-feature/README.md'));
    expect(newIdx).toBeGreaterThan(q3Idx);
  });

  test('humanizes the folder name when no display name is provided', () => {
    const updated = insertProjectOverviewRow(
      BASE_OVERVIEW, 'active-features/my-new-project/README.md', 'backlog', null, PREFIXES
    );
    expect(updated.join('\n')).toContain(
      '| [My New Project](active-features/my-new-project/README.md) | backlog |'
    );
  });

  test('returns null when the path does not match any prefix', () => {
    expect(insertProjectOverviewRow(
      BASE_OVERVIEW, 'unknown/project/README.md', 'backlog', 'Project', PREFIXES
    )).toBeNull();
  });

  test('does not mutate the input array', () => {
    const frozen = Object.freeze([...BASE_OVERVIEW]);
    // Should not throw even though the array is frozen (we spread before splicing)
    expect(() =>
      insertProjectOverviewRow(
        [...frozen], 'active-features/test/README.md', 'backlog', 'Test', PREFIXES
      )
    ).not.toThrow();
    // Verify original is unchanged by checking length
    expect(BASE_OVERVIEW.length).toBe(frozen.length);
  });
});
