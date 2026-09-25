'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Reads REPO_ROOT/conversations.json. Returns [] if the file doesn't exist yet —
 * a workspace that has never run the Slack skills simply has no conversations.
 *
 * @param {string} repoRoot
 * @returns {Array}
 */
function readConversations(repoRoot) {
  const p = path.join(repoRoot, 'conversations.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Writes the full conversations array back to REPO_ROOT/conversations.json.
 * 2-space indented to match what the /slack-scan and /slack-inbox skills write.
 *
 * @param {string} repoRoot
 * @param {Array} conversations
 */
function writeConversations(repoRoot, conversations) {
  const p = path.join(repoRoot, 'conversations.json');
  fs.writeFileSync(p, JSON.stringify(conversations, null, 2), 'utf8');
}

module.exports = { readConversations, writeConversations };
