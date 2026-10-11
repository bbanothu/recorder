import { execFile as nodeExecFile } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

/** ffmpeg concat-demuxer list: one `file '<path>'` line per input. */
export function buildConcatList(paths) {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`).join('');
}

/** Same-codec chunks join without re-encoding. */
export function buildConcatArgs(listPath, outPath) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath];
}

/**
 * Join chunk files into one clip file.
 * @param {string[]} inputs
 * @param {string} outPath
 */
export async function concatAudio(inputs, outPath, { execFile = promisify(nodeExecFile) } = {}) {
  const listPath = `${outPath}.list.txt`;
  await writeFile(listPath, buildConcatList(inputs));
  try {
    await execFile('ffmpeg', buildConcatArgs(listPath, outPath));
  } finally {
    await rm(listPath, { force: true });
  }
}
