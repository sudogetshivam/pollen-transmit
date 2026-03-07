'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { POLLEN_DIR } = require('../identity/index');

const KEYS_DIR = path.join(POLLEN_DIR, 'keys');
const PUBLIC_KEY_FILE = path.join(KEYS_DIR, 'public.pem');
const PRIVATE_KEY_FILE = path.join(KEYS_DIR, 'private.pem');

/**
 * Generate a 2048-bit RSA keypair using Node's built-in crypto.
 * Returns { publicKey, privateKey } as PEM strings.
 */
function generateKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
}

/**
 * Load existing keypair from disk, or generate and save a new one.
 * Returns { publicKey, privateKey } as PEM strings.
 */
function loadOrCreateKeypair() {
    if (!fs.existsSync(KEYS_DIR)) {
        fs.mkdirSync(KEYS_DIR, { recursive: true });
    }

    if (fs.existsSync(PUBLIC_KEY_FILE) && fs.existsSync(PRIVATE_KEY_FILE)) {
        const publicKey = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
        const privateKey = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
        return { publicKey, privateKey };
    }

    // First time — generate and persist
    const { publicKey, privateKey } = generateKeypair();
    fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, 'utf8');
    // Private key: restrict permissions on unix-like systems
    fs.writeFileSync(PRIVATE_KEY_FILE, privateKey, { encoding: 'utf8', mode: 0o600 });

    console.log('🔑 RSA keypair generated and stored in ~/.pollen/keys/');
    return { publicKey, privateKey };
}

/**
 * Load public key PEM for the local user.
 * Throws if not found (daemon should call loadOrCreateKeypair first).
 */
function loadPublicKey() {
    if (!fs.existsSync(PUBLIC_KEY_FILE)) {
        throw new Error('No public key found. Run: pollen start');
    }
    return fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
}

/**
 * Load private key PEM for the local user.
 */
function loadPrivateKey() {
    if (!fs.existsSync(PRIVATE_KEY_FILE)) {
        throw new Error('No private key found. Run: pollen start');
    }
    return fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
}

module.exports = {
    loadOrCreateKeypair,
    loadPublicKey,
    loadPrivateKey,
    PUBLIC_KEY_FILE,
    PRIVATE_KEY_FILE,
};
