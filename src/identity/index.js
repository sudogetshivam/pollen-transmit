'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

const POLLEN_DIR = path.join(os.homedir(), '.pollen');
const IDENTITY_FILE = path.join(POLLEN_DIR, 'identity.json');

/**
 * Generate a 4-character alphanumeric shortID using crypto.randomBytes
 * to ensure true randomness — no Math.random()
 */
function generateShortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  // Generate extra bytes to account for rejection sampling (uniform distribution)
  const bytes = crypto.randomBytes(16);
  let byteIndex = 0;
  while (id.length < 4) {
    const byte = bytes[byteIndex++];
    // Only accept bytes that fall within a clean multiple of chars.length
    // to avoid modulo bias
    if (byte < 256 - (256 % chars.length)) {
      id += chars[byte % chars.length];
    }
  }
  return id;
}

/**
 * Prompt the user for their username via readline.
 * Resolves with the trimmed username string.
 */
function promptUsername() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('\n🌿 Welcome to Pollen!\nEnter your username (e.g. shivam): ', (answer) => {
      rl.close();
      const name = answer.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name) {
        console.error('Username cannot be empty. Using "user" as default.');
        resolve('user');
      } else {
        resolve(name);
      }
    });
  });
}

/**
 * Load existing identity from disk, or create a new one interactively.
 * Returns: { username, shortId, identity }
 *   where identity = "username@shortId"
 */
async function loadOrCreate() {
  // Ensure ~/.pollen directory exists
  if (!fs.existsSync(POLLEN_DIR)) {
    fs.mkdirSync(POLLEN_DIR, { recursive: true });
  }

  if (fs.existsSync(IDENTITY_FILE)) {
    const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data;
  }

  // First time — prompt and create
  const username = await promptUsername();
  const shortId = generateShortId();
  const identity = `${username}@${shortId}`;

  const data = { username, shortId, identity };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(data, null, 2), 'utf8');

  console.log(`\n✅ Identity created: ${identity}`);
  console.log(`   Your Pollen ID is: ${identity}`);
  console.log(`   Share this with contacts so they can message you.\n`);

  return data;
}

/**
 * Load identity without prompting — throws if not found.
 * Used by the daemon (which should never prompt).
 */
function loadIdentity() {
  if (!fs.existsSync(IDENTITY_FILE)) {
    throw new Error('No identity found. Run: pollen start');
  }
  const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
  return JSON.parse(raw);
}

module.exports = { loadOrCreate, loadIdentity, POLLEN_DIR };
