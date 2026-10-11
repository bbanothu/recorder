import { statSync } from 'node:fs';

/** Discord upload limit with margin (25 MiB attachment cap). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The history/keep-on-disk line shared by every non-delivery exit. */
function keptOnDisk(dir) {
  return `Files are at:\n\`${dir}\``;
}

/**
 * The ONE user-facing line for a master write that FAILED (never for silence),
 * shared with bot.js's stop tail so the two messages a single session shows
 * cannot drift apart — they did, and that drift is what Task 7b fixed.
 * @param {string} dir
 */
export function masterWriteFailedText(dir) {
  return `The master mix could not be written — see the log. ${keptOnDisk(dir)}`;
}

function isForbiddenDm(err) {
  return err?.code === 50007 || /Cannot send messages|Forbidden/i.test(String(err?.message ?? err));
}

/**
 * v3.0.0 delivery: the MASTER MIX is the only audio ever DM'd.
 *
 * The per-user tracks are never sent and never zipped — they stay on disk as
 * the transcription input (spec decision 7). `userFiles` is therefore only an
 * emptiness/consistency input here, never a payload — the tracks archive branch
 * and its zip builder are gone entirely. Production feeds the recorder's
 * per-track objects (`{ path, displayName, startedAtMs, frames }`) while the
 * deliver suite feeds bare path strings, and this module reads only `.length`
 * for either shape; it never dereferences an entry.
 * Manual mode: `interaction` present → replies/edits + interaction.user.send
 * (unchanged). Auto mode: no interaction → DM via dmInvoker(invokerId, payload);
 * all "reply" text goes to notify() (console log).
 * @param {{
 *   interaction?: import('discord.js').ChatInputCommandInteraction | null,
 *   invokerId?: string | null,
 *   dir: string,
 *   userFiles?: string[] | Array<{ path: string, displayName: string, startedAtMs: number | null, frames: number }>,
 *   masterFile?: string | null,
 *   masterHadAudio: boolean,
 *   auto?: boolean,
 *   sendAudio?: boolean,
 *   reason?: string,
 *   notify?: (text: string) => void,
 *   dmInvoker?: ((id: string, payload: object) => Promise<unknown>) | null,
 *   maxUploadBytes?: number,
 * }} args
 * @returns {Promise<{delivered: boolean, suppressed?: boolean}>} `delivered`
 *   true only when the master mix actually reached the invoker's DMs;
 *   `suppressed` true only for the `/dm audio FALSE` rule (never for a hard
 *   failure). In auto mode (interaction null) the fallback text still goes to
 *   notify()/console — the returned flags are unchanged.
 *
 *   `reason` is accepted but deliberately never read (caller back-compat: the
 *   bot still passes the auto-stop reason and the auto-stop tests pin that the
 *   call carries it). `masterHadAudio` is REQUIRED — no default: it is the
 *   caller's read of `MasterMix#packetCount` BEFORE `finalize()` (which resets
 *   it), and it lets the nothing-captured rule below tell a session that heard
 *   audio — but whose master write then failed — from a genuinely silent one.
 *   Without it, both look like `userFiles: []` + `masterFile: null` and this
 *   module would answer "Nobody spoke" while the bot's stop tail says "the
 *   master mix could not be written" — two contradictory messages for one
 *   session. Defaulting it to false is exactly how that bug shipped, so a
 *   caller that forgets it now gets a TypeError instead of a wrong reply.
 *   The guard checks the TYPE, not `=== undefined`: `null` or `0` would slip
 *   past an undefined-only check and reproduce that same bug silently. `dir`
 *   is equally required — it names the on-disk path in every fallback reply —
 *   and is guarded the same way.
 */
export async function deliverSession({
  interaction = null,
  invokerId = null,
  dir,
  userFiles = [],
  masterFile = null,
  masterHadAudio,
  auto = false,
  sendAudio = true,
  notify = () => {},
  dmInvoker = null,
  maxUploadBytes = MAX_UPLOAD_BYTES,
}) {
  if (typeof masterHadAudio !== 'boolean') {
    throw new TypeError(
      "deliverSession: masterHadAudio must be a boolean (the caller's MasterMix#packetCount read, taken BEFORE finalize()) — null/0 would silently reproduce the nothing-captured bug this guard exists to prevent",
    );
  }
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError(
      'deliverSession: dir is required (the session directory named in every path-reply line)',
    );
  }
  const reply = async (text) => {
    if (interaction) return interaction.editReply(text);
    notify(text);
  };
  const sendToInvoker = async (content, path) => {
    const payload = { content, files: [path] };
    if (interaction) return interaction.user.send(payload);
    return dmInvoker(invokerId, payload);
  };
  const verb = auto ? 'Auto-stopped' : 'Stopped';

  // (1) Nothing captured at all — FIRST, so `/dm audio FALSE` on a silent
  // session still reports `delivered: false`, never `suppressed`. A session
  // that DID hear audio but whose master write failed (and kept no confirmed
  // track) lands here too: `masterHadAudio` picks the truthful failure line
  // instead of the contradictory "nobody spoke" (the bot's stop tail already
  // says "the master mix could not be written").
  if (!userFiles.length && !masterFile) {
    await reply(
      masterHadAudio
        ? `${verb}. ${masterWriteFailedText(dir)}`
        : `${verb}. Nobody spoke — no files.`,
    );
    return { delivered: false };
  }

  // (2) Audio DMs off: nothing is sent, and the caller must not surface this
  // as a delivery failure.
  if (sendAudio === false) {
    await reply(
      `${verb}. Audio DMs are off (/dm audio TRUE to re-enable). ${keptOnDisk(dir)}`,
    );
    return { delivered: false, suppressed: true };
  }

  // (3)/(4) The master mix is the only candidate. Every refusal names the
  // on-disk path and never attempts a second send.
  if (!masterFile) {
    // finalize() gave up (a logged write failure): there is no master audio to
    // send at all.
    await reply(`${verb}. ${masterWriteFailedText(dir)}`);
    return { delivered: false };
  }
  if (!/\.ogg$/i.test(masterFile)) {
    // A `.wav` master means ffmpeg was unavailable; extension IS the signal
    // (a WAV blows the cap in ~2 minutes, so it is never worth sending).
    await reply(
      `${verb}. The master mix was kept as .wav (ffmpeg unavailable) and was not sent. ${keptOnDisk(dir)}`,
    );
    return { delivered: false };
  }
  if (statSync(masterFile).size > maxUploadBytes) {
    await reply(
      `${verb}. The master mix is too large for Discord and stays on disk. ${keptOnDisk(dir)}`,
    );
    return { delivered: false };
  }

  try {
    await sendToInvoker('Your meeting recording (master mix):', masterFile);
    await reply(`${verb}. Sent the master mix to your DMs.`);
    return { delivered: true };
  } catch (err) {
    if (!isForbiddenDm(err)) throw err;
    await reply(`${verb}. Could not DM the master mix. ${keptOnDisk(dir)}`);
    return { delivered: false };
  }
}
