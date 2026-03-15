'use strict';

/**
 * CLI → Daemon IPC client.
 *
 * Connects to the daemon's IPC socket (Unix socket on Linux/macOS,
 * named pipe on Windows), sends a newline-delimited JSON command,
 * waits for the JSON response, then resolves.
 *
 * Never hangs — times out after 5 seconds.
 */

const net = require('net');
const path = require('path');
const os = require('os');

const POLLEN_DIR = path.join(os.homedir(), '.pollen');

function getIPCPath() {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\pollen-ipc'; //Windows uses named pipes.
    }
    return path.join(POLLEN_DIR, 'daemon.sock'); //Unix socket for Linux/macOS.
}

const IPC_SOCKET = getIPCPath();
const TIMEOUT_MS = 5000;

/**
 * Send a command object to the daemon and return the response.
 *
 * @param {object} command - e.g. { type: 'ping' } or { type: 'send', ... }
 * @returns {Promise<object>} - The daemon's JSON response
 */
function sendCommand(command) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let buffer = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            socket.destroy();
            reject(new Error('TIMEOUT'));
        }, TIMEOUT_MS);

        socket.connect(IPC_SOCKET, () => {
            socket.write(JSON.stringify(command) + '\n');
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                clearTimeout(timer);
                try {
                    const response = JSON.parse(line);
                    socket.destroy();
                    resolve(response);
                } catch {
                    socket.destroy();
                    reject(new Error('Invalid response from daemon'));
                }
                return;
            }
        });

        socket.on('error', (err) => {
            if (timedOut) return;
            clearTimeout(timer);
            socket.destroy();
            if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
                reject(new Error('DAEMON_NOT_RUNNING'));
            } else {
                reject(err);
            }
        });

        socket.on('close', () => {
            if (timedOut) return;
            clearTimeout(timer);
            // If we got here without resolving, resolve with empty
            resolve({ ok: false, error: 'Connection closed unexpectedly' });
        });
    });
}

/**
 * Convenience wrapper: send a command and print the result.
 * Handles "daemon not running" with a user-friendly message.
 *
 * @param {object} command
 * @param {function} formatter - (response) => void — formats and prints the result
 */
async function runCommand(command, formatter) {
    try {
        const response = await sendCommand(command);
        formatter(response);
    } catch (err) {
        if (err.message === 'DAEMON_NOT_RUNNING') {
            console.error('❌ Daemon is not running. Start it with: pollen start');
        } else if (err.message === 'TIMEOUT') {
            console.error('❌ Daemon is not responding (timeout). Try: pollen stop && pollen start');
        } else {
            console.error('❌ IPC error:', err.message);
        }
        process.exit(1);
    }
}

/**
 * Check if daemon is alive (ping).
 * Returns true if responding, false otherwise.
 */
async function isDaemonRunning() {
    try {
        const res = await sendCommand({ type: 'ping' });
        return res.ok === true;
    } catch {
        return false;
    }
}

module.exports = { sendCommand, runCommand, isDaemonRunning, IPC_SOCKET };
