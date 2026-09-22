'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Parses `git status --porcelain=v1 -z` output.
 *
 * The -z output is a flat NUL-separated list of *fields*, not records: a rename or copy
 * entry is followed by a second field holding the original path. Note the ordering is the
 * reverse of the human-readable `orig -> new` rendering — in -z mode the record carries the
 * NEW path and the original follows. `??` and `!!` never carry a second field.
 *
 * @param {string} stdout
 * @returns {Array<{code: string, path: string}>}
 */
function parseStatusZ(stdout) {
  const fields = stdout.split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;              // trailing empty field after the last NUL
    const code = f.slice(0, 2);
    out.push({ code, path: f.slice(3) });   // f[2] is the separator space
    if (code[0] === 'R' || code[0] === 'C') i++;   // consume the original-path field
  }
  return out;
}

/**
 * Maps a two-character XY status code to the bucket the UI paints.
 *
 * `MM`/`AM`/`RM` deliberately resolve to 'modified' rather than 'staged': the dot answers
 * "is there work here not yet captured?", and unstaged-on-top-of-staged is the less
 * captured of the two states.
 *
 * @param {string} code
 * @returns {'conflicted'|'untracked'|'modified'|'staged'|null}
 */
function classifyCode(code) {
  const x = code[0], y = code[1];
  if (x === 'U' || y === 'U' || code === 'AA' || code === 'DD') return 'conflicted';
  if (code === '??') return 'untracked';
  if (y !== ' ') return 'modified';
  if (x !== ' ') return 'staged';
  return null;
}

/**
 * Keeps only the paths the worktree tree actually renders, mirroring collectMdFiles in
 * server.js: markdown only, and nothing under a segment starting with `_`.
 *
 * Without this, a folder would show a rollup dot the user can't explain by expanding it,
 * because the dirty file underneath is a .png the tree never lists.
 */
function isRenderedInTree(relPath) {
  const parts = relPath.split('/');
  if (parts.some(p => p.startsWith('_'))) return false;
  return relPath.toLowerCase().endsWith('.md');
}

/**
 * Runs git status over one directory and returns the dirty markdown files beneath it,
 * keyed by path relative to that directory.
 *
 * Never throws and never signals failure as an error: a worktree directory that isn't a
 * git repository is a normal configuration, not a server fault, so callers get
 * { ok: false, reason } and render an undecorated tree.
 *
 * @param {string} targetDir absolute path, already validated by the caller
 * @returns {Promise<{ok: boolean, statuses: Object, reason?: string}>}
 */
async function getGitStatus(targetDir) {
  const opts = { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true };
  try {
    // Doubles as the is-this-a-repo probe, so a non-repo short-circuits before the walk.
    const { stdout: info } = await execFileAsync(
      'git', ['-C', targetDir, 'rev-parse', '--show-toplevel', '--show-prefix'], opts);
    const [, prefixRaw = ''] = info.split('\n');
    const prefix = prefixRaw.trim();

    // --no-optional-locks keeps status from taking index.lock — this fires on every
    // sidebar click, against a worktree the user may be running git in themselves.
    // -z is required, not cosmetic: F1 folder names contain spaces, and without it every
    // path comes back quoted and C-escaped.
    // --untracked-files=all is required too: the default collapses an untracked directory
    // to a single `dir/` entry, which would never match a file row.
    const { stdout } = await execFileAsync('git', [
      '--no-optional-locks', '-C', targetDir, 'status',
      '--porcelain=v1', '-z', '--untracked-files=all', '--', targetDir,
    ], opts);

    const statuses = {};
    for (const { code, path: repoRel } of parseStatusZ(stdout)) {
      // --porcelain paths are repo-root-relative regardless of cwd.
      if (prefix && !repoRel.startsWith(prefix)) continue;
      const rel = prefix ? repoRel.slice(prefix.length) : repoRel;
      if (!isRenderedInTree(rel)) continue;
      const state = classifyCode(code);
      // Staged/unstaged deletes need no handling: the file is gone from disk, so the tree
      // never lists it and this entry simply never matches a row.
      if (state) statuses[rel] = state;
    }
    return { ok: true, statuses };
  } catch (err) {
    let reason = 'error';
    if (err.code === 'ENOENT') reason = 'git-missing';
    else if (err.killed && err.signal === 'SIGTERM') reason = 'timeout';
    else if (/not a git repository/i.test(err.stderr || '')) reason = 'not-a-repo';
    return { ok: false, reason, statuses: {} };
  }
}

module.exports = { parseStatusZ, classifyCode, getGitStatus };
