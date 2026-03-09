'use strict';

const os = require('os');//it provides information about system

//returns current machine ipv4 address if not present in network returns null
function getCurrentIP() {
    const ifaces = os.networkInterfaces(); // our machine has different network interfaces like wlan,eth,virtualbox net
    //this networkInterfaces function gives all netowrk interface and their addresses

    //something like this

    /**
     * {
  lo: [
    { address: "127.0.0.1", family: "IPv4", internal: true }
  ],
  eth0: [
    { address: "192.168.1.12", family: "IPv4", internal: false }
  ],
  wlan0: [
    { address: "192.168.1.15", family: "IPv4", internal: false }
  ]
}
     */
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                //as we know eth0 and wlan0 are external so we have to make this condition true
                //also lo(localhost) we cant take this, because own cannot connect with own
                return iface.address;
            }
        }
    }
    return null;
}

/**
 * Start polling for network changes every 30 seconds.
 * Returns a function that stops the watcher when called.
 */

// The function does not define onChangeCallback itself.
//It expects the caller to pass a function when calling startNetworkWatcher
function startNetworkWatcher(onChangeCallback) {
    let currentIP = getCurrentIP();
    console.log(`[network] Current IP: ${currentIP || 'none'}`);

    const interval = setInterval(() => {
        const newIP = getCurrentIP();
        if (newIP !== currentIP) {
            const previousIP = currentIP;
            currentIP = newIP;
            console.log(`[network] Network change detected: ${previousIP} → ${newIP}`);
            try {
                /**
                 * Function that accepts a callback
    function greet(callback) {
            console.log("Hello");
                callback();
}

Now call it:

greet(() => {
    console.log("Callback executed");
});

Output:

Hello
Callback executed
                 */
                onChangeCallback(newIP, previousIP);
            } catch (err) {
                console.error('[network] onChangeCallback error:', err.message);
            }
        }
    }, 15_000);

    // Return a stop function
    return () => clearInterval(interval);
}

module.exports = { getCurrentIP, startNetworkWatcher };
