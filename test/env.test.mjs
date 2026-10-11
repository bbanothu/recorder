import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv, parseAutoStopMinutes, parseWhisperModel } from '../src/env.js';

describe('loadEnv', () => {
  const keys = ['DISCORD_BOT_TOKEN', 'MEETINGS_DIR', 'GUILD_IDS', 'RECORDING_TYPE', 'SINGLE_FILE', 'MASTER_BITRATE', 'AUTO_STOP_MINUTES', 'TRANSCRIBE', 'TRANSCRIBE_MODE', 'WHISPER_MODEL', 'WHISPER_PYTHON'];
  /** @type {Record<string, string | undefined>} */
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns all required vars when present', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    const env = loadEnv();
    assert.equal(env.DISCORD_BOT_TOKEN, 'tok');
    assert.equal(env.MEETINGS_DIR, 'C:\\meetings');
    assert.deepEqual(env.GUILD_IDS, ['123']);
    assert.equal(env.AUTO_STOP_MINUTES, 5);
  });

  it('parses comma-separated GUILD_IDS with trims and empty entries dropped', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = ' 111, 222 ,,333,';
    assert.deepEqual(loadEnv().GUILD_IDS, ['111', '222', '333']);
  });

  it('throws when GUILD_IDS has no usable ids', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = ' , , ';
    assert.throws(() => loadEnv(), /GUILD_IDS/);
  });

  it('rejects SINGLE_FILE with a rename hint (any value present)', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    for (const v of ['TRUE', 'FALSE', '1', 'bogus']) {
      process.env.SINGLE_FILE = v;
      assert.throws(
        () => loadEnv(),
        /SINGLE_FILE is no longer supported\. Every session records per-user tracks and the master mix\./,
        `SINGLE_FILE=${v}`,
      );
    }
  });

  it('throws naming the missing var', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    // GUILD_IDS missing
    assert.throws(() => loadEnv(), /GUILD_IDS/);
  });

  it('throws for each missing required var', () => {
    assert.throws(() => loadEnv(), /DISCORD_BOT_TOKEN/);
    process.env.DISCORD_BOT_TOKEN = 'tok';
    assert.throws(() => loadEnv(), /MEETINGS_DIR/);
    process.env.MEETINGS_DIR = 'C:\\meetings';
    assert.throws(() => loadEnv(), /GUILD_IDS/);
  });

  it('defaults MASTER_BITRATE to 24k', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    assert.equal(loadEnv().MASTER_BITRATE, '24k');
  });

  it('passes through a valid MASTER_BITRATE', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    process.env.MASTER_BITRATE = '32k';
    process.env.AUTO_STOP_MINUTES = '10';
    assert.equal(loadEnv().MASTER_BITRATE, '32k');
    assert.equal(loadEnv().AUTO_STOP_MINUTES, 10);
  });

  it('rejects a bogus MASTER_BITRATE (ffmpeg arg safety)', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    process.env.MASTER_BITRATE = '420k; rm -rf';
    assert.throws(() => loadEnv(), /MASTER_BITRATE/);
  });

  it('TRANSCRIBE defaults to true when absent', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    assert.equal(loadEnv().TRANSCRIBE, true);
  });

  it('parses TRANSCRIBE FALSE/false/0 → false', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    for (const v of ['FALSE', 'false', '0']) {
      process.env.TRANSCRIBE = v;
      assert.equal(loadEnv().TRANSCRIBE, false, `TRANSCRIBE=${v}`);
    }
    process.env.TRANSCRIBE = 'TRUE';
    assert.equal(loadEnv().TRANSCRIBE, true);
  });

  it('WHISPER_MODEL defaults to small and passes through a custom model', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    assert.equal(loadEnv().WHISPER_MODEL, 'small');
    process.env.WHISPER_MODEL = 'base';
    assert.equal(loadEnv().WHISPER_MODEL, 'base');
  });

  it('WHISPER_PYTHON defaults to null when absent', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    assert.equal(loadEnv().WHISPER_PYTHON, null);
  });

  it('WHISPER_PYTHON passes a Windows path with backslashes and spaces verbatim', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    const py = 'C:\\Program Files\\Python\\python.exe';
    process.env.WHISPER_PYTHON = py;
    assert.equal(loadEnv().WHISPER_PYTHON, py);
  });

  it('rejects a bogus WHISPER_MODEL (shell arg safety)', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    process.env.WHISPER_MODEL = '../../evil;rm';
    assert.throws(() => loadEnv(), /Invalid WHISPER_MODEL/);
  });

  it('passes through a valid WHISPER_MODEL (plain name or HF repo id)', () => {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
    process.env.WHISPER_MODEL = 'Systran/faster-whisper-small';
    assert.equal(loadEnv().WHISPER_MODEL, 'Systran/faster-whisper-small');
    process.env.WHISPER_MODEL = 'small';
    assert.equal(loadEnv().WHISPER_MODEL, 'small');
    process.env.WHISPER_MODEL = '  base  ';
    assert.equal(loadEnv().WHISPER_MODEL, 'base');
  });
});

describe('parseWhisperModel', () => {
  it('exports a function', () => {
    assert.equal(typeof parseWhisperModel, 'function');
  });
  it('defaults to small when nullish', () => {
    assert.equal(parseWhisperModel(undefined), 'small');
    assert.equal(parseWhisperModel(null), 'small');
  });
  it('trims valid values', () => {
    assert.equal(parseWhisperModel('  base  '), 'base');
  });
  it('rejects shell metacharacters and path traversal', () => {
    assert.throws(() => parseWhisperModel('../../evil;rm'), /Invalid WHISPER_MODEL/);
    assert.throws(() => parseWhisperModel('small && whoami'), /Invalid WHISPER_MODEL/);
    assert.throws(() => parseWhisperModel('x'.repeat(121)), /Invalid WHISPER_MODEL/);
  });
});

describe('parseAutoStopMinutes', () => {
  it('undefined/blank → default 5', () => {
    assert.equal(parseAutoStopMinutes(undefined), 5);
    assert.equal(parseAutoStopMinutes(''), 5);
    assert.equal(parseAutoStopMinutes('  '), 5);
  });
  it('valid integers in range pass through', () => {
    assert.equal(parseAutoStopMinutes('1'), 1);
    assert.equal(parseAutoStopMinutes('10'), 10);
    assert.equal(parseAutoStopMinutes('180'), 180);
    assert.equal(parseAutoStopMinutes(' 42 '), 42);
  });
  it('rejects non-integers and out-of-range loudly', () => {
    assert.throws(() => parseAutoStopMinutes('0'), /AUTO_STOP_MINUTES/);
    assert.throws(() => parseAutoStopMinutes('181'), /AUTO_STOP_MINUTES/);
    assert.throws(() => parseAutoStopMinutes('-3'), /AUTO_STOP_MINUTES/);
    assert.throws(() => parseAutoStopMinutes('2.5'), /AUTO_STOP_MINUTES/);
    assert.throws(() => parseAutoStopMinutes('abc'), /AUTO_STOP_MINUTES/);
  });
});

// --- v3.0.0 Task 5: RECORDING_TYPE / TRANSCRIBE_MODE cutover guards ---
// Both variables are gone from the env surface. A value present in the
// environment is a hard startup error naming the variable; a present-but-empty
// value stays harmless (treated as unset). Guards fire before required-var
// validation so the operator sees the actionable message first.
describe('loadEnv cutover guards (v3.0.0 Task 5)', () => {
  const keys = ['DISCORD_BOT_TOKEN', 'MEETINGS_DIR', 'GUILD_IDS', 'RECORDING_TYPE', 'TRANSCRIBE_MODE', 'TRANSCRIBE'];
  /** @type {Record<string, string | undefined>} */
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = 'C:\\meetings';
    process.env.GUILD_IDS = '123';
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws a loud error naming RECORDING_TYPE when it is present', () => {
    for (const v of ['PER_USER', 'MASTER', 'BOTH']) {
      process.env.RECORDING_TYPE = v;
      assert.throws(
        () => loadEnv(),
        /RECORDING_TYPE is no longer supported/,
        `RECORDING_TYPE=${v}`,
      );
    }
  });

  it('throws a loud error naming TRANSCRIBE_MODE when it is present', () => {
    for (const v of ['combined', 'master', 'off']) {
      process.env.TRANSCRIBE_MODE = v;
      assert.throws(
        () => loadEnv(),
        /TRANSCRIBE_MODE is no longer supported/,
        `TRANSCRIBE_MODE=${v}`,
      );
    }
  });

  it('present-but-empty is treated as unset for both removed vars (no throw)', () => {
    process.env.RECORDING_TYPE = '';
    process.env.TRANSCRIBE_MODE = '   ';
    assert.doesNotThrow(() => loadEnv());
  });

  it('the loadEnv result carries neither removed key', () => {
    const env = loadEnv();
    assert.equal('RECORDING_TYPE' in env, false);
    assert.equal('TRANSCRIBE_MODE' in env, false);
  });

  it('the cutover guard fires before required-var validation', () => {
    delete process.env.DISCORD_BOT_TOKEN;
    process.env.RECORDING_TYPE = 'MASTER';
    assert.throws(() => loadEnv(), /RECORDING_TYPE is no longer supported/);
  });
});
