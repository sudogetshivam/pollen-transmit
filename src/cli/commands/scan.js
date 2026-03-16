'use strict';

const { runCommand } = require('../ipc');

async function scanCommand() {
    await runCommand({ type: 'scan' }, (res) => {
        if (!res.ok) {
            console.error('❌', res.error);
            return;
        }

        const peers = res.peers || [];
        if (peers.length === 0) {
            console.log('\n🔍 No Pollen peers found on current network.\n');
            console.log('   Peers appear automatically when other Pollen daemons');
            console.log('   start broadcasting on the same WiFi/LAN.\n');
            return;
        }

        console.log(`\n🌿 Pollen peers on this network:\n`);
        console.log('  Identity           IP Address        Last Seen     Status');
        console.log('  ─────────────────  ────────────────  ────────────  ──────');
        for (const peer of peers) {
            const ago = formatAgo(peer.last_seen);
            const ip = (peer.ip || 'unknown').padEnd(16);
            const status = isOnline(peer.last_seen) ? '🟢 Online' : '⚪ Stale';
            console.log(`  ${peer.identity.padEnd(18)} ${ip}  ${ago.padEnd(12)}  ${status}`);
        }
        console.log(`\n  Total: ${peers.length} peer(s)\n`);
    });
}

function isOnline(epochMs) {
    if (!epochMs) return false;
    return (Date.now() - epochMs) < 90_000; // 90 s (6 heartbeats at 15s)
}

function formatAgo(epochMs) {
    if (!epochMs) return 'unknown';
    const diff = Date.now() - epochMs;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

module.exports = { scanCommand };

