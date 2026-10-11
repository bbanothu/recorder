import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { loadNotetakerEnv } from './env.js';
import { resolveChromePath } from './browser.js';

/**
 * One-time Google sign-in for the notetaker's browser profile. Plain Chrome
 * (no automation), because Google refuses sign-in from automated browsers.
 * Meetings organized by personal Google accounts usually do not admit
 * signed-out guests, so sign in as the invited address (NOTETAKER_EMAIL).
 */
const env = loadNotetakerEnv();
const chromePath = resolveChromePath(env.NOTETAKER_CHROME_PATH);
mkdirSync(env.NOTETAKER_BROWSER_PROFILE, { recursive: true });
console.log(`Opening Chrome with profile ${env.NOTETAKER_BROWSER_PROFILE}`);
console.log(`Sign in as ${env.NOTETAKER_EMAIL}, then close the Chrome window.`);
const child = spawn(
  chromePath,
  [`--user-data-dir=${env.NOTETAKER_BROWSER_PROFILE}`, '--no-first-run', '--no-default-browser-check', 'https://accounts.google.com/'],
  { stdio: 'ignore' },
);
child.on('close', () => console.log('Chrome closed; the profile is saved.'));
