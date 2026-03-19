'use strict';

const { runCommand } = require('../ipc');

async function statusCommand(messageId) {
    if (!messageId) {
        console.error('Usage: pollen status <messageId>');
        process.exit(1);
    }

    await runCommand({ type: 'status', messageId }, (res) => {
        if (!res.ok) {
            console.error(`❌ ${res.error}`);
            return;
        }

        const icons = {
            undelivered: '🕐',
            intransit: '🚀',
            delivered: '✅',
        };

        const labels = {
            undelivered: 'Undelivered  (waiting for a carrier to pass through)',
            intransit: 'In Transit   (virus is spreading through the network)',
            delivered: 'Delivered    (recipient received and decrypted)',
        };

        const s = res.status;
        const created = new Date(res.created_at).toLocaleString();
        const expires = new Date(res.ttl).toLocaleString();

        console.log(`\n${icons[s] || '❓'} Message Status`);
        console.log(`   ID:          ${res.messageId}`);
        console.log(`   To:          ${res.destination}`);
        console.log(`   Status:      ${labels[s] || s}`);
        console.log(`   Hops:        ${res.hop_count}`);
        console.log(`   Created:     ${created}`);
        console.log(`   Expires:     ${expires}\n`);
    });
}

module.exports = { statusCommand };
