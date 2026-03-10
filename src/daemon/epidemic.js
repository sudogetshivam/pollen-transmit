'use strict';

const crypto = require('crypto');
const { encrypt } = require('../crypto/encrypt');
const { getAllPending, insertMessage, getPeerPublicKey } = require('../db/messages');
const { sendMessage } = require('./tcp');
const { sendDirectMessage } = require('./udp');

function log(msg) {
    console.warn(msg);
}

/**
 * Forward all pending messages to a list of peer IPs.
 * Tries TCP first, falls back to UDP if TCP fails (firewall blocking).
 * @param {string[]} peerIPs - List of peer IP addresses
 */
function forwardMessages(peerIPs) {
    if (!peerIPs || peerIPs.length === 0) return Promise.resolve();

    // getAllPending already filters by hop_count < 20 and TTL
    const pending = getAllPending();
    if (pending.length === 0) return Promise.resolve();

    log(`[epidemic] Forwarding ${pending.length} message(s) to ${peerIPs.length} peer(s)`);

    const promises = [];
    for (const ip of peerIPs) {
        for (const msg of pending) {
            const relayPayload = {
                id: msg.id,
                from_identity: msg.from_identity,
                destination: msg.destination,
                payload: msg.payload,     // Opaque encrypted blob
                hop_count: msg.hop_count, // Receiver will increment this
                ttl: msg.ttl,
                created_at: msg.created_at,
            };

            // Try TCP first, fallback to UDP if TCP fails
            const relayPromise = sendMessage(ip, 'relay', relayPayload)
                .catch(tcpErr => {
                    // TCP failed — try UDP fallback (works through firewalls)
                    return sendDirectMessage(ip, 'relay', relayPayload)
                        .catch(udpErr => {
                            log(`[epidemic] Failed to relay ${msg.id} to ${ip} (TCP+UDP both failed)`);
                        });
                });

            promises.push(relayPromise);
        }
    }

    return Promise.all(promises).then(() => {
        log(`[epidemic] Bundle exchange complete`);
    });
}

/**
 * Process a received bundle of messages from a peer.
 * (Currently not used as TCP/UDP handles frames immediately)
 */
function receiveBundle(bundle) {
    return [];
}


// Send an ACK for a delivered message back through the epidemic network.
function sendAck(messageId, originalSender, myIdentity) {
    const ackId = crypto.randomUUID();
    const ackPayload = JSON.stringify({ __type: 'ack', ackMessageId: messageId });

    let encryptedPayload;
    const peerKey = getPeerPublicKey(originalSender);
    if (peerKey) {
        encryptedPayload = JSON.stringify(encrypt(ackPayload, peerKey));
    } else {
        encryptedPayload = JSON.stringify({
            __pending_encryption: true,
            __phase1_plaintext: ackPayload,
        });
    }

    log(`[epidemic] Generating ACK ${ackId} for message ${messageId} -> ${originalSender}`);

    try {
        insertMessage({
            id: ackId,
            from_identity: myIdentity,
            destination: originalSender,
            payload: encryptedPayload,
            ttl: Date.now() + 7 * 24 * 60 * 60 * 1000,
            status: 'undelivered', // Enqueue for epidemic spread
            hop_count: 0,
        });
    } catch (err) {
        log(`[epidemic] Failed to store ACK msg: ${err.message}`);
    }

    return Promise.resolve(); //just return a resolved promise since the actual sending will happen during the next epidemic forwarding cycle
}

module.exports = { forwardMessages, receiveBundle, sendAck };
