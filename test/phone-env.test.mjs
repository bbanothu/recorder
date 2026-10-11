import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadPhoneEnv } from '../src/phone/env.js';

const base = { MEETINGS_DIR: '/data', PHONE_TOKEN: 'a'.repeat(32) };

test('loadPhoneEnv: defaults (loopback only, port 8787, 1 h window, DB beside the recordings)', () => {
  assert.deepEqual(loadPhoneEnv(base), {
    MEETINGS_DIR: '/data',
    PHONE_TOKEN: 'a'.repeat(32),
    PHONE_BIND: '127.0.0.1',
    PHONE_PORT: 8787,
    PHONE_DB_PATH: join('/data', 'phone.db'),
    PHONE_DEFAULT_WINDOW_MINUTES: 60,
    PHONE_MAX_CHUNK_MB: 50,
    WHISPER_MODEL: 'small',
    WHISPER_PYTHON: null,
  });
});

test('loadPhoneEnv: overrides', () => {
  const env = loadPhoneEnv({
    ...base,
    PHONE_BIND: '100.75.51.90',
    PHONE_PORT: '9000',
    PHONE_DB_PATH: '/x/p.db',
    PHONE_DEFAULT_WINDOW_MINUTES: '720',
    PHONE_MAX_CHUNK_MB: '10',
    WHISPER_MODEL: 'base',
    WHISPER_PYTHON: '/venv/bin/python',
  });
  assert.equal(env.PHONE_BIND, '100.75.51.90');
  assert.equal(env.PHONE_PORT, 9000);
  assert.equal(env.PHONE_DB_PATH, '/x/p.db');
  assert.equal(env.PHONE_DEFAULT_WINDOW_MINUTES, 720);
  assert.equal(env.PHONE_MAX_CHUNK_MB, 10);
  assert.equal(env.WHISPER_MODEL, 'base');
  assert.equal(env.WHISPER_PYTHON, '/venv/bin/python');
});

test('loadPhoneEnv: required variables are named when missing', () => {
  for (const name of Object.keys(base)) {
    assert.throws(() => loadPhoneEnv({ ...base, [name]: '' }), new RegExp(name));
  }
});

test('loadPhoneEnv: rejects bad values loudly', () => {
  const bad = {
    PHONE_TOKEN: 'short',
    PHONE_BIND: 'not an ip;',
    PHONE_PORT: '0',
    PHONE_DEFAULT_WINDOW_MINUTES: '0',
    PHONE_MAX_CHUNK_MB: '5000',
  };
  for (const [name, value] of Object.entries(bad)) {
    assert.throws(() => loadPhoneEnv({ ...base, [name]: value }), new RegExp(name), name);
  }
});
