import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMeetingTracks } from '../speaker-attribution.js';
import { writeTranscript } from '../transcript-pipeline.js';

/**
 * Rebuild a meeting's transcript from its saved files, without re-transcribing:
 *   npm run notetaker:relabel -- <meeting dir>
 * Reads `whisper-<stamp>.json` ({ recordingStartMs, language, segments }) and
 * `captions-<stamp>.jsonl`, rewrites `transcript-<stamp>.md`.
 */
const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npm run notetaker:relabel -- <meeting dir>');
  process.exit(2);
}
const files = readdirSync(dir);
const pick = (re) => {
  const f = files.find((n) => re.test(n));
  if (!f) throw new Error(`no ${re} in ${dir}`);
  return join(dir, f);
};
const whisper = JSON.parse(readFileSync(pick(/^whisper-.*\.json$/), 'utf8'));
const captionLog = readFileSync(pick(/^captions-.*\.jsonl$/), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const tracks = buildMeetingTracks({ ...whisper, captionLog });
const { mdPath, segmentCount } = await writeTranscript({ dir, sessionStartMs: whisper.recordingStartMs, tracks });
const perSpeaker = tracks.map((t) => `${t.displayName ?? '(unknown)'}: ${t.segments.length}`).join(', ');
console.log(`${mdPath}: ${segmentCount} segments (${perSpeaker})`);
