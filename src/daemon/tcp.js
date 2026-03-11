'use strict';


const net = require('net');

const TCP_PORT = 41235;
const CONNECT_TIMEOUT_MS = 2000; //wait 2second for peers to respond to TCP connection attempts
const SEND_TIMEOUT_MS = 8000;   

let _server = null;
let _identity = null;
let _privateKey = null;
let _onMessage = null;


function startTCP({ identity, privateKey, onMessage }) {
    if (_server) return () => stopTCP();

    _identity = identity;
    _privateKey = privateKey;
    _onMessage = onMessage;

    _server = net.createServer((socket) => {
        handleIncomingConnection(socket); //creates tcp server and listens for incoming connections, this function will read message frame, parse JSON, process message
    });

    _server.listen(TCP_PORT, '0.0.0.0', () => { //0.0.0.0 means listen on all interfaces 
        console.log(`[tcp] Server listening on port ${TCP_PORT}`); // means node is ready to receive TCP messages from peers. Peers will connect to this port to send messages directly to this node.
    });

    _server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[tcp] Port ${TCP_PORT} is already in use. Another daemon may be running.`);
        } else {
            console.error('[tcp] Server error:', err.message);
        }
    });

    return () => stopTCP();
}

/**
 * Handle an incoming TCP connection from a peer.
 * Uses newline-delimited JSON framing.
 */

//Shivam (192.168.1.12) ───TCP───> Amrit (192.168.1.25)
function handleIncomingConnection(socket) {
    let buffer = '';
    const remoteIP = socket.remoteAddress; //get the IP address of the peer that connected to us. This is used for logging and to pass to the onMessage handler so it knows where the message came from.

    socket.on('data', (chunk) => { //this runs whenever we receive data from the peer over TCP. chunk = <Buffer ...>
        buffer += chunk.toString('utf8'); //convert the chunk to a string and append it to the buffer. We use a buffer because TCP can split messages into multiple chunks, so we need to accumulate them until we get a full message (delimited by newline).
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep trailing incomplete chunk, Because the last piece might be incomplete.

        for (const line of lines) {
            if (!line.trim()) continue;
            let frame;
            try {
                frame = JSON.parse(line); //converts JSON string to a JavaScript object. If the peer sent invalid JSON, this will throw an error, which we catch and respond with an ACK indicating the error.
            } catch {
                socket.write(JSON.stringify({ type: 'ack', ok: false, error: 'Invalid JSON' }) + '\n');//if parsing fails, we send an ACK back to the peer indicating that the frame was malformed. We then skip processing this frame and wait for the next one.
                continue;
            }
            processFrame(frame, socket, remoteIP);
        }
    });

    socket.on('error', () => { }); // peer disconnect — ignore
    socket.on('close', () => { });

    // Auto-close after 30 s of inactivity
    socket.setTimeout(30_000, () => socket.destroy());
}

 // Process frames received from peers. This is where we handle both "deliver" frames (messages addressed to us) and "relay" frames (messages that we need to store and forward later).
function processFrame(frame, socket, remoteIP) {
    //frame: { type: 'deliver' | 'relay', message: { id, from_identity, destination, ... } } --->parsed JSON from perr,
    //socket: the TCP socket connected to the peer that sent this frame. We use this to send ACKs back to the peer after processing the frame.
    //remoteIP: the IP address of the peer that sent this frame. This is used for logging and is also passed to the onMessage handler so it knows where the message came from.
    const { type, message } = frame;

    if (!message || !message.id) {
        socket.write(JSON.stringify({ type: 'ack', ok: false, error: 'Malformed frame' }) + '\n');
        return;
    }

    if (type === 'deliver') {
        // Message is addressed to us — call the delivery handler
        console.log(`[tcp] Incoming message id=${message.id} from=${message.from_identity || '?'} via ${remoteIP}`);
        try {
            if (_onMessage) _onMessage(message, remoteIP);
            socket.write(JSON.stringify({ type: 'ack', messageId: message.id, ok: true }) + '\n');
        } catch (err) {
            console.error('[tcp] onMessage handler error:', err.message);
            socket.write(JSON.stringify({ type: 'ack', messageId: message.id, ok: false, error: err.message }) + '\n');
        }
    } else if (type === 'relay') {
        // Message is for someone else — store it
        console.log(`[tcp] Relay message id=${message.id} → ${message.destination} via ${remoteIP}`);
        try {
            if (_onMessage) _onMessage(message, remoteIP, true /* isRelay */);
            socket.write(JSON.stringify({ type: 'ack', messageId: message.id, ok: true }) + '\n');
        } catch (err) {
            socket.write(JSON.stringify({ type: 'ack', messageId: message.id, ok: false, error: err.message }) + '\n');
        }
    } else {
        socket.write(JSON.stringify({ type: 'ack', ok: false, error: `Unknown frame type: ${type}` }) + '\n');
    }
}

function stopTCP() {
    if (_server) {
        _server.close();
        _server = null;
        console.log('[tcp] Stopped.');
    }
}

/**
 * Send a message to a peer over TCP.
 * Waits for ACK before resolving.
 */
function sendMessage(peerIP, frameType, message) {
    //connect → send frame → wait for ACK → resolve/reject
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let buffer = '';
        let settled = false; //A Promise must only resolve/reject once.

        /*
        *8 seconds passed
no response
abort connection
         */
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.destroy();
                reject(new Error(`TCP send to ${peerIP} timed out`));
            }
        }, SEND_TIMEOUT_MS);

        socket.setTimeout(CONNECT_TIMEOUT_MS);
        socket.on('timeout', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                socket.destroy();
                reject(new Error(`TCP connect to ${peerIP}:${TCP_PORT} timed out`));
            }
        });

        socket.connect(TCP_PORT, peerIP, () => {
            // Connection established — send the frame
            const frame = JSON.stringify({ type: frameType, message }) + '\n';
            socket.write(frame);
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const ack = JSON.parse(line);
                    if (!settled && ack.type === 'ack') {
                        settled = true;
                        clearTimeout(timeout);
                        socket.destroy();
                        resolve({ ok: ack.ok, messageId: ack.messageId });
                    }
                } catch {
                    // wait for more data
                }
            }
        });

        socket.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(err);
            }
        });

        socket.on('close', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(`Connection to ${peerIP} closed before ACK`));
            }
        });
    });
}

module.exports = { startTCP, stopTCP, sendMessage, TCP_PORT };
