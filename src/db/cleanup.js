'use strict';

const { openDb } = require('./index');

/**
 * Delete all messages that have expired (ttl < now) and are not delivered.
 * Delivered messages are kept as a record so senders can still check
 * pollen status <id>. They are cleaned up after 30 days.
 * Also clean up peers that haven't been seen in 1 hour, to prevent stale peer entries.
 */
function cleanExpired() {
    const db = openDb();
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    // Delete expired undelivered/intransit messages
    const r1 = db.prepare(`
    DELETE FROM messages
    WHERE ttl < ? AND status != 'delivered'
  `).run(now);

    //clean up old delivered messages
    const r2 = db.prepare(`
    DELETE FROM messages
    WHERE status = 'delivered' AND created_at < ?
  `).run(thirtyDaysAgo);

    // Clean up peers not seen in 1 hour (with 15s heartbeats, a live peer would have re-announced many times)
    const oneHourAgo = now - 60 * 60 * 1000;
    db.prepare(`DELETE FROM peers WHERE last_seen < ?`).run(oneHourAgo);

    const deleted = r1.changes + r2.changes;
    if (deleted > 0) {
        console.log(`[cleanup] Removed ${deleted} expired message(s) from storage.`);
    }
    return deleted;
}

module.exports = { cleanExpired };
