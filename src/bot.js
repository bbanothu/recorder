import {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  joinVoiceChannel,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { Recorder } from './recorder.js';
import { logEvent } from './log.js';
import { basename } from 'node:path';
import { promises as fsp } from 'node:fs';
import { createMapConfigStore } from './db.js';
import { readTimeline, rejoinNotes } from './timeline-read.js';
import { MIN_TRACK_FRAMES } from './transcribe.js';
import { transcribeTargets, writeTranscript } from './transcript-pipeline.js';
import { SpeakingGate } from './speaking-gate.js';
import { MasterMix } from './master-mix.js';
import { AUTO_STOP_AFTER_MS, AUTO_STOP_TICK_MS, AUTO_STOP_MIN_MINUTES, AUTO_STOP_MAX_MINUTES, evaluateAutoStop, isActivityPacket } from './auto-stop.js';
import { stopAckText, STOP_FAILED_TEXT } from './stop-ack.js';
// The master-write-failure line is shared with deliver.js so the DM reply and
// the channel tail cannot drift apart (they did; Task 7b fixed it).
import { masterWriteFailedText } from './deliver.js';

export const commandData = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Start a voice recording session')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the recording session and deliver the result')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('autostop')
    .setDescription('Show or set the auto-stop threshold in minutes')
    .addIntegerOption((opt) =>
      opt
        .setName('minutes')
        .setDescription(`Threshold in minutes (${AUTO_STOP_MIN_MINUTES}-${AUTO_STOP_MAX_MINUTES}); omit to view`)
        .setMinValue(AUTO_STOP_MIN_MINUTES)
        .setMaxValue(AUTO_STOP_MAX_MINUTES)
        .setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('Show or set what /stop sends to your DMs')
    .addStringOption((opt) =>
      opt
        .setName('audio')
        .setDescription('Send audio files on /stop; omit to leave unchanged')
        .setRequired(false)
        .addChoices(
          { name: 'TRUE', value: 'TRUE' },
          { name: 'FALSE', value: 'FALSE' },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName('transcribe')
        .setDescription('Send transcript files on /stop; omit to leave unchanged')
        .setRequired(false)
        .addChoices(
          { name: 'TRUE', value: 'TRUE' },
          { name: 'FALSE', value: 'FALSE' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('transcribe')
    .setDescription('Show or set whether sessions are transcribed')
    .addStringOption((opt) =>
      opt
        .setName('enabled')
        .setDescription('Transcription on/off; omit to view')
        .setRequired(false)
        .addChoices(
          { name: 'TRUE', value: 'TRUE' },
          { name: 'FALSE', value: 'FALSE' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('List every command with a description and an example')
    .toJSON(),
];

/** Pure string builder for /help (exported for easy testing). */
export function buildHelpText() {
  return [
    '**Commands**',
    '`/record` — Start a recording session in your current voice channel. Example: `/record`',
    '`/stop` — Stop the recording session and deliver the result. Example: `/stop`',
    '`/dm` — Show or set what /stop sends to your DMs. Example: `/dm audio FALSE`',
    '`/transcribe` — Show or set whether sessions are transcribed. Example: `/transcribe TRUE`',
    '`/autostop` — Show or set the auto-stop threshold (minutes). Example: `/autostop 15`',
    '`/help` — Show this command list. Example: `/help`',
    'All replies are ephemeral (visible only to you). Settings persist per guild.',
  ].join('\n');
}

/**
 * Single-session glue for /record and /stop.
 * @param {{
 *   botUserId: string,
 *   meetingsRoot: string,
 *   configStore?: ConfigStore,   // injectable per-guild store; falls back to a Map-backed store
 *   masterBitrate?: string,
 *   joinVoice?: Function,
 *   createRecorder?: Function,
 *   createMasterMix?: Function,
 *   deliver: Function,
 *   transcribe?: Function | null, // async ({masterPath, ...opts}) => {segments, language}
 *   transcribeDM?: Function,      // async (invokerId, {content, files}) — transcript DM
 *   transcribeOpts?: object,      // {model} passed to transcribe
 *   transcribeWriteFile?: Function, // (path, data, encoding) — injectable fs
 *   readTextFile?: Function, // (path) → utf8 text — injectable fs (timeline read)
 *   transcribeEnabled?: boolean,  // deprecated 1.6.0 gate (back-compat: false → 'off')
 * }} deps
 */
export function createSessionController(deps) {
  /** @type {null | {
   *   connection: any,
   *   recorder: import('./recorder.js').Recorder,
   *   gate: import('./speaking-gate.js').SpeakingGate,
   *   master: import('./master-mix.js').MasterMix | null,
   *   invokerId: string,
   *   guildId: string,
   *   channelId: string,
   * }} */
  let session = null;

  // Per-guild config via the injectable store (Task 3: kills the cross-guild
  // leak). When omitted (tests / DB-less deployments) fall back to the shared
  // Map-backed store seeded from the legacy deps.
  const transcribeEnabledDep = deps.transcribeEnabled ?? true;
  const seedDefaults = {
    transcribeEnabled: transcribeEnabledDep,
    // v3.0.0: the DM toggles have no env var — they are per-guild settings,
    // seeded TRUE (send everything).
    dmAudioEnabled: true,
    dmTranscribeEnabled: true,
    autostopMinutes: Math.round(
      (deps.autoStopThresholdMs ?? AUTO_STOP_AFTER_MS) / 60_000,
    ),
  };
  const configStore = deps.configStore ?? createMapConfigStore(seedDefaults);

  const now = deps.now ?? (() => new Date());
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const autoStopTickMs = deps.autoStopTickMs ?? AUTO_STOP_TICK_MS;

  // Master-mix transcription (post-delivery, fire-and-forget). All defaults
  // are no-op-safe so controllers built without these deps stop unchanged.
  const transcribeSidecar = deps.transcribe ?? null; // transcribe function
  const transcribeDM = deps.transcribeDM ?? deps.dmInvoker ?? null;
  const transcribeOpts = deps.transcribeOpts ?? {};
  const transcribeWriteFile = deps.transcribeWriteFile ?? fsp.writeFile;
  const readTextFile = deps.readTextFile ?? ((p) => fsp.readFile(p, 'utf8'));

  // Injectable SpeakingGate options (tests): timer pair and/or shortened
  // confirm/silence windows. When omitted the gate uses the real
  // setTimeout/clearTimeout and its default 1 s windows.
  const gateTimers = deps.gateTimers ?? {};

  /** @returns {number | null} human count, or null when the members cache is gone */
  function humanCountIn(channel) {
    const members = channel?.members;
    if (!members || typeof members.filter !== 'function') return null;
    return members.filter((m) => !m.user?.bot).size;
  }

  // v3.0.1 Task 3(c): interactions whose /stop ack already carries a specific
  // outcome edit (see editStopAckToFailure). A WeakSet, not a Map — the entry
  // must die with the interaction object, and an expired token never needs it.
  const ackOutcomeWritten = new WeakSet();

  /**
   * v3.0.1 Task 2b: best-effort terminal edit on the `/stop` ack when the
   * background pipeline cannot finish cleanly — a non-forbidden delivery throw
   * (deliver.js rethrows those before it replies) or any throw before the
   * channel notice. index.js's command-error handler no longer sees them, so
   * this edit is the operator's terminal signal; without it the ack would say
   * "…shortly." forever.
   *
   * It must NEVER throw and NEVER produce an unhandled rejection: an expired
   * interaction token (10062) makes the edit itself fail, and the caller has
   * already logged the real failure — a stale ack is the documented limit, not
   * a crash. Auto-stop calls in with `interaction: null`, where this is a
   * no-op (there is no ephemeral ack to edit).
   */
  function editStopAckToFailure(interaction) {
    // v3.0.1 Task 3(c): deliverSession writes a MORE specific outcome to this
    // same ephemeral message for every terminal state (delivered / nobody spoke
    // / master write failed / suppressed). Once that has landed the generic line
    // below must never clobber it, even if something throws afterwards (the
    // double-edit hazard: latent today, pinned by test). WeakSet — no leak, the
    // interaction is garbage once its token expires.
    if (!interaction || ackOutcomeWritten.has(interaction)) return;
    try {
      // Promise.resolve absorbs a synchronous throw from a dead client too.
      Promise.resolve(interaction.editReply(STOP_FAILED_TEXT)).catch(() => {});
    } catch {
      /* the caller logged the real failure; never propagate */
    }
  }

  const joinVoice =
    deps.joinVoice ??
    (async ({ channel }) => {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      return connection;
    });

  const createRecorder =
    deps.createRecorder ??
    (({ connection, meetingsRoot, botUserId, guildId, startedAt, now, onPacket, writePerUserFiles }) =>
      new Recorder({
        meetingsRoot,
        botUserId,
        guildId,
        startedAt,
        now,
        onPacket,
        writePerUserFiles,
        subscribe: (userId) =>
          connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.Manual },
          }),
      }));

  function isRecording() {
    return session !== null;
  }

  /**
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   */
  function onVoiceStateUpdate(oldState, newState) {
    if (!session) return;
    if (oldState.guild.id !== session.guildId) return;
    if (oldState.id === deps.botUserId) return;

    const left =
      oldState.channelId &&
      (!newState.channelId || newState.channelId !== oldState.channelId);
    if (!left) return;
    if (oldState.channelId !== session.channelId) return;

    const label =
      oldState.member?.displayName ?? oldState.member?.user?.username ?? oldState.id;
    logEvent(`${label} left voice channel`);

    session.gate.clear(oldState.id);
    const sub = session.connection.receiver?.subscriptions?.get(oldState.id);
    if (sub) sub.destroy();
    session.recorder.removeUser(oldState.id);
  }

  async function record(interaction) {
    if (session) {
      await interaction.reply({
        content: 'Already recording. Use `/stop` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.member?.voice?.channel;
    if (!channel || channel.type === ChannelType.GuildStageVoice) {
      await interaction.reply({
        content: 'Join a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let connection;
    try {
      connection = await joinVoice({ channel, interaction });
    } catch (err) {
      console.error('voice join failed', err);
      await interaction.editReply('Failed to join voice (DAVE/network). Try again.');
      return;
    }

    /** @type {import('./speaking-gate.js').SpeakingGate | null} */
    let gate = null;
    // Session-start snapshot of the guild's config. This is NOT what the
    // stop-time gates read: manual `/stop` threads the snapshot it takes when
    // it acks them, and auto-stop reads the store at its own stop time.
    // v3.0.0: always-BOTH — every session mixes a master AND writes per-user
    // files, so the master is built unconditionally.
    const guildConfig = configStore.getConfig(interaction.guildId);
    /** @type {import('./master-mix.js').MasterMix | null} */
    const master =
      deps.createMasterMix?.() ??
      new MasterMix({
        bitrate: deps.masterBitrate,
        // DI (defect D): the controller's injected clock MUST drive the mix's
        // packet timestamps. master.t0 is a session zero taken from that clock,
        // so a mix falling back to its own Date.now() mixes two clocks and a
        // large gap then demands an unbounded Float32Array (a RangeError thrown
        // from a voice-packet callback). The controller clock returns a Date;
        // MasterMix wants ms. With no injected clock, `now` stays unset so
        // MasterMix's own `?? Date.now` default stands (index.js passes none).
        ...(typeof deps.now === 'function' ? { now: () => now().getTime() } : {}),
      });

    // Single clock read for the session zero: the recorder's startedAt Date.
    // recorder.startedAtMs (real Recorder: start() returns it) === this read's
    // getTime(), so master.t0 and the recorder stamp are one number by
    // construction.
    const startedAtDate = now();
    const sessionStartClockMs = startedAtDate.getTime();

    const recorder = createRecorder({
      connection,
      meetingsRoot: deps.meetingsRoot,
      botUserId: deps.botUserId,
      startedAt: startedAtDate,
      now,
      guildId: interaction.guildId,
      writePerUserFiles: true,
      onPacket: (userId, packet) => {
        if (session && isActivityPacket(packet)) session.lastActivityAt = now();
        gate?.onPacket(userId, packet);
        // v3.0.2 D2: the mix's decode verdict decides whether the recorder
        // keeps the packet in the per-user track (false = rejected).
        return master?.push(userId, packet);
      },
    });

    // v3.0.0 Task 6: the speech-window sidecar machinery is gone; the gate
    // keeps its construction, its speakingStart/speakingEnd wiring and its
    // onConfirmed hook (recorder.markConfirmed). Since v3.0.2 the gate is
    // informational: it drives the started/stopped log lines and the one-time
    // "recording track opened" line, and never decides whether finalize() keeps
    // a track. `onStopped` is the log line only.
    gate = new SpeakingGate({
      // Injectable gate options (tests): a fake timer pair, and/or shortened
      // confirm/silence windows for the real-timer path; an empty object falls
      // back to real setTimeout/clearTimeout and the 1 s defaults.
      ...gateTimers,
      // The gate's call signature is (userId, displayName); the id is no longer
      // used here (the speaking-log map died in Task 6) but the position stays,
      // hence the underscore.
      onStarted: (_userId, displayName) => {
        logEvent(`${displayName} started speaking`);
      },
      onStopped: (_userId, displayName) => {
        logEvent(`${displayName} stopped speaking`);
      },
      onConfirmed: (userId) => {
        recorder.markConfirmed(userId);
      },
    });

    let recorderStartInfo = { dir: null, startedAtMs: null };
    try {
      recorderStartInfo = recorder.start() ?? recorderStartInfo;
    } finally {
      // The recorderClock cannot be affected by ill-shaped start returns.
      if (!recorderStartInfo || typeof recorderStartInfo !== 'object') {
        recorderStartInfo = { dir: null, startedAtMs: null };
      }
    }
    const { dir } = recorderStartInfo;
    // Decision 7 (variant B, intended): ONE clock read shared by construction
    // — master.t0 (the exact value passed to master.start()) is the recorder's
    // own session-zero, so audio offsets have no separate-now-read drift. Per
    // recorder.js:56-58 the recorder's startedAtMs is captured from its own
    // `startedAt: now()` Date — the same clock read passed at construction —
    // so the bot re-derives it from `sessionStartClockMs` (== that read):
    // master.start() gets the recorder-reported value when it exists (it
    // always does for the real Recorder), else the constructor-read zero.
    // The fake gateway clock read above is only used when an (old-shape)
    // recorder doesn't report startedAtMs; after Decision 7 the real
    // Recorder's start() return carries it.
    const sessionStartMs =
      typeof recorderStartInfo.startedAtMs === 'number' &&
      Number.isFinite(recorderStartInfo.startedAtMs)
        ? recorderStartInfo.startedAtMs
        : sessionStartClockMs;
    master.start(sessionStartMs, dir);
    logEvent(`session started → ${dir}`);

    const displayNameFor = (userId) => {
      const member = interaction.guild?.members?.cache?.get(userId);
      return member?.displayName ?? member?.user?.username ?? userId;
    };

    connection.receiver.speaking.on('start', (userId) => {
      if (userId === deps.botUserId) return;
      const displayName = displayNameFor(userId);
      recorder.addUser({ id: userId, displayName });
      gate.speakingStart(userId, displayName);
    });

    connection.receiver.speaking.on('end', (userId) => {
      if (userId === deps.botUserId) return;
      gate.speakingEnd(userId);
    });

    session = {
      connection,
      recorder,
      gate,
      master,
      invokerId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: channel.id,
      channel,
      joinedAt: now(),
      lastActivityAt: now(),
    };

    session.autoStopTimer = setIntervalFn(() => {
      if (!session) return;
      const humans = humanCountIn(session.channel);
      if (humans === null && !session.humansWarned) {
        session.humansWarned = true;
        logEvent('auto-stop: members cache unavailable; empty-channel check skipped');
      }
      const verdict = evaluateAutoStop({
        nowMs: now().getTime(),
        joinedAtMs: session.joinedAt.getTime(),
        lastActivityAtMs: session.lastActivityAt.getTime(),
        humanCount: humans ?? Number.MAX_SAFE_INTEGER,
        // Per-guild threshold re-read EVERY tick (1.x "applies immediately"
        // behavior preserved): a mid-session /autostop changes the live timer.
        thresholdMs: configStore.getConfig(session.guildId).autostopMinutes * 60_000,
      });
      if (verdict.stop) {
        logEvent(`auto-stop triggered: ${verdict.reason}`);
        stopSession({ auto: true, reason: verdict.reason }).catch((err) =>
          console.error('auto-stop failed', err),
        );
      }
    }, autoStopTickMs);
    session.autoStopTimer?.unref?.(); // keep test/exit hygiene; gateway client keeps the loop alive in prod

    // Ephemeral typist confirmation first; the public lifecycle announcement
    // goes to the voice channel's text chat — the ephemeral reply above and
    // this edit are only the invoker's confirmation. Notice failure-isolated:
    // a missing SEND_MESSAGES permission must never abort /record.
    logEvent(`joined voice channel ${channel.name} (${channel.id})`);
    await interaction.editReply(
      `Recording in **${channel.name}**. Use \`/stop\` when done.` +
        ' Tip: /autostop, /transcribe, /dm change settings; /help lists everything.',
    );

    try {
      await deps.notifyChannel?.(
        channel.id,
        `<@${interaction.user.id}> started recording in this voice channel.`,
      );
    } catch (err) {
      logEvent(`start notice failed (${err?.message ?? err})`);
    }
  }

  async function stopSession({
    interaction = null,
    auto = false,
    reason = '',
    stopConfig: providedConfig = null,
  } = {}) {
    const current = session;
    if (!current) return null; // covers double-stop race
    session = null;
    if (current.autoStopTimer) clearIntervalFn(current.autoStopTimer);

    logEvent(auto ? `session auto-stopped (${reason})` : 'session stop requested');
    current.gate.clearAll();
    for (const [, sub] of current.connection.receiver?.subscriptions ?? []) {
      sub.destroy();
    }
    const result = current.recorder.stop();
    // master.finalize() now runs for EVERY session (v3.0.0 always-BOTH), so a
    // mix failure must never abort /stop: delivery, the channel notice, the
    // transcription gate and connection.destroy() below all still run. Same
    // log-only isolation as the delivery/notice failures in this function.
    let masterPath = null;
    // Whether the mix heard anything at all. finalize() resolves null both for
    // "no audio" and for a real write failure (186b95d: it logs and gives up),
    // and #reset() clears packetCount before returning — so this BEFORE-read is
    // the only way to tell a silent session from a failed master write.
    const masterHadAudio =
      (current.master?.packetCount ?? 0) > 0 || Boolean(current.master?.ioError);
    if (current.master) {
      try {
        masterPath = await current.master.finalize(result.dir);
      } catch (err) {
        logEvent(
          `master mix finalize failed (${err?.message ?? err}); continuing without the master file (files at ${result.dir ?? '(none)'})`,
        );
        masterPath = null;
      }
    }
    const files = masterPath ? [...result.files, masterPath] : result.files;
    current.connection.destroy();
    logEvent(
      `session stopped → ${files.length} file(s) in ${result.dir ?? '(none)'}`,
    );

    let delivered = true;
    let delivery;
    // Task 7: the stop-time config snapshot is read ONCE, before delivery, and
    // the same snapshot feeds both the audio DM rule and the transcript DM gate.
    // v3.0.1 Task 2b: the MANUAL stop handler reads that snapshot synchronously
    // before it replies the ack and threads it in here, so the ack and this
    // pipeline can never disagree — a `/dm audio FALSE` landing during the
    // encode used to be picked up by a LATER read here and suppress the very DM
    // the ack had promised. Auto-stop has no ack to agree with, so it keeps its
    // own read of the store at stop time (the `??` below).
    const stopConfig = providedConfig ?? configStore.getConfig(current.guildId);
    // v3.0.1: nothing awaits stopSession any more — the /stop handler replies
    // the ack first and runs this pipeline in the background (`void … .catch`),
    // so the old manual-mode `throw deliveryError` tail lost its destination.
    // What still reaches the operator on a HARD failure — a non-forbidden
    // delivery throw (deliver.js rethrows those before it replies; the `catch`
    // immediately below) or any throw before the channel notice (the background
    // `.catch` in `stop()`): the failure is logged AND the ack is edited to
    // STOP_FAILED_TEXT, so it never stays on "…shortly.". The outcome edit
    // inside deliver is the separate, forbidden-DM (50007) path; it does NOT
    // cover hard failures.
    try {
      delivery = await deps.deliver({
        interaction,
        invokerId: current.invokerId,
        dir: result.dir,
        // userFiles is an emptiness/consistency input ONLY (Task 7): the
        // per-user tracks are never a DM payload. The master mix is the sole
        // sendable audio, and `reason` is passed for back-compat (deliver
        // ignores it) so the auto-stop assertions stay put.
        userFiles: result.userFiles ?? [],
        masterFile: masterPath,
        // Review fix (Task 7b): hand deliver the BEFORE-finalize read so its
        // nothing-captured rule can tell a failed master write from real
        // silence — otherwise it answers "Nobody spoke" while the tail above
        // says "the master mix could not be written" for the same session.
        masterHadAudio,
        auto,
        reason,
        sendAudio: stopConfig.dmAudioEnabled,
        notify: (msg) => logEvent(msg),
        dmInvoker: deps.dmInvoker,
      });
      // v3.0.1 Task 3(c): deliver returned, so it has written the outcome to
      // the ack (or best-effort tried). Mark it so the generic failure line can
      // no longer replace a specific outcome if a later step throws.
      if (interaction) ackOutcomeWritten.add(interaction);
    } catch (err) {
      delivered = false;
      logEvent(
        `delivery failed (${err?.message ?? err}); files at ${result.dir ?? '(none)'}`,
      );
      // v3.0.1 Task 2b: a non-forbidden delivery throw lands HERE (deliver
      // rethrows it before any reply), so this is a HARD failure — the ack must
      // not stay on "…shortly." while only the console knows. The channel notice
      // below still carries the truthful tail; auto-stop (no interaction) is a
      // no-op inside.
      editStopAckToFailure(interaction);
    }
    // Lifecycle announcements go to the voice channel's text chat — manual
    // and auto stops alike. Failure-isolated: a dead notice never breaks the
    // DM delivery that already happened above.
    const headline = auto ? `Recording auto-stopped: ${reason}.` : 'Recording stopped.';
    let tail;
    if (!files.length) {
      // An empty combined list is EITHER a silent session or a master write
      // that failed after hearing audio — finalize() nulls out both the same
      // way, so the BEFORE-read above decides which line is true (Task 7).
      tail = masterHadAudio
        ? masterWriteFailedText(result.dir)
        : 'No audio was captured — nobody spoke.';
    } else if (delivery?.suppressed) {
      tail = 'Files kept on disk (audio DMs are off).';
    } else if (delivery?.delivered === false || !delivered) {
      tail = 'Delivery failed — check the console output or the recordings folder.';
    } else {
      tail = 'Result sent to your DMs.';
    }
    const notice = `<@${current.invokerId}> ${headline} ${tail}`;
    try {
      await deps.notifyChannel?.(current.channelId, notice);
    } catch (err) {
      logEvent(
        `channel notice failed (${err?.message ?? err}); files at ${result.dir ?? '(none)'}`,
      );
    }
    // Transcription kicks off AFTER the audio path is fully done,
    // fire-and-forget: a long sidecar run must never hold up /stop or a second
    // /record, and any failure is log-only (audio already delivered).
    // v3.0.0 (Task 4): the gate is the per-user route ONLY — the master .md
    // route and every `mode` branch are gone.
    // v3.0.1: the transcription gate reads the SAME stop-time snapshot as the
    // delivery gates above (Task 2b threads it in) — it is NOT re-read from the
    // store here. A `/transcribe` or `/dm` change landing DURING the encode no
    // longer affects this session; a change made before `/stop` still does,
    // because the snapshot is taken synchronously when the ack goes out.
    const transcriptionOn = Boolean(stopConfig.transcribeEnabled);
    const userFiles = result.userFiles ?? [];
    /** @type {Array<{path: string, displayName: string | null, startedAtMs: number | null}>} */
    let targets = [];
    // v3.0.0: ONE transcription route — the confirmed per-user tracks. The
    // master mix is never a target, so no master-*.md is ever produced.
    if (transcriptionOn && typeof transcribeSidecar === 'function' && userFiles.length) {
      // Decision 7: near-empty tracks (<MIN_TRACK_FRAMES = ~2s of SPEECH) skip
      // the sidecar (hallucination bait). v3.0.2 D5: tracks are silence-padded,
      // so the rule counts speechFrames, not total frames — no fs.
      const kept = userFiles.filter((uf) => {
        if (uf.speechFrames < MIN_TRACK_FRAMES) {
          logEvent(
            `skipping near-empty track ${basename(uf.path)} (${uf.frames} frames, ${uf.speechFrames} speech < ${MIN_TRACK_FRAMES})`,
          );
          return false;
        }
        return true;
      });
      // Deterministic enqueue order (resolutions line): startedAtMs, ties
      // by displayName — render must not depend on Map/finalize order.
      kept.sort(
        (a, b) =>
          a.startedAtMs - b.startedAtMs ||
          String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')),
      );
      // Task 1 carry-in: same-user same-ms rejoin can put one path in
      // userFiles twice; transcribe each path once, keeping the first entry.
      const byPath = new Map();
      for (const uf of kept) {
        if (!byPath.has(uf.path)) byPath.set(uf.path, uf);
      }
      targets = [...byPath.values()];
    }
    if (targets.length) {
      const { invokerId } = current;
      void (async () => {
        try {
          const tracks = await transcribeTargets({
            targets,
            transcribe: transcribeSidecar,
            transcribeOpts,
          });
          if (!tracks.length) return; // Decision 6: all-fail is log-only, no DM
          // D6: rejoin notes come from the timeline file at the EXACT path the
          // recorder reported (never re-derived from a clock). Absent for
          // pre-3.0.2 sessions: one log line, transcript still renders.
          let notes = [];
          if (result.timelinePath) {
            try {
              notes = rejoinNotes(readTimeline(await readTextFile(result.timelinePath)));
            } catch (err) {
              logEvent(`no timeline file to read (${err?.message ?? err}); rejoin notes skipped`);
            }
          } else {
            logEvent('no timeline file reported for this session; rejoin notes skipped');
          }
          // One speaker-attributed .md beside the session dir.
          const { mdPath, segmentCount, withSpeech } = await writeTranscript({
            dir: result.dir,
            sessionStartMs: result.startedAtMs != null
              ? result.startedAtMs
              : current.joinedAt.getTime(),
            tracks,
            rejoinNotes: notes,
            writeFile: transcribeWriteFile,
          });
          // Task 7: the file write is unconditional; only the DM obeys
          // `/dm transcribe` (spec decision 4 — produce vs send are orthogonal).
          if (stopConfig.dmTranscribeEnabled) {
            await transcribeDM?.(invokerId, { content: 'Your meeting transcript:', files: [mdPath] });
            logEvent(
              `transcript delivered → ${basename(mdPath)} (${segmentCount} segments, ${tracks.length} tracks, ${withSpeech} with speech)`,
            );
          } else {
            logEvent(
              `transcript written → ${basename(mdPath)} (DM off via /dm transcribe FALSE)`,
            );
          }
        } catch (err) {
          logEvent(`transcription failed (${err?.message ?? err}); audio already delivered`);
        }
      })();
    }
    return { dir: result.dir, files };
  }

  async function stop(interaction) {
    if (!session) {
      await interaction.reply({
        content: 'Nothing recording.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // v3.0.1 (spec decision 4): the ack IS the interaction reply and it goes
    // out BEFORE any slow work — no deferReply (deferring then editing showed
    // "thinking…" through the whole ffmpeg encode, which is the defect being
    // fixed). The config snapshot is read SYNCHRONOUSLY here and THREADED into
    // stopSession (Task 2b), so this ack and the background pipeline provably
    // share one snapshot: a `/dm` landing during the encode cannot make the
    // pipeline contradict what the operator was just promised.
    const stopConfig = configStore.getConfig(session.guildId);
    await interaction.reply({
      content: stopAckText({
        dmAudioEnabled: stopConfig.dmAudioEnabled,
        transcribeEnabled: stopConfig.transcribeEnabled,
        dmTranscribeEnabled: stopConfig.dmTranscribeEnabled,
      }),
      flags: MessageFlags.Ephemeral,
    });
    // …then the pipeline (teardown → finalize → delivery → channel notice →
    // transcription kickoff) continues in the background. Nothing awaits it, so
    // a rejection must be caught HERE — an unhandled rejection would take the
    // process down. The catch is the operator's terminal signal for a HARD
    // failure: deliver.js rethrows non-forbidden errors before it replies, and
    // any throw before the channel notice leaves no notice either, so the ack
    // message (still on "…shortly.") is edited to STOP_FAILED_TEXT — the same
    // visibility index.js's command-error handler used to give. The edit is
    // best-effort and CANNOT become a rejection source: an expired token (10062)
    // or any edit failure is swallowed, and the worst case is a stale ack —
    // never a crash, never an unhandled rejection.
    void stopSession({ interaction, stopConfig }).catch((err) => {
      logEvent(`stop pipeline failed (${err?.message ?? err})`);
      // The pipeline died before it could report anything (e.g. recorder.stop()
      // threw, or a throw after delivery but before the channel notice): the
      // ack is the only operator-facing sink left, so edit it to the terminal
      // line. Guarded — an expired token leaves the ack stale, never a crash.
      editStopAckToFailure(interaction);
    });
  }

  async function autostop(interaction) {
    const minutes = interaction.options.getInteger('minutes');
    const guildId = interaction.guildId;
    if (minutes == null) {
      const cfg = configStore.getConfig(guildId);
      const cur = cfg.autostopMinutes;
      await interaction.reply({
        content:
          `Auto-stop threshold is currently ${cur} min ` +
          `(≥ ${cur} min in channel, then ${cur} min of silence or an emptied channel; ` +
          'muted/comfort-noise traffic does not count as activity). ' +
          `Change with \`/autostop minutes:10\` (1-${AUTO_STOP_MAX_MINUTES}). Stored per guild; persists across restarts.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!Number.isInteger(minutes) || minutes < AUTO_STOP_MIN_MINUTES || minutes > AUTO_STOP_MAX_MINUTES) {
      await interaction.reply({
        content: `Minutes must be an integer ${AUTO_STOP_MIN_MINUTES}-${AUTO_STOP_MAX_MINUTES}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Per-guild write through the store (Task 3): other guilds are untouched.
    configStore.saveConfig(guildId, { autostopMinutes: minutes });
    logEvent(`auto-stop threshold set to ${minutes} min by ${interaction.user?.username ?? interaction.user?.id ?? 'unknown'}`);
    await interaction.reply({
      content: `Auto-stop threshold set to **${minutes} min** (applies immediately, including the current session; stored per guild — persists across restarts).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * v3.0.0 /dm: per-guild delivery settings. Two optional TRUE|FALSE options;
   * a PARTIAL patch (only the options actually supplied are written) and a bare
   * invocation views both toggles without writing anything.
   */
  async function dm(interaction) {
    const guildId = interaction.guildId;
    const audio = interaction.options.getString('audio');
    const transcript = interaction.options.getString('transcribe');
    /** One-line rendering of a guild's effective DM settings. */
    const dmState = (cfg) =>
      `audio: **${cfg.dmAudioEnabled ? 'TRUE' : 'FALSE'}**, transcript: **${cfg.dmTranscribeEnabled ? 'TRUE' : 'FALSE'}**`;
    const current = configStore.getConfig(guildId);
    if (audio === null && transcript === null) {
      await interaction.reply({
        content:
          `DM settings — ${dmState(current)}. ` +
          '`/dm audio FALSE` stops audio DMs, `/dm transcribe FALSE` stops transcript DMs (files stay on disk). ' +
          'Stored per guild; persists across restarts.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const patch = {};
    for (const [label, name, value] of [
      ['Audio', 'dmAudioEnabled', audio],
      ['Transcribe', 'dmTranscribeEnabled', transcript],
    ]) {
      if (value === null) continue; // omitted → leave unchanged
      if (value !== 'TRUE' && value !== 'FALSE') {
        await interaction.reply({
          content: `${label} must be \`TRUE\` or \`FALSE\` (or omit to view).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      patch[name] = value === 'TRUE';
    }
    configStore.saveConfig(guildId, patch);
    const next = configStore.getConfig(guildId);
    logEvent(
      `DM settings set to audio=${next.dmAudioEnabled} transcribe=${next.dmTranscribeEnabled} by ${interaction.user?.username ?? interaction.user?.id ?? 'unknown'}`,
    );
    await interaction.reply({
      content: `DM settings — ${dmState(next)}. Stored per guild; persists across restarts.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  async function transcribe(interaction) {
    const choice = interaction.options.getString('enabled');
    const guildId = interaction.guildId;
    const current = configStore.getConfig(guildId);
    if (choice === null) {
      // v3.0.0 (Task 4): the store no longer carries a transcription mode, so
      // the bare view reports the plain produce toggle (never "mode: undefined").
      const on = Boolean(current.transcribeEnabled);
      await interaction.reply({
        content:
          `Transcription is currently **${on ? 'enabled' : 'disabled'}**. ` +
          'Set with `/transcribe TRUE` or `/transcribe FALSE`. ' +
          'Stored per guild; persists across restarts.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (choice !== 'TRUE' && choice !== 'FALSE') {
      await interaction.reply({
        content: 'Enabled must be `TRUE` or `FALSE` (or omit to view).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const enabled = choice === 'TRUE';
    configStore.saveConfig(guildId, { transcribeEnabled: enabled });
    logEvent(`transcription set to ${choice} by ${interaction.user?.username ?? interaction.user?.id ?? 'unknown'}`);
    // Note: a mid-session /transcribe affects the in-flight session only when
    // it lands BEFORE `/stop` — the stop-time gates use the snapshot `/stop`
    // takes as it acknowledges, so a change during the encode is next session's.
    await interaction.reply({
      content:
        `Transcription **${enabled ? 'enabled' : 'disabled'}**. ` +
        'Stored per guild; persists across restarts.',
      flags: MessageFlags.Ephemeral,
    });
  }

  async function help(interaction) {
    await interaction.reply({
      content: buildHelpText(),
      flags: MessageFlags.Ephemeral,
    });
  }

  return { record, stop, autostop, dm, transcribe, help, isRecording, onVoiceStateUpdate, commandData, debugSession: () => session };
}

/** Register guild-scoped slash commands. */
export async function registerCommands(rest, clientId, guildId) {
  const { Routes } = await import('discord.js');
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commandData,
  });
}

/**
 * Per-guild slash-command registration with dedupe + failure isolation.
 * GuildCreate fires for every guild in a burst right after READY, so the
 * startup GUILD_IDS loop and the live listener would otherwise double-PUT.
 * A failure never throws and is NOT remembered, so a later event can retry.
 * Concurrent calls for the same guild share one in-flight attempt.
 */
export function createCommandDeployer({ rest, getClientId, onLog = (msg) => console.log(msg) }) {
  const registered = new Set();
  const inflight = new Map();
  const epoch = new Map(); // guildId -> generation; bumped by forget() to void in-flight successes
  async function deploy(guildId) {
    if (registered.has(guildId)) return true;
    if (inflight.has(guildId)) return inflight.get(guildId);
    const clientId = getClientId();
    if (!clientId) return false; // pre-ready events: skip quietly, GuildCreate will follow ready
    const gen = epoch.get(guildId) ?? 0;
    const work = (async () => {
      try {
        await registerCommands(rest, clientId, guildId);
        // A forget() during the await means the guild left and may rejoin:
        // its commands were deleted with it, so do NOT mark it registered.
        if ((epoch.get(guildId) ?? 0) === gen) registered.add(guildId);
        onLog(`Registered slash commands for guild ${guildId}`);
        return true;
      } catch (err) {
        onLog(
          `slash command registration FAILED for guild ${guildId}: ${err?.message ?? err}\n` +
            'Check the bot is invited to this guild with scopes bot + applications.commands and has Send Messages. ' +
            'Existing registered commands still work; a later GUILD_CREATE or restart re-attempts.',
        );
        return false;
      } finally {
        inflight.delete(guildId);
      }
    })();
    inflight.set(guildId, work);
    return work;
  }
  deploy.forget = function forget(guildId) {
    registered.delete(guildId);
    epoch.set(guildId, (epoch.get(guildId) ?? 0) + 1);
    inflight.delete(guildId); // late settle re-checks epoch and won't re-register
  };
  return deploy;
}
