import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName } from '../src/naming.js';

describe('sanitizeName', () => {
  it('strips path separators', () => {
    assert.equal(sanitizeName('Marcus/Adam'), 'Marcus_Adam');
    assert.ok(!sanitizeName('Marcus/Adam').includes('/'));
  });

  it('strips emoji and non-ASCII to safe chars', () => {
    const out = sanitizeName('Kaí 🎮');
    assert.ok(!/\p{Extended_Pictographic}/u.test(out));
    assert.equal(out, 'Ka');
  });

  it('strips Windows-illegal characters', () => {
    const out = sanitizeName('a\\b:c*d?e"f<g>h|i');
    assert.equal(out, 'a_b_c_d_e_f_g_h_i');
  });

  it('returns unknown for empty or all-unsafe', () => {
    assert.equal(sanitizeName(''), 'unknown');
    assert.equal(sanitizeName('!!!'), 'unknown');
    assert.equal(sanitizeName('🎮🎮'), 'unknown');
  });

  it('caps length at 60', () => {
    const out = sanitizeName('a'.repeat(200));
    assert.ok(out.length <= 60);
  });

  it('prefixes Windows reserved names', () => {
    assert.equal(sanitizeName('CON'), '_CON');
    assert.equal(sanitizeName('NUL'), '_NUL');
    assert.equal(sanitizeName('aux'), '_aux');
    assert.equal(sanitizeName('COM1'), '_COM1');
  });

  it('with dedupe appends last 6 of userId', () => {
    assert.equal(
      sanitizeName('Alice', '123456789012345678', true),
      'Alice-345678',
    );
  });
});
