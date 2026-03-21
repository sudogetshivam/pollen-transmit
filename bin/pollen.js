#!/usr/bin/env node
'use strict';

/**
 * pollen — CLI entry point
 * All commands delegate to the daemon via IPC.
 * The CLI itself does zero networking.
 */

const { program } = require('commander');
const { startCommand } = require('../src/cli/commands/start');
const { stopCommand } = require('../src/cli/commands/stop');
const { scanCommand } = require('../src/cli/commands/scan');
const { sendCommand } = require('../src/cli/commands/send');
const { statusCommand } = require('../src/cli/commands/status');
const { syncCommand } = require('../src/cli/commands/sync');
const { fileCommand } = require('../src/cli/commands/file');

const VERSION = require('../package.json').version;

program
    .name('pollen')
    .description(
        '🌿 Pollen — Fully offline, peer-to-peer epidemic routing messenger.\n' +
        '   Messages spread like a virus through human movement. Zero internet.'
    )
    .version(VERSION);

program
    .command('start')
    .description('Start the Pollen background daemon')
    .action(async () => {
        await startCommand();
    });

program
    .command('stop')
    .description('Stop the Pollen background daemon')
    .action(async () => {
        await stopCommand();
    });

program
    .command('scan')
    .description('List all Pollen peers discovered on the current network')
    .action(async () => {
        await scanCommand();
    });

program
    .command('send <identity> <message>')
    .description('Send an encrypted message to a Pollen user')
    .addHelpText('after', '\nExample:\n  pollen send raj@a3f2 "bhai notes bhej"')
    .action(async (identity, message) => {
        await sendCommand(identity, message);
    });

program
    .command('status <messageId>')
    .description('Check delivery status of a message')
    .action(async (messageId) => {
        await statusCommand(messageId);
    });

program
    .command('sync')
    .description('Manually trigger epidemic sync with peers on current network')
    .action(async () => {
        await syncCommand();
    });

program
    .command('file <identity> <filepath>')
    .description('Send a file offline via epidemic routing (Phase 5)')
    .addHelpText('after', '\nExample:\n  pollen file raj@a3f2 ./notes.pdf')
    .action(async (identity, filepath) => {
        await fileCommand(identity, filepath);
    });

program.on('command:*', () => {
    console.error(`\n❌ Unknown command: ${program.args.join(' ')}\n`);
    program.help();
});

program.parse(process.argv);

// Show help if no command given
if (process.argv.length <= 2) {
    program.help();
}
