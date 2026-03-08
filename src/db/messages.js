'use strict';

const { openDb } = require('./index'); //importing database

const DEFAULT_TTL_DAYS = 7;

//inserting a message in databse
function insertMessage(msg) {
    const db = openDb();
    const now = Date.now();
    const ttl = msg.ttl || now + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000;//if message has ttl, if not add 7 days later

    //preparing sql query
    const stmt = db.prepare(`
    INSERT INTO messages (id, from_identity, destination, payload, status, hop_count, ttl, created_at)
    VALUES (@id, @from_identity, @destination, @payload, @status, @hop_count, @ttl, @created_at)
  `);

    stmt.run({
        id: msg.id,
        from_identity: msg.from_identity,
        destination: msg.destination,
        payload: msg.payload,
        status: msg.status || 'undelivered',
        hop_count: msg.hop_count || 0,
        ttl,
        created_at: now,
    });
}

//retrieves the message from message id
function getMessageById(id) {
    const db = openDb();
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null; //idhar run kyu nahi use kiya?
}

/**
 * Retrieve all messages that are undelivered or intransit.
 * Used for epidemic forwarding.
 */
function getAllPending() {
    const db = openDb();
    return db.prepare(`
    SELECT * FROM messages
    WHERE status IN ('undelivered', 'intransit')
    AND hop_count < 20
    AND ttl > ?
  `).all(Date.now()); //same here, idhar bhi run use nahi kiya??
}

 //update status to delivered
function markDelivered(id) {
    const db = openDb();
    db.prepare(`UPDATE messages SET status = 'delivered' WHERE id = ?`).run(id);
}

 //update status to transmit
function markInTransit(id) {
    const db = openDb();
    db.prepare(`UPDATE messages SET status = 'intransit' WHERE id = ?`).run(id);
}

 //Increment hop count for a message.
function incrementHop(id) {
    const db = openDb();
    db.prepare(`UPDATE messages SET hop_count = hop_count + 1 WHERE id = ?`).run(id);
}

//when a relay sends a message to their peer, used when message need re-encryption
function updateMessagePayload(id, newPayload) {
    const db = openDb();
    db.prepare(`UPDATE messages SET payload = ? WHERE id = ?`).run(newPayload, id);
}

/**
 * Get all pending messages destined for a specific identity.
 * Used when a peer is discovered via UDP to trigger targeted delivery.
 */
function getMessagesForDestination(destination) {
    const db = openDb();
    return db.prepare(`
    SELECT * FROM messages
    WHERE destination = ?
      AND status IN ('undelivered', 'intransit')
      AND hop_count < 20
      AND ttl > ?
  `).all(destination, Date.now());
}

/**
 * 
 * Upsert a message received from a peer (for epidemic relay).
 * If message already exists (same ID), update hop_count if incoming is lower.
 * This prevents re-inserting messages we already have and avoids loops.
 */
function upsertMessage(msg) {
    const db = openDb();
    const existing = getMessageById(msg.id);
    if (existing) {
        // Already have it — only update hop count if the incoming route is shorter
        if (msg.hop_count < existing.hop_count) {
            db.prepare(`UPDATE messages SET hop_count = ? WHERE id = ?`)
                .run(msg.hop_count, msg.id);
        }
        return 'exists';
    }
    insertMessage(msg);
    return 'inserted';
}

/**
 * Upsert a known peer, their public key, and current IP. 3 things can happen:
 * if peer already exists, update their public key and IP if changed, and refresh last_seen.
 * if peer is new, insert them with current timestamp.
 * if peer goes offline, we can nullify their IP but keep their public key for future re-encryption when they come back online.
 */
function upsertPeer(identity, publicKeyPem, ip) {
    const db = openDb();
    db.prepare(`
    INSERT INTO peers (identity, public_key, ip, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(identity) DO UPDATE SET
      public_key = excluded.public_key,
      ip         = COALESCE(excluded.ip, peers.ip),
      last_seen  = excluded.last_seen
  `).run(identity, publicKeyPem, ip || null, Date.now());
}

/**
 * Retrieve a peer's public key by their identity string.
 * Returns null if unknown.
 */
function getPeerPublicKey(identity) {
    const db = openDb();
    const row = db.prepare('SELECT public_key FROM peers WHERE identity = ?').get(identity);
    return row ? row.public_key : null; // if row exists, return public_key, else return null
}

/**
 * Retrieve a full peer record (identity, public_key, ip, last_seen).
 * Returns null if unknown.
 */
function getPeerByIdentity(identity) {
    const db = openDb();
    return db.prepare('SELECT * FROM peers WHERE identity = ?').get(identity) || null;
}

/**
 * Get all known active peers (seen within last 5 minutes).
 */
function getActivePeers(withinMs = 5 * 60 * 1000) {
    const db = openDb();
    return db.prepare('SELECT * FROM peers WHERE last_seen > ?').all(Date.now() - withinMs);
}

/**
 * Get all peers, optionally filtered by recency.
 * @param {number} [withinMs] - Only return peers seen within this many ms. 0 = all peers.
 */
function getAllPeers(withinMs = 0) {
    const db = openDb();
    if (withinMs > 0) {
        const cutoff = Date.now() - withinMs;
        return db.prepare('SELECT identity, ip, last_seen FROM peers WHERE last_seen > ? ORDER BY last_seen DESC').all(cutoff);
    }
    return db.prepare('SELECT identity, ip, last_seen FROM peers ORDER BY last_seen DESC').all();
}

/**
 * Mark a peer as offline (nullify IP) but keep their public key for future re-encryption.
 * @param {string} identity
 */
function markPeerOffline(identity) {
    const db = openDb();
    db.prepare('UPDATE peers SET ip = NULL WHERE identity = ?').run(identity);
}

 // Clear all peer IPs on daemon startup (stale from previous session).
function clearAllPeerIPs() {
    const db = openDb();
    db.prepare('UPDATE peers SET ip = NULL').run();
}

/**
 * Remove peers not seen within a given threshold.
 * @param {number} olderThanMs - Remove peers with last_seen older than this many ms ago
 * @returns {number} Number of peers removed
 */
function removeInactivePeers(olderThanMs) {
    const db = openDb();
    const cutoff = Date.now() - olderThanMs;
    return db.prepare('DELETE FROM peers WHERE last_seen < ?').run(cutoff).changes;
}

module.exports = {
    insertMessage,
    getMessageById,
    getAllPending,
    markDelivered,
    markInTransit,
    incrementHop,
    updateMessagePayload,
    getMessagesForDestination,
    upsertMessage,
    upsertPeer,
    getPeerByIdentity,
    getPeerPublicKey,
    getActivePeers,
    getAllPeers,
    markPeerOffline,
    clearAllPeerIPs,
    removeInactivePeers,
};
