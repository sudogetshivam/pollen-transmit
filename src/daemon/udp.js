'use strict';

/**
 * UDP is used for:
 *   1. Peer discovery (broadcast)
 *   2. Message delivery fallback when TCP is blocked by firewall
 *
 * Broadcast address: computed from interface IP + netmask for subnet accuracy.
 * Falls back to 255.255.255.255 if no usable interface found.
 */

const dgram = require('dgram');
const os = require('os');

const UDP_PORT = 41234;
const BROADCAST_INTERVAL_MS = 15_000; // brodcast every 15 seconds as heartbeat, to notify peers of our presence and IP changes
const ANNOUNCE_TYPE = 'pollen-announce'; // announces our presence and public key to peers on the LAN, wether new or existing peers, so they can connect to us via TCP or UDP direct message delivery
const GOODBYE_TYPE = 'pollen-goodbye'; //send when we are leaving, so peers can immediately know we are leaving and remove us from their peer list, instead of waiting for a timeout to detect our absence
const DELIVER_TYPE = 'pollen-deliver'; //used for direct message delivery via UDP unicast, when TCP is blocked by firewall, so we can still deliver messages to peers on the same LAN without relying on TCP, but with best effort delivery (no retries, no ordering guarantees)
const RELAY_TYPE = 'pollen-relay'; //used for epidemic routing

// Max safe UDP payload size, because headers also need space 
const MAX_UDP_PAYLOAD = 60000;

let _socket = null; //handles UDP communication (broadcasts + direct messages)
let _broadcastInterval = null; //handles periodic broadcast timer
let _myIdentity = null; //our identity string e.g. shivam@a3f2, included in broadcasts so peers know who we are
let _myPublicKey = null; //our RSA public key PEM, included in broadcasts so peers can encrypt messages to us for direct UDP delivery when TCP is blocked


function computeBroadcast(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    const broadcast = ipParts.map((b, i) => (b | (~maskParts[i] & 0xff))); //xor of ip and subnet mask
    return broadcast.join('.');
}

/**
 * Get all LAN broadcast addresses for every non-loopback IPv4 interface.
 * Falls back to ['255.255.255.255'] if none found.
 */
function getBroadcastAddresses() {
    const addrs = [];
    const ifaces = os.networkInterfaces();
    for (const ifaceList of Object.values(ifaces)) {
        for (const iface of ifaceList) {
            if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
                addrs.push(computeBroadcast(iface.address, iface.netmask));
            }
        }
    }
    return addrs.length > 0 ? addrs : ['255.255.255.255'];
}

/**
 * Send a UDP broadcast announce on all LAN interfaces.
 * Goal: Tell every device on the LAN:
 * I am a Pollen node. Here is my identity and public key.
 */
function sendBroadcast() {
    if (!_socket || !_myIdentity || !_myPublicKey) return; //all are compulsory for broadcast

    //first this creates JSON, then converts it into binary data UDP sends bytes, not objects
    const packet = Buffer.from(JSON.stringify({
        type: ANNOUNCE_TYPE,
        identity: _myIdentity,
        publicKey: _myPublicKey,
    }));

    for (const addr of getBroadcastAddresses()) {
        //packet is the data we want to send,
        //  0 is the offset in the buffer, 
        // packet.length is the number of bytes to send, 
        // UDP_PORT is the destination port, 
        // addr is the destination IP address,the callback handles any errors that occur during sending
        _socket.send(packet, 0, packet.length, UDP_PORT, addr, (err) => {
            if (err) console.error(`[udp] Broadcast to ${addr} failed:`, err.message);
        });
    }
}

/**
 * Send a goodbye broadcast so peers immediately know we are leaving.
 */
function sendGoodbye() {
    if (!_socket || !_myIdentity) return;

    const packet = Buffer.from(JSON.stringify({
        type: GOODBYE_TYPE,
        identity: _myIdentity,
    }));

    for (const addr of getBroadcastAddresses()) {
        _socket.send(packet, 0, packet.length, UDP_PORT, addr, (err) => {
            if (err) console.error(`[udp] Goodbye broadcast to ${addr} failed:`, err.message);
        });
    }
}

/**
 * Send a message directly to a peer via UDP unicast.
 * This is the fallback when TCP is blocked by firewall.
 *
 * @param {string} peerIP - Target peer's IP address
 * @param {'deliver'|'relay'} frameType - 'deliver' for direct, 'relay' for epidemic
 * @param {object} message - Full message object
 * @returns {Promise<{ok: boolean}>}
 */
function sendDirectMessage(peerIP, frameType, message) {
    return new Promise((resolve, reject) => {
        if (!_socket) {
            reject(new Error('UDP socket not initialized'));
            return;
        }

        const udpType = frameType === 'deliver' ? DELIVER_TYPE : RELAY_TYPE;
        const data = JSON.stringify({ type: udpType, message });

        if (data.length > MAX_UDP_PAYLOAD) {
            reject(new Error(`Message too large for UDP delivery (${data.length} bytes > ${MAX_UDP_PAYLOAD})`));
            return;
        }

        const packet = Buffer.from(data);
        _socket.send(packet, 0, packet.length, UDP_PORT, peerIP, (err) => {
            if (err) {
                console.error(`[udp] Direct send to ${peerIP} failed:`, err.message);
                reject(err);
            } else {
                console.log(`[udp] Direct ${frameType} sent to ${peerIP} (${packet.length} bytes)`);
                resolve({ ok: true });
            }
        });
    });
}

/**
 * Basically it does 3 main jobs:
 * 
    Start a UDP socket and listen for packets

    Discover peers using broadcast

    Receive messages from other peers
 *
 * @param {object} opts
 * @param {string}   opts.identity       - Our identity string e.g. shivam@a3f2
 * @param {string}   opts.publicKey      - Our RSA public key PEM
 * @param {function} opts.onPeer         - Called with (identity, publicKeyPem, remoteIP) on discovery
 * @param {function} [opts.onPeerGoodbye] - Called with (identity) when a peer sends goodbye
 * @param {function} [opts.onMessage]    - Called with (message, remoteIP, isRelay) for UDP-delivered messages
 * @returns {function} stop — call to shut down UDP
 */
function startUDP({ identity, publicKey, onPeer, onPeerGoodbye, onMessage }) {
    if (_socket) return () => stopUDP(); //if connection already exists, return the stop function without creating a new socket

    _myIdentity = identity;
    _myPublicKey = publicKey;

    //opens a UDP socket for IPv4 with address reuse enabled (allows multiple processes to bind to the same port, useful for multiple Pollen instances on the same LAN)
    _socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    _socket.on('error', (err) => {
        console.error('[udp] Socket error:', err.message);
    });

    //this runs whenever a UDP packet is recieved
    _socket.on('message', (msg, rinfo) => {
        let packet;
        try {
            packet = JSON.parse(msg.toString('utf8'));
        } catch {
            return; // ignore malformed packets
        }

        //goodbye
        if (packet.type === GOODBYE_TYPE && packet.identity) {
            if (packet.identity === _myIdentity) return; // ignore our own
            console.log(`[udp] Peer goodbye: ${packet.identity}`);
            try {
                if (onPeerGoodbye) onPeerGoodbye(packet.identity);
            } catch (err) {
                console.error('[udp] onPeerGoodbye handler error:', err.message);
            }
            return;
        }

        //direct message delivery via UDP 
        if (packet.type === DELIVER_TYPE && packet.message) {
            console.log(`[udp] Received direct message id=${packet.message.id} from ${rinfo.address}`);
            try {
                if (onMessage) onMessage(packet.message, rinfo.address, false); //value false for direct delivery, so onMessage can distinguish between direct and relay messages if needed
            } catch (err) {
                console.error('[udp] onMessage (deliver) error:', err.message);
            }
            return;
        }

        // relay message via UDP for epidemic routing (used when destination peer is not currently on the network, so we relay to other peers in the hope that one of them will eventually meet the destination peer and deliver it)
        if (packet.type === RELAY_TYPE && packet.message) {
            console.log(`[udp] Received relay message id=${packet.message.id} from ${rinfo.address}`);
            try {
                if (onMessage) onMessage(packet.message, rinfo.address, true);
            } catch (err) {
                console.error('[udp] onMessage (relay) error:', err.message);
            }
            return;
        }

        // Handle announce 
        if (packet.type !== ANNOUNCE_TYPE) return;
        if (!packet.identity || !packet.publicKey) return;

        // Ignore our own broadcasts
        if (packet.identity === _myIdentity) return;

        console.log(`[udp] Peer discovered: ${packet.identity} at ${rinfo.address}`);
        try {
            onPeer(packet.identity, packet.publicKey, rinfo.address);
        } catch (err) {
            console.error('[udp] onPeer handler error:', err.message);
        }
    });

    _socket.bind(UDP_PORT, () => {
        _socket.setBroadcast(true);
        console.log(`[udp] Listening on port ${UDP_PORT}`);


        // Broadcast immediately so peers on the LAN discover us fast
        sendBroadcast();

        // Re-broadcast every 15 s, setInterval will automatically call sendBroadcast every 15 seconds
        _broadcastInterval = setInterval(sendBroadcast, BROADCAST_INTERVAL_MS);
        /**
         * if nothing else is running
            allow program to exit
         */
        _broadcastInterval.unref();

    });

    _socket.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[udp] Port ${UDP_PORT} already in use.`);
        }
    });

    return () => stopUDP();
}

function stopUDP() {
    if (_broadcastInterval) {
        clearInterval(_broadcastInterval);
        _broadcastInterval = null;
    }
    if (_socket) {
        _socket.close();
        _socket = null;
    }
    console.log('[udp] Stopped.');
}

 // Broadcast a goodbye (exit ke waqt call karna).
function broadcastGoodbye() {
    sendGoodbye();
}

/**
 * Broadcast our identity immediately on the current network.
 * Called when a network change is detected.
 */
function broadcastNow() {
    sendBroadcast();
}

/**
 * Get the current UDP socket
 */
function getSocket() { return _socket; }

module.exports = { startUDP, stopUDP, broadcastNow, broadcastGoodbye, sendDirectMessage, getSocket, UDP_PORT };
