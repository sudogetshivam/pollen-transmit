'use strict';

/**
 * pollen start — Start the background daemon.
 *
 * Handles:
 *  1. First-time identity + keypair setup (interactive)
 *  2. Crash recovery (stale PID file detection)
 *  3. Idempotent: if daemon already running, says so and exits
 *  4. Spawns daemon detached with windowsHide: true
 *  5. Waits up to 3 s for daemon IPC to become ready, then confirms
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { loadOrCreate } = require('../../identity/index');
const { loadOrCreateKeypair } = require('../../crypto/keys');
const { isDaemonRunning } = require('../ipc');

const POLLEN_DIR = path.join(os.homedir(), '.pollen');
const PID_FILE = path.join(POLLEN_DIR, 'daemon.pid');
const DAEMON_ENTRY = path.resolve(__dirname, '../../daemon/index.js');

/**
 * Check if a process with the given PID is alive.
 * Cross-platform: signal 0 on unix, tasklist on Windows.
 */
function isProcessAlive(pid) {
    try {
        // kill(pid, 0) does not send a signal — just checks existence
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means process exists but we can't signal it — still alive
        return err.code === 'EPERM';
    }
}

/**
 * Remove a stale PID file if the process is not running.
 * Returns true if a stale PID was cleaned up.
 */
function cleanStalePid() {
    if (!fs.existsSync(PID_FILE)) return false;

    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);

    if (!pid || isNaN(pid)) {
        fs.unlinkSync(PID_FILE);
        return true;
    }

    if (!isProcessAlive(pid)) {
        console.log(`⚠️  Found stale PID file (PID ${pid} is not running). Cleaning up...`);
        fs.unlinkSync(PID_FILE);
        return true;
    }

    return false; // Process is alive — daemon is running
}

/**
 * Wait for IPC to become responsive. Polls every 200ms up to maxMs.
 */
async function waitForDaemon(maxMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        if (await isDaemonRunning()) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

async function startCommand() {
    // ── 1. First-time setup (identity + keypair) ───────────────────────────────
    //    Must happen BEFORE daemon spawn because daemon reads identity from disk.
    const identity = await loadOrCreate();
    loadOrCreateKeypair(); // generate if not exists, silent if already there

    // ── 2. Crash recovery ──────────────────────────────────────────────────────
    const wasStale = cleanStalePid();

    // ── 3. Check if already running ───────────────────────────────────────────
    if (!wasStale && fs.existsSync(PID_FILE)) {
        // PID file exists and process is alive → already running
        if (await isDaemonRunning()) {
            console.log(`✅ Pollen daemon is already running as ${identity.identity}`);
            return;
        }
        // PID alive but IPC not responding — force clean and restart
        console.log('⚠️  Daemon PID exists but IPC is unresponsive. Force-restarting...');
        fs.unlinkSync(PID_FILE);
    }

    // ── 4. Spawn daemon ───────────────────────────────────────────────────────
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,   // Critical: no console window on Windows
    });
    child.unref(); // Allow CLI to exit immediately

    console.log(`🌿 Starting Pollen daemon... (PID will be ${child.pid})`);

    // ── 5. Wait for IPC ready ─────────────────────────────────────────────────
    const ready = await waitForDaemon(4000);

    if (ready) {
        console.log(`\n✅ Pollen daemon is running!`);
        console.log(`   Your identity: ${identity.identity}`);
        console.log(`   Log: ~/.pollen/daemon.log`);
        console.log(`   Stop: pollen stop\n`);
    } else {
        console.error(
            '\n⚠️  Daemon spawned but IPC is not responding yet.\n' +
            '   It may still be starting up — check ~/.pollen/daemon.log for details.'
        );
    }
}

module.exports = { startCommand };
