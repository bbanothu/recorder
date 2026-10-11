import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logEvent } from './log.js';
import { TRANSCRIBE_TMP_SUFFIX } from './transcribe.js';

/** Suffix of the transient master-mix accumulator (never a finished artifact). */
export const MIX_TMP_SUFFIX = '.mix.tmp';

export { TRANSCRIBE_TMP_SUFFIX };

const TEMP_SUFFIXES = [MIX_TMP_SUFFIX, TRANSCRIBE_TMP_SUFFIX];

/**
 * Delete stale master-mix temp files left behind by a crashed or killed
 * process. Exactly one session runs per process, so at startup no session can
 * be live: every `*.mix.tmp` under the recordings tree is residue, while a
 * finished `.ogg`/`.wav`/`.md` is never touched. The walk is bounded to the
 * given root and does not follow symlinks.
 * @param {string} root recordings root (MEETINGS_DIR)
 * @param {{ log?: (message: string) => void }} [opts]
 * @returns {number} how many temp files were removed
 */
export function sweepStaleMixTemps(root, { log = logEvent } = {}) {
  if (typeof root !== 'string' || root === '') return 0;
  let removed = 0;

  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable subtree: nothing to sweep there
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks and specials
      if (!TEMP_SUFFIXES.some((x) => entry.name.endsWith(x))) continue;
      try {
        unlinkSync(path);
        removed += 1;
        log(`removed stale temp ${path}`);
      } catch (err) {
        log(`could not remove stale temp ${path} (${err?.message ?? err})`);
      }
    }
  };

  walk(root);
  return removed;
}