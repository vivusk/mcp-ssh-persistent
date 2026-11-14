#!/usr/bin/env node
/**
 * Store / delete the sudo password for a server user in the OS credential store
 * (Windows Credential Manager / macOS Keychain / Linux Secret Service).
 * Usage: npm run set-sudo-password -- <username>            (prompts twice, hidden)
 *        npm run set-sudo-password -- <username> --delete
 * The password is read in raw TTY mode without echo and never printed.
 */
import {
  setSudoPassword, deleteSudoPassword, credentialLocation, credentialBackend, credentialStoreName,
} from '../src/security/sudo-password-store.js';

/**
 * Prompt on the TTY without echo. Enter submits, Backspace edits, Ctrl+C aborts.
 * @param {string} label
 * @returns {Promise<string>}
 */
function promptHidden(label) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('an interactive terminal is required (stdin is not a TTY)');
  stdout.write(label);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('aborted'));
        if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const del = args.includes('--delete');
  const username = args.find((a) => !a.startsWith('--'));
  if (!username) {
    console.error('Usage: npm run set-sudo-password -- <username> [--delete]');
    process.exit(2);
  }
  const location = credentialLocation(username); // validates username
  const store = credentialStoreName();
  if (del) {
    const removed = await deleteSudoPassword(username);
    console.log(removed ? `Deleted from ${store}: ${location}` : `Nothing stored in ${store} at ${location}`);
    return;
  }
  const first = await promptHidden(`sudo password for '${username}': `);
  if (!first) throw new Error('empty password; nothing stored');
  const second = await promptHidden('repeat: ');
  if (first !== second) throw new Error('passwords do not match; nothing stored');
  await setSudoPassword(username, first);
  console.log(`Stored in ${store} as ${location} (backend: ${credentialBackend()})`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
