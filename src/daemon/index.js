'use strict';

/**
 * Pollen Daemon — background process entry point.
 *
 * Spawned by `pollen start` with:
 *   child_process.spawn('node', [__filename], { detached: true, stdio: 'ignore', windowsHide: true })
 *
 * All logging goes to ~/.pollen/daemon.log.
 * Never reads from stdin.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

//  Redirect console to log file
const POLLEN_DIR = path.join(os.homedir(), '.pollen');
if (!fs.existsSync(POLLEN_DIR)) fs.mkdirSync(POLLEN_DIR, { recursive: true });

const LOG_FILE = path.join(POLLEN_DIR, 'daemon.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(...args) {
    const ts = new Date().toISOString();
    const msg = `[${ts}] ${args.join(' ')}\n`;
    logStream.write(msg);
}

console.log = log;
console.error = log;
console.warn = log;

//  Imports 
const { loadIdentity } = require('../identity/index');
const { loadOrCreateKeypair } = require('../crypto/keys');
const { encrypt, decrypt } = require('../crypto/encrypt');
const { openDb } = require('../db/index');
const { cleanExpired } = require('../db/cleanup');
const {
    insertMessage,
    getMessageById,
    getAllPending,
    markDelivered,
    markInTransit,
    updateMessagePayload,
    getMessagesForDestination,
    upsertMessage,
    upsertPeer,
    getPeerByIdentity,
    getAllPeers,
    getActivePeers,
    markPeerOffline,
    clearAllPeerIPs,
    removeInactivePeers,
} = require('../db/messages');
const { startNetworkWatcher } = require('./network');
const { startUDP, broadcastNow, broadcastGoodbye, sendDirectMessage } = require('./udp');
const { startTCP, sendMessage } = require('./tcp');
const { forwardMessages, sendAck } = require('./epidemic');

// ── Constants ──────────────────────────────────────────────────────────────────
const PID_FILE = path.join(POLLEN_DIR, 'daemon.pid');
const IPC_SOCKET = getIPCPath();

function getIPCPath() {
    if (process.platform === 'win32') return '\\\\.\\pipe\\pollen-ipc';
    return path.join(POLLEN_DIR, 'daemon.sock');
}

// ── Write PID ─────────────────────────────────────────────────────────────────
fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
log(`Daemon started. PID=${process.pid}`);

// ── Load identity & keys ──────────────────────────────────────────────────────
let identity, publicKey, privateKey;
try {
    ({ identity } = loadIdentity());
    ({ publicKey, privateKey } = loadOrCreateKeypair());
    log(`Identity: ${identity}`);
} catch (err) {
    log('FATAL: Cannot load identity/keys:', err.message);
    process.exit(1);
}

// ── Open database & run initial cleanup ───────────────────────────────────────
openDb();
cleanExpired();
log('Initial cleanup done.');
setInterval(cleanExpired, 60 * 60 * 1000).unref();

// ── Clear stale peer IPs from previous session ───────────────────────────────
// Peers will re-announce via UDP within seconds if they are online
clearAllPeerIPs();
log('Cleared stale peer IPs — waiting for fresh UDP announcements.');

// ── Message delivery handler ──────────────────────────────────────────────────
/**
 * Called by TCP server when a message frame arrives.
 *
 * @param {object}  message   - The raw message object from the peer
 * @param {string}  remoteIP  - IP address of the sender
 * @param {boolean} isRelay   - true if message is for someone else (store for Phase 4)
 */
function handleIncomingMessage(message, remoteIP, isRelay = false) {
    if (!message || !message.id || !message.destination || !message.payload) {
        log(`[deliver] Malformed message from ${remoteIP} — missing fields`);
        return;
    }

    if (isRelay) {
        if (message.destination === identity) {
            log(`[epidemic] Received relayed message destined for us! (id=${message.id})`);
            // It's for us! Don't just store it as a relay, process it for delivery.
            isRelay = false;
        } else {
            // It's for someone else — store for epidemic forwarding
            // Store as 'undelivered' so it participates in retry sweeps and epidemic forwarding
            const result = upsertMessage({
                id: message.id,
                from_identity: message.from_identity || 'unknown',
                destination: message.destination,
                payload: message.payload,
                status: 'undelivered',
                hop_count: (message.hop_count || 0) + 1,
                ttl: message.ttl,
                created_at: message.created_at || Date.now(),
            });
            log(`[relay] Stored relay msg id=${message.id} → ${message.destination} (${result})`);

            // Continue the epidemic: immediately forward this new message to all OTHER known peers
            // This ensures the virus keeps spreading as soon as we receive it
            if (result === 'inserted') {
                const peerIPs = getActivePeers()
                    .map(p => p.ip)
                    .filter(ip => ip && ip !== remoteIP); // Don't send back to source
                if (peerIPs.length > 0) {
                    log(`[epidemic] Spreading relay msg ${message.id} to ${peerIPs.length} other peer(s)`);
                    forwardMessages(peerIPs).catch(err => {
                        log(`[epidemic] Relay spread failed: ${err.message}`);
                    });
                }
            }
            return;
        }
    }

    // Message is for us — decrypt and deliver
    if (message.destination !== identity) {
        log(`[deliver] Ignoring message for ${message.destination} (we are ${identity})`);
        return;
    }

    // Upsert message as delivered (idempotent if already received)
    const existing = getMessageById(message.id);
    if (existing && existing.status === 'delivered') {
        log(`[deliver] Duplicate message id=${message.id} — already delivered`);
        return;
    }

    try {
        const payloadObj = JSON.parse(message.payload);

        // Try to decrypt
        let plaintext;
        if (payloadObj.__pending_encryption) {
            plaintext = payloadObj.__phase1_plaintext || '[encrypted — key exchange pending]';
        } else {
            plaintext = decrypt(payloadObj, privateKey);
        }

        // Check if the decrypted payload is an ACK (Phase 4)
        let isAck = false;
        try {
            const parsedPlaintext = JSON.parse(plaintext);
            if (parsedPlaintext.__type === 'ack' && parsedPlaintext.ackMessageId) {
                isAck = true;
                const ackedId = parsedPlaintext.ackMessageId;
                const origMsg = getMessageById(ackedId);
                if (origMsg && origMsg.status !== 'delivered') {
                    markDelivered(ackedId);
                    log(`[epidemic] ✅ Delivery confirmed for message ${ackedId}`);
                }
            }
        } catch (e) {
            // Not JSON, so it's a normal message
        }

        if (!isAck) {
            // Store as delivered
            upsertMessage({
                id: message.id,
                from_identity: message.from_identity || 'unknown',
                destination: message.destination,
                payload: message.payload,
                status: 'delivered',
                hop_count: message.hop_count || 0,
                ttl: message.ttl || Date.now() + 7 * 24 * 60 * 60 * 1000,
                created_at: message.created_at || Date.now(),
            });
            markDelivered(message.id);

            log(`[deliver] ✅ Message delivered! From: ${message.from_identity} | Content: "${plaintext}"`);

            // Append to inbox file for easy reading
            const inboxFile = path.join(POLLEN_DIR, 'inbox.log');
            const entry = `[${new Date().toISOString()}] From: ${message.from_identity}\n${plaintext}\n---\n`;
            fs.appendFileSync(inboxFile, entry, 'utf8');

            // Send ACK back through epidemic network (Phase 4)
            if (message.from_identity && message.from_identity !== 'unknown') {
                sendAck(message.id, message.from_identity, identity);
            }
        }

    } catch (err) {
        log(`[deliver] Decryption failed for id=${message.id}: ${err.message}`);
    }
}

// ── Attempt live delivery to a peer ──────────────────────────────────────────
/**
 * Try to deliver a stored message directly to its destination peer via TCP.
 *
 * PHASE 3 KEY LOGIC:
 * If the stored payload has __pending_encryption (peer was unknown when message was sent),
 * we now have the peer's public key — re-encrypt the message properly before sending.
 * Update the stored payload in SQLite so future retries also use the encrypted version.
 *
 * @param {object} msg  - Full message row from SQLite
 * @returns {Promise<boolean>} true if delivered
 */
async function attemptDelivery(msg) {
    const peer = getPeerByIdentity(msg.destination);
    if (!peer || !peer.ip) {
        log(`[dtn] No IP known for ${msg.destination} — stays queued for later`);
        return false;
    }

    // ── Re-encrypt if payload was stored as pending ────────────────────────────
    let payloadToSend = msg.payload;
    try {
        const parsed = JSON.parse(msg.payload);
        if (parsed.__pending_encryption) {
            const plaintext = parsed.__phase1_plaintext || '';
            if (!peer.public_key) {
                log(`[dtn] No public key for ${msg.destination} — cannot re-encrypt yet`);
                return false;
            }
            log(`[dtn] Re-encrypting pending message ${msg.id} for ${msg.destination}`);
            const blob = encrypt(plaintext, peer.public_key);
            payloadToSend = JSON.stringify(blob);
            // Persist the encrypted payload so retries don't re-encrypt
            updateMessagePayload(msg.id, payloadToSend);
        }
    } catch (parseErr) {
        // Payload is not JSON or already properly encrypted — send as-is
    }

    log(`[dtn] Delivering: ${msg.id} → ${msg.destination} at ${peer.ip}`);
    const deliverPayload = {
        id: msg.id,
        from_identity: msg.from_identity || identity,  // Preserve original sender
        destination: msg.destination,
        payload: payloadToSend,
        hop_count: msg.hop_count || 0,
        ttl: msg.ttl,
        created_at: msg.created_at,
    };

    try {
        markInTransit(msg.id);

        // Try TCP first (reliable, with ACK)
        let delivered = false;
        try {
            const result = await sendMessage(peer.ip, 'deliver', deliverPayload);
            if (result.ok) {
                delivered = true;
            } else {
                log(`[dtn] TCP: Peer rejected msg ${msg.id}: ${result.error || 'unknown'}`);
            }
        } catch (tcpErr) {
            log(`[dtn] TCP failed for ${msg.id}: ${tcpErr.message} — trying UDP fallback...`);

            // Fallback to UDP (works even when firewall blocks TCP)
            try {
                const udpResult = await sendDirectMessage(peer.ip, 'deliver', deliverPayload);
                if (udpResult.ok) {
                    delivered = true;
                    log(`[dtn] ✅ UDP fallback succeeded for ${msg.id}`);
                }
            } catch (udpErr) {
                log(`[dtn] UDP fallback also failed for ${msg.id}: ${udpErr.message}`);
            }
        }

        if (delivered) {
            markDelivered(msg.id);
            log(`[dtn] ✅ Delivered ${msg.id} to ${msg.destination}`);
            return true;
        }

        // Both TCP and UDP failed — revert to undelivered for retry
        openDb().prepare(`UPDATE messages SET status='undelivered' WHERE id=?`).run(msg.id);
        return false;
    } catch (err) {
        log(`[dtn] Delivery failed for ${msg.id}: ${err.message} — will retry later`);
        openDb().prepare(`UPDATE messages SET status='undelivered' WHERE id=?`).run(msg.id);
        return false;
    }
}

// ── Start networking subsystems ───────────────────────────────────────────────
const stopUDP = startUDP({
    identity,
    publicKey,
    onPeer: (peerIdentity, peerPublicKey, ip) => {
        upsertPeer(peerIdentity, peerPublicKey, ip);
        log(`[udp] Peer discovered: ${peerIdentity} at ${ip}`);

        // Phase 3: when a peer appears, deliver ALL queued messages for them
        // Including messages stored with __pending_encryption — attemptDelivery
        // will re-encrypt them now that we have the peer's public key.
        const pending = getMessagesForDestination(peerIdentity);
        if (pending.length > 0) {
            log(`[dtn] Peer ${peerIdentity} online — attempting ${pending.length} pending message(s)`);
            for (const msg of pending) {
                attemptDelivery(msg).catch((err) =>
                    log(`[dtn] Auto-deliver failed for ${msg.id}: ${err.message}`)
                );
            }
        }

        // Phase 4: trigger epidemic bundle exchange with this new peer
        // We push all our pending messages (for anyone) to them so they can spread it
        forwardMessages([ip]).catch(err => {
            log(`[epidemic] Failed to forward bundle to ${ip}: ${err.message}`);
        });
    },
    onPeerGoodbye: (peerIdentity) => {
        markPeerOffline(peerIdentity);
        log(`[udp] Peer ${peerIdentity} went offline — marked as unavailable`);
    },
    onMessage: handleIncomingMessage,
});

const stopTCP = startTCP({
    identity,
    privateKey,
    onMessage: handleIncomingMessage,
});

// ── Network change watcher ────────────────────────────────────────────────────
const stopNetworkWatcher = startNetworkWatcher((newIP, previousIP) => {
    log(`[network] Changed: ${previousIP} → ${newIP}. Re-announcing and sweeping pending...`);
    broadcastNow();
    startupDeliverySweep(); // re-try all pending to known peers on new network

    // Phase 4: Trigger bundle exchange of all pending messages with recently active peers
    const peerIPs = getActivePeers().map(p => p.ip).filter(ip => ip);
    if (peerIPs.length > 0) {
        log(`[epidemic] Network change triggered bundle exchange with ${peerIPs.length} peer(s)`);
        forwardMessages(peerIPs);
    }
});

// ── Phase 3: Startup / network-change delivery sweep ─────────────────────────
/**
 * Sweep ALL pending messages: for each message whose destination peer has a
 * known IP in SQLite, attempt delivery immediately.
 *
 * Also resets 'intransit' status back to 'undelivered' so mid-flight messages
 * from a previous daemon run can be cleanly retried.
 */
function startupDeliverySweep() {
    const db = openDb();

    // Reset lingering 'intransit' messages — they were mid-flight when daemon stopped
    const resetCount = db.prepare(
        `UPDATE messages SET status='undelivered' WHERE status='intransit'`
    ).run().changes;
    if (resetCount > 0) {
        log(`[dtn] Reset ${resetCount} intransit → undelivered for clean retry`);
    }

    const pending = getAllPending();
    if (pending.length === 0) {
        log('[dtn] Startup sweep: no pending messages.');
        return;
    }
    log(`[dtn] Startup sweep: ${pending.length} queued message(s)`);

    let attempted = 0;
    for (const msg of pending) {
        const peer = getPeerByIdentity(msg.destination);
        if (peer && peer.ip) {
            attemptDelivery(msg).catch((err) =>
                log(`[dtn] Startup delivery failed for ${msg.id}: ${err.message}`)
            );
            attempted++;
        }
    }
    if (attempted > 0) {
        log(`[dtn] Startup sweep: attempting ${attempted}/${pending.length} to known peers`);
    } else {
        log(`[dtn] Startup sweep: no peers with known IPs yet — waiting for UDP discovery`);
    }
}

// Run 2 s after startup so UDP has a chance to discover peers first
setTimeout(startupDeliverySweep, 2000).unref();

// ── Periodic delivery retry sweep ─────────────────────────────────────────────
// Every 30 s, retry all pending messages to known online peers.
// This handles transient failures, network changes, and delayed peer discovery.
const RETRY_SWEEP_INTERVAL_MS = 30_000;
setInterval(() => {
    const pending = getAllPending();
    if (pending.length === 0) return;

    let attempted = 0;
    for (const msg of pending) {
        const peer = getPeerByIdentity(msg.destination);
        if (peer && peer.ip) {
            attemptDelivery(msg).catch((err) =>
                log(`[dtn] Retry sweep failed for ${msg.id}: ${err.message}`)
            );
            attempted++;
        }
    }
    if (attempted > 0) {
        log(`[dtn] Retry sweep: attempting ${attempted}/${pending.length} pending message(s)`);
    }
}, RETRY_SWEEP_INTERVAL_MS).unref();

// ── Periodic stale peer cleanup ───────────────────────────────────────────────
// Every 60 s, remove peers not seen in 3 minutes (12+ missed 15s heartbeats).
const STALE_PEER_INTERVAL_MS = 60_000;
const STALE_PEER_THRESHOLD_MS = 3 * 60 * 1000;
setInterval(() => {
    const removed = removeInactivePeers(STALE_PEER_THRESHOLD_MS);
    if (removed > 0) {
        log(`[cleanup] Removed ${removed} stale peer(s) (not seen in 3 min)`);
    }
}, STALE_PEER_INTERVAL_MS).unref();

// ── IPC Server ────────────────────────────────────────────────────────────────
if (process.platform !== 'win32' && fs.existsSync(IPC_SOCKET)) {
    fs.unlinkSync(IPC_SOCKET);
}

const ipcServer = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            let cmd;
            try {
                cmd = JSON.parse(line);
            } catch {
                sendResponse(socket, { ok: false, error: 'Invalid JSON command' });
                continue;
            }
            handleCommand(cmd, socket);
        }
    });

    socket.on('error', () => { });
});

ipcServer.listen(IPC_SOCKET, () => {
    log(`IPC server listening on ${IPC_SOCKET}`);
});

ipcServer.on('error', (err) => {
    log('FATAL: IPC server error:', err.message);
    process.exit(1);
});

// ── IPC Command Dispatcher ────────────────────────────────────────────────────
function handleCommand(cmd, socket) {
    log(`IPC command: ${cmd.type}`);

    switch (cmd.type) {

        case 'ping':
            sendResponse(socket, { ok: true, identity, version: '1.0.0' });
            break;

        case 'stop':
            sendResponse(socket, { ok: true, message: 'Daemon shutting down...' });
            shutdown();
            break;

        case 'scan': {
            // Return only peers seen within the last 2 minutes (recent heartbeat)
            const SCAN_FRESHNESS_MS = 2 * 60 * 1000;
            const peers = getAllPeers(SCAN_FRESHNESS_MS);
            sendResponse(socket, { ok: true, peers });
            break;
        }

        // ── Phase 2: CLI asks daemon for a peer's public key before encrypting ──
        case 'get-peer-key': {
            const { identity: targetIdentity } = cmd;
            if (!targetIdentity) {
                sendResponse(socket, { ok: false, error: 'Missing identity' });
                break;
            }
            const peer = getPeerByIdentity(targetIdentity);
            if (peer) {
                sendResponse(socket, { ok: true, publicKey: peer.public_key, ip: peer.ip });
            } else {
                sendResponse(socket, { ok: false, error: 'Peer not found' });
            }
            break;
        }

        case 'send': {
            const { id, from_identity, destination, payload, ttl } = cmd;
            if (!id || !destination || !payload) {
                sendResponse(socket, { ok: false, error: 'Missing required fields: id, destination, payload' });
                break;
            }

            // ── Store first, always ──────────────────────────────────────────
            try {
                insertMessage({
                    id,
                    from_identity: from_identity || identity,
                    destination,
                    payload,
                    ttl,
                    status: 'undelivered',
                });
                log(`[send] Stored message ${id} → ${destination}`);
            } catch (err) {
                sendResponse(socket, { ok: false, error: `DB insert failed: ${err.message}` });
                break;
            }

            // If destination is our own identity — deliver immediately to ourselves
            if (destination === identity) {
                const msg = getMessageById(id);
                if (msg) {
                    handleIncomingMessage(msg, '127.0.0.1', false);
                    sendResponse(socket, { ok: true, messageId: id, status: 'delivered' });
                    break;
                }
            }

            // ── Attempt live delivery asynchronously ─────────────────────────
            const msg = getMessageById(id);
            attemptDelivery(msg)
                .then((delivered) => {
                    const finalStatus = delivered ? 'delivered' : 'undelivered';
                    sendResponse(socket, { ok: true, messageId: id, status: finalStatus });
                })
                .catch(() => {
                    sendResponse(socket, { ok: true, messageId: id, status: 'undelivered' });
                });

            // ── BUG 1 FIX: Epidemic spread — push this new message to ALL known peers ──
            // This is the core of epidemic routing: every peer on your current network
            // gets a copy so they can carry it to other networks.
            const activePeerIPs = getActivePeers().map(p => p.ip).filter(ip => ip);
            if (activePeerIPs.length > 0) {
                log(`[epidemic] Spreading new message ${id} to ${activePeerIPs.length} peer(s) on this network`);
                forwardMessages(activePeerIPs).catch(err => {
                    log(`[epidemic] Failed epidemic spread for ${id}: ${err.message}`);
                });
            }
            break;
        }

        case 'status': {
            const { messageId } = cmd;
            if (!messageId) {
                sendResponse(socket, { ok: false, error: 'Missing messageId' });
                break;
            }
            const msg = getMessageById(messageId);
            if (!msg) {
                sendResponse(socket, { ok: false, error: 'Message not found' });
            } else {
                sendResponse(socket, {
                    ok: true,
                    messageId: msg.id,
                    status: msg.status,
                    destination: msg.destination,
                    hop_count: msg.hop_count,
                    created_at: msg.created_at,
                    ttl: msg.ttl,
                });
            }
            break;
        }

        case 'sync': {
            const activePeers = getActivePeers();
            const allPending = getAllPending();
            log(`[sync] Manual sync triggered: ${allPending.length} pending, ${activePeers.length} active peers`);

            // Count how many have a known IP (can be attempted right now)
            const deliverable = allPending.filter(m => {
                const p = getPeerByIdentity(m.destination);
                return p && p.ip;
            });

            // Run the full sweep (handles intransit reset, re-encryption, and delivery)
            startupDeliverySweep();

            // Also trigger epidemic forwarding to all active peers
            const syncPeerIPs = activePeers.map(p => p.ip).filter(ip => ip);
            if (syncPeerIPs.length > 0) {
                forwardMessages(syncPeerIPs).catch(err => {
                    log(`[epidemic] Sync forward failed: ${err.message}`);
                });
            }

            sendResponse(socket, {
                ok: true,
                message: `Sync complete.`,
                pending: allPending.length,
                deliverable: deliverable.length,
                peers: activePeers.length,
            });
            break;
        }

        default:
            sendResponse(socket, { ok: false, error: `Unknown command: ${cmd.type}` });
    }
}

function sendResponse(socket, data) {
    try {
        socket.write(JSON.stringify(data) + '\n');
    } catch (_) { }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
    log('Daemon shutting down...');

    // Broadcast goodbye so peers immediately know we are leaving
    try { broadcastGoodbye(); } catch (_) { }

    // Give the goodbye packet a moment to be sent before closing the socket
    setTimeout(() => {
        stopNetworkWatcher();
        stopUDP();
        stopTCP();
        ipcServer.close(() => {
            if (process.platform !== 'win32' && fs.existsSync(IPC_SOCKET)) {
                try { fs.unlinkSync(IPC_SOCKET); } catch (_) { }
            }
            if (fs.existsSync(PID_FILE)) {
                try { fs.unlinkSync(PID_FILE); } catch (_) { }
            }
            log('Daemon stopped cleanly.');
            logStream.end(() => process.exit(0));
        });
    }, 200);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
    log('Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
    log('Unhandled rejection:', String(reason));
});
