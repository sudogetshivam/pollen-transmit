'use strict';

const { runCommand } = require('../ipc');

async function stopCommand() {
    await runCommand({ type: 'stop' }, (res) => {
        if (res.ok) {
            console.log('⛔ Pollen daemon stopped.');
        } else {
            console.error('❌ Stop failed:', res.error);
        }
    });
}

module.exports = { stopCommand };
