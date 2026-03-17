'use strict';

const crypto = require('crypto');
const { runCommand, sendCommand } = require('../ipc');
const { encrypt } = require('../../crypto/encrypt');
const { loadIdentity } = require('../../identity/index');
const { loadOrCreateKeypair } = require('../../crypto/keys');

/**
 * pollen send <destination> "<message>"
 *
 *  1. Validate identity format
 *  2. Ask daemon for recipient's public key via get-peer-key IPC
 *  3a. Key found → encrypt with hybrid AES+RSA, send pre-encrypted payload
 *  3b. Key not found → store as pending (daemon will encrypt when peer discovered)
 *  4. Daemon stores first, then attempts live TCP delivery immediately
 */
async function sendCommand_(destination, messageText) {
    if (!destination || !messageText) {
        console.error('Usage: pollen send <identity> "<message>"');
        console.error('Example: pollen send raj@a3f2 "bhai notes bhej"');
        process.exit(1);
    }

    // Validate identity format: username@xxxx (4 alphanumeric chars)
    if (!/^[a-z0-9_-]+@[a-z0-9]{4}$/.test(destination)) {
        console.error(`❌ Invalid identity format: "${destination}"`);
        console.error('   Expected: username@xxxx  (e.g. raj@a3f2)');
        process.exit(1);
    }

    // Load sender identity
    let senderIdentity;
    try {
        senderIdentity = loadIdentity().identity;
    } catch {
        console.error('❌ Not initialised. Run: pollen start');
        process.exit(1);
    }

    // ── 1. Try to get recipient public key from daemon's peer table ──────────
    let encryptedPayload;
    let recipientPublicKey = null;

    // Sending to ourselves? Use our own public key.
    if (destination === senderIdentity) {
        const { publicKey } = loadOrCreateKeypair();
        recipientPublicKey = publicKey;
    } else {
        // Ask the daemon (it has the peer table from UDP discovery)
        try {
            const res = await sendCommand({ type: 'get-peer-key', identity: destination });
            if (res.ok && res.publicKey) {
                recipientPublicKey = res.publicKey;
            }
        } catch {
            // Daemon may be unreachable — handled below
            console.error('❌ Daemon is not running. Start it with: pollen start');
            process.exit(1);
        }
    }

    // ── 2. Encrypt the message ───────────────────────────────────────────────
    if (recipientPublicKey) {
        try {
            const blob = encrypt(messageText, recipientPublicKey);
            encryptedPayload = JSON.stringify(blob);
            console.log(`🔐 Message encrypted for ${destination}`);
        } catch (err) {
            console.error('❌ Encryption failed:', err.message);
            process.exit(1);
        }
    } else {
        // Peer's public key not yet known — store with pending flag
        // Daemon will encrypt + re-deliver once it discovers the peer via UDP
        console.log(`⚠️  ${destination} not yet on network — storing for epidemic delivery.`);
        encryptedPayload = JSON.stringify({
            __pending_encryption: true,
            __phase1_plaintext: messageText,
        });
    }

    // ── 3. Send to daemon (store-first, then live delivery attempt) ──────────
    const messageId = crypto.randomUUID();
    const ttl = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

    await runCommand(
        {
            type: 'send',
            id: messageId,
            from_identity: senderIdentity,
            destination,
            payload: encryptedPayload,
            ttl,
        },
        (res) => {
            if (!res.ok) {
                console.error('❌ Failed to queue message:', res.error);
                return;
            }

            const isDelivered = res.status === 'delivered';
            console.log(`\n📤 Message ${isDelivered ? 'delivered!' : 'queued!'}`);
            console.log(`   To:        ${destination}`);
            console.log(`   Message:   "${messageText}"`);
            console.log(`   ID:        ${messageId}`);
            console.log(`   Status:    ${isDelivered ? '✅ Delivered' : '⏳ Undelivered (will deliver when peer connects)'}`);
            console.log(`\n   Track it:  pollen status ${messageId}\n`);
        }
    );
}

module.exports = { sendCommand: sendCommand_ };
