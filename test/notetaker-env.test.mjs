import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadNotetakerEnv } from '../src/notetaker/env.js';

const base = {
  MEETINGS_DIR: '/data',
  NOTETAKER_EMAIL: 'support@spotslocal.com',
  NOTETAKER_APP_PASSWORD: 'app-pass',
  NOTETAKER_ALLOWED_ORGANIZERS: '@spotslocal.com',
};

test('loadNotetakerEnv: defaults (Zoho IMAP, bot name, DB beside the recordings)', () => {
  const env = loadNotetakerEnv(base);
  assert.deepEqual(env, {
    MEETINGS_DIR: '/data',
    NOTETAKER_EMAIL: 'support@spotslocal.com',
    NOTETAKER_APP_PASSWORD: 'app-pass',
    NOTETAKER_ALLOWED_ORGANIZERS: ['@spotslocal.com'],
    NOTETAKER_BOT_NAME: 'SpotsLocal Recorder',
    NOTETAKER_IMAP_HOST: 'imap.zoho.com',
    NOTETAKER_IMAP_PORT: 993,
    NOTETAKER_DB_PATH: join('/data', 'notetaker.db'),
    NOTETAKER_POLL_SECONDS: 60,
    NOTETAKER_LOOKBACK_DAYS: 14,
    NOTETAKER_ADMIT_TIMEOUT_MIN: 10,
    NOTETAKER_BROWSER_PROFILE: join('/data', 'notetaker-browser'),
    NOTETAKER_CHROME_PATH: null,
    NOTETAKER_HEADLESS: false,
    WHISPER_MODEL: 'small',
    WHISPER_PYTHON: null,
  });
});

test('loadNotetakerEnv: does not need the Discord variables', () => {
  assert.doesNotThrow(() => loadNotetakerEnv(base));
});

test('loadNotetakerEnv: every required variable is named when missing', () => {
  for (const name of Object.keys(base)) {
    const env = { ...base, [name]: '' };
    assert.throws(() => loadNotetakerEnv(env), new RegExp(name));
  }
});

test('loadNotetakerEnv: overrides are validated', () => {
  const env = loadNotetakerEnv({
    ...base,
    NOTETAKER_BOT_NAME: '  Notes Bot ',
    NOTETAKER_IMAP_HOST: 'imappro.zoho.com',
    NOTETAKER_IMAP_PORT: '1993',
    NOTETAKER_DB_PATH: '/x/n.db',
    NOTETAKER_POLL_SECONDS: '30',
    NOTETAKER_LOOKBACK_DAYS: '3',
    NOTETAKER_ADMIT_TIMEOUT_MIN: '20',
    NOTETAKER_BROWSER_PROFILE: '/x/profile',
    NOTETAKER_CHROME_PATH: '/usr/bin/google-chrome-stable',
    NOTETAKER_HEADLESS: 'true',
    WHISPER_MODEL: 'base',
    WHISPER_PYTHON: '/venv/bin/python',
  });
  assert.equal(env.NOTETAKER_BOT_NAME, 'Notes Bot');
  assert.equal(env.NOTETAKER_IMAP_HOST, 'imappro.zoho.com');
  assert.equal(env.NOTETAKER_IMAP_PORT, 1993);
  assert.equal(env.NOTETAKER_DB_PATH, '/x/n.db');
  assert.equal(env.NOTETAKER_POLL_SECONDS, 30);
  assert.equal(env.NOTETAKER_LOOKBACK_DAYS, 3);
  assert.equal(env.NOTETAKER_ADMIT_TIMEOUT_MIN, 20);
  assert.equal(env.NOTETAKER_BROWSER_PROFILE, '/x/profile');
  assert.equal(env.NOTETAKER_CHROME_PATH, '/usr/bin/google-chrome-stable');
  assert.equal(env.NOTETAKER_HEADLESS, true);
  assert.equal(env.WHISPER_MODEL, 'base');
  assert.equal(env.WHISPER_PYTHON, '/venv/bin/python');
});

test('loadNotetakerEnv: rejects bad values loudly', () => {
  const bad = {
    NOTETAKER_EMAIL: 'not-an-email',
    NOTETAKER_ALLOWED_ORGANIZERS: 'nope',
    NOTETAKER_BOT_NAME: 'x'.repeat(65),
    NOTETAKER_IMAP_HOST: 'bad host;rm',
    NOTETAKER_IMAP_PORT: '0',
    NOTETAKER_POLL_SECONDS: '5',
    NOTETAKER_LOOKBACK_DAYS: '400',
    NOTETAKER_ADMIT_TIMEOUT_MIN: '0',
    NOTETAKER_CHROME_PATH: 'chrome; rm -rf /',
    WHISPER_MODEL: 'bad model!',
  };
  for (const [name, value] of Object.entries(bad)) {
    assert.throws(() => loadNotetakerEnv({ ...base, [name]: value }), new RegExp(name), name);
  }
});
