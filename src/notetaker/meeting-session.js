import { join } from 'node:path';
import { fileTimestamp } from '../session.js';
import { logEvent } from '../log.js';
import { evaluateLeave, nextAloneSince } from './leave.js';
import { sinkNameFor } from './audio-capture.js';
import { buildMeetingTracks } from '../speaker-attribution.js';

export const ANNOUNCEMENT = 'This meeting is being recorded and transcribed.';
const POLL_MS = 1000;

/**
 * One meeting, end to end (spec D4/D5): own audio sink → browser → join →
 * record the sink → watch captions until the leave rule fires → clean up →
 * Whisper transcript with caption-based speakers (captions alone if Whisper
 * is unavailable). Never throws; every I/O edge is injected.
 * @param {{ uid: string, platform: string | null, joinUrl: string, summary?: string | null, endsAtMs: number | null }} meeting
 * @param {{
 *   meetingsDir: string, botName: string, admitTimeoutMs: number,
 *   platforms: Record<string, any>,
 *   openBrowser: (o: { sinkName: string }) => Promise<{ page: any, close: () => Promise<unknown> }>,
 *   createSink: (name: string) => Promise<{ name: string, monitor: string, remove: () => Promise<unknown> }>,
 *   startCapture: (o: { source: string, oggPath: string, onError: (m: string) => void }) => { stop: () => Promise<unknown> },
 *   transcribe: ((o: object) => Promise<{ segments?: any[], language?: string | null }>) | null,
 *   transcribeOpts?: object,
 *   writeTranscript: (o: object) => Promise<{ mdPath: string }>,
 *   mkdir: (path: string, o: object) => Promise<unknown>,
 *   appendFile: (path: string, data: string) => Promise<unknown>,
 *   now?: () => number, sleep: (ms: number) => Promise<void>,
 *   onRecording?: () => void, log?: (m: string) => void, pollMs?: number,
 * }} deps
 * @returns {Promise<{ outcome: 'done' | 'failed', reason: string, dir?: string, oggPath?: string, mdPath?: string, leftAtMs?: number }>}
 */
export async function runMeetingSession(meeting, deps) {
  const { now = Date.now, sleep, log = logEvent, pollMs = POLL_MS } = deps;
  const what = `"${meeting.summary || '(no title)'}"`;
  const platform = deps.platforms[meeting.platform];
  if (!platform) {
    const reason = `${meeting.platform ?? 'this platform'} is not supported yet`;
    log(`meeting ${what}: ${reason}`);
    return { outcome: 'failed', reason };
  }

  const stamp = fileTimestamp(new Date(now()));
  const dir = join(deps.meetingsDir, 'notetaker-meetings', `meeting-${stamp}`);
  const oggPath = join(dir, `mix-${stamp}.ogg`);
  const captionsPath = join(dir, `captions-${stamp}.jsonl`);
  const whisperPath = join(dir, `whisper-${stamp}.json`);

  let sink = null;
  let browser = null;
  let capture = null;
  let recordingStartMs = null;
  let reason = '';
  let joined = false;
  const captions = new Map(); // id → { id, name, text, firstMs, lastMs }
  const captionLog = []; // every change, in order (speaker evidence)

  try {
    await deps.mkdir(dir, { recursive: true });
    sink = await deps.createSink(sinkNameFor(`${stamp}`));
    browser = await deps.openBrowser({ sinkName: sink.name });
    const { page } = browser;
    log(`meeting ${what}: joining ${meeting.joinUrl}`);
    await platform.join(page, {
      url: meeting.joinUrl, botName: deps.botName, admitTimeoutMs: deps.admitTimeoutMs, now, log,
    });
    joined = true;

    capture = deps.startCapture({ source: sink.monitor, oggPath, onError: (m) => log(`meeting ${what}: ${m}`) });
    recordingStartMs = now();
    deps.onRecording?.();
    log(`meeting ${what}: in the call, recording → ${oggPath}`);
    try {
      await platform.announce(page, ANNOUNCEMENT);
    } catch (err) {
      log(`meeting ${what}: could not post the recording notice in chat (${err?.message ?? err})`);
    }
    if (!(await platform.enableCaptions(page).catch(() => false))) {
      log(`meeting ${what}: captions could not be turned on; the transcript will have no speaker names`);
    }

    let aloneSinceMs = null;
    for (;;) {
      await sleep(pollMs);
      const t = now();
      const st = await platform.status(page).catch(() => ({ inCall: false, participantCount: null }));
      for (const c of await platform.readCaptions(page).catch(() => [])) {
        const prev = captions.get(c.id);
        if (prev && prev.text === c.text && prev.name === c.name) continue;
        captions.set(c.id, { ...c, firstMs: prev?.firstMs ?? t, lastMs: t });
        captionLog.push({ t, id: c.id, name: c.name, text: c.text });
        await deps.appendFile(captionsPath, `${JSON.stringify({ t, id: c.id, name: c.name, text: c.text })}\n`).catch(() => {});
      }
      aloneSinceMs = nextAloneSince(aloneSinceMs, st.participantCount, t);
      const d = evaluateLeave({ nowMs: t, joinedAtMs: recordingStartMs, endsAtMs: meeting.endsAtMs, inCall: st.inCall, aloneSinceMs });
      if (d.leave) {
        reason = d.reason;
        break;
      }
    }
  } catch (err) {
    reason = err?.message ?? String(err);
  }

  const leftAtMs = now();
  if (browser) {
    await platform.leave(browser.page).catch(() => {});
  }
  if (capture) await capture.stop().catch(() => {});
  if (browser) await browser.close().catch((err) => log(`meeting ${what}: browser close failed (${err?.message ?? err})`));
  if (sink) await sink.remove().catch((err) => log(`meeting ${what}: audio sink cleanup failed (${err?.message ?? err})`));

  if (!joined) {
    log(`meeting ${what}: could not join (${reason})`);
    return { outcome: 'failed', reason, dir };
  }
  log(`meeting ${what}: left — ${reason}`);

  let segments = null;
  let language = null;
  if (deps.transcribe) {
    try {
      const res = await deps.transcribe({ ...(deps.transcribeOpts ?? {}), masterPath: oggPath });
      segments = res?.segments ?? [];
      language = res?.language ?? null;
      log(`meeting ${what}: Whisper produced ${segments.length} segment(s); ${captions.size} caption entr${captions.size === 1 ? 'y' : 'ies'} for speakers`);
      // Raw output beside the audio: `notetaker:relabel` can redo speakers without re-transcribing.
      await deps.appendFile(whisperPath, JSON.stringify({ recordingStartMs, language, segments })).catch(() => {});
    } catch (err) {
      log(`meeting ${what}: Whisper failed (${err?.message ?? err}); using the captions as the transcript`);
    }
  }
  const tracks = buildMeetingTracks({ segments, language, captionLog, recordingStartMs });
  try {
    const { mdPath } = await deps.writeTranscript({ dir, sessionStartMs: recordingStartMs, tracks });
    log(`meeting ${what}: transcript written → ${mdPath}`);
    return { outcome: 'done', reason, dir, oggPath, mdPath, leftAtMs };
  } catch (err) {
    log(`meeting ${what}: transcript write failed (${err?.message ?? err}); audio kept at ${oggPath}`);
    return { outcome: 'done', reason, dir, oggPath, leftAtMs };
  }
}
