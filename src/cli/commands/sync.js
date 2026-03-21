'use strict';

const { runCommand } = require('../ipc');

async function syncCommand() {
    console.log('🔄 Triggering sync with all known peers...');
    await runCommand({ type: 'sync' }, (res) => {
        if (!res.ok) {
            console.error('❌ Sync failed:', res.error);
            return;
        }

        console.log(`\n🔄 Sync complete!\n`);
        console.log(`   Pending messages:   ${res.pending}`);
        console.log(`   Deliverable now:    ${res.deliverable} (peers with known IPs)`);
        console.log(`   Known peers:        ${res.peers}`);

        if (res.pending > 0 && res.deliverable === 0) {
            console.log(`\n   ⏳ Messages are queued but destination peers are not`);
            console.log(`      yet on this network. They will deliver automatically`);
            console.log(`      when those peers appear. (This is Epidemic Routing)\n`);
        } else if (res.deliverable > 0) {
            console.log(`\n   📤 Delivery in progress — check status with:`);
            console.log(`      pollen status <messageId>\n`);
        } else {
            console.log(`\n   ✅ No pending messages.\n`);
        }
    });
}

module.exports = { syncCommand };
