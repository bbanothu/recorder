import 'dotenv/config';
import pkg from '../package.json' with { type: 'json' };
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
} from 'discord.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEnv } from './env.js';
import { createSessionController, createCommandDeployer } from './bot.js';
import { sweepStaleMixTemps } from './tmp-cleanup.js';
import { createConfigStore } from './db.js';
import { deliverSession } from './deliver.js';
import { runTranscription, defaultPythonBin } from './transcribe.js';
import {
  ensureNodeSqliteSupport,
  wireGuildLedger,
  wireInteractionDispatch,
  buildSeedDefaults,
} from './wiring.js';

const env = loadEnv();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
const deployGuildCommands = createCommandDeployer({
  rest,
  getClientId: () => client.user?.id,
});

// --- SQLite startup (Task 5) -----------------------------------------------
// Loud runtime guard FIRST (spec Risks): unflagged node:sqlite only exists
// from Node >= 22.13; the module is imported dynamically below so this check
// can speak loudly before a bare builtin error surfaces.
ensureNodeSqliteSupport();

// DB_PATH's parent dir may not exist yet (e.g. a fresh MEETINGS_DIR):
// mkdir -p style, silent when it exists, loud on real failure.
try {
  mkdirSync(dirname(env.DB_PATH), { recursive: true });
} catch (err) {
  throw new Error(
    `Cannot create the directory for DB_PATH "${env.DB_PATH}": ${err?.message ?? err}`,
  );
}

// Task 3b: clear master-mix temp residue BEFORE any session can start. One
// session runs per process, so a `*.mix.tmp` under MEETINGS_DIR at startup is
// leftovers from a crash or a kill; finished artifacts are never touched.
sweepStaleMixTemps(env.MEETINGS_DIR);

/** Lazy seed defaults for guilds that haven't customized yet (read-time). */
const seedDefaults = buildSeedDefaults(env);

async function openConfigStore() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(env.DB_PATH);
  return createConfigStore(db, { seedDefaults });
}

// The store is OPENED AND READY before login(): no gateway event (GuildCreate
// included) can ever race a half-open DB. No store → the process never starts.
const configStore = await openConfigStore().catch((err) => {
  console.error(`Failed to open the SQLite config database at DB_PATH "${env.DB_PATH}": ${err?.message ?? err}`);
  process.exit(1);
});

/** @type {ReturnType<typeof createSessionController> | null} */
let controller = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} (discord-meeting-recorder v${pkg.version})`);

  controller = createSessionController({
    botUserId: c.user.id,
    meetingsRoot: env.MEETINGS_DIR,
    configStore, // Task 5: the controller shares the startup SQLite store
    masterBitrate: env.MASTER_BITRATE,
    deliver: deliverSession,
    autoStopThresholdMs: env.AUTO_STOP_MINUTES * 60_000,
    dmInvoker: (id, opts) => client.users.fetch(id).then((u) => u.send(opts)),
    notifyChannel: (channelId, text) =>
      client.channels.fetch(channelId).then((c) => c.send({ content: text })),
    transcribeOpts: { model: env.WHISPER_MODEL },
    transcribe: (() => {
      let chain = Promise.resolve();
      return (opts) => {
        const run = chain.then(() =>
          runTranscription({ pythonBin: env.WHISPER_PYTHON || defaultPythonBin(), cacheDir: process.env.HF_HOME || undefined, ...opts }),
        );
        chain = run.then(() => {}, () => {}); // queue survives failures
        return run;
      };
    })(),
  });
  console.log(
    `Recording: per-user tracks + master mix | transcription seed: ${env.TRANSCRIBE ? 'on' : 'off'} (per-guild; /transcribe changes it)`,
  );
  // Register per guild; one bad guild must never crash the others or the
  // gateway (failures are caught and logged by the deployer, e.g. 50001 =
  // bot not in guild or invite missing applications.commands scope).
  for (const guildId of env.GUILD_IDS) {
    await deployGuildCommands(guildId);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  controller?.onVoiceStateUpdate(oldState, newState);
});

// Guild ledger + per-guild command registration (Task 5 wiring, src/wiring.js).
wireGuildLedger({ client, configStore, deployGuildCommands });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!controller) return;
  try {
    await wireInteractionDispatch({ interaction, controller });
  } catch (err) {
    console.error('command error', err);
    const msg = 'Something went wrong.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(env.DISCORD_BOT_TOKEN).catch((err) => {
  console.error(
    `Discord login failed — check DISCORD_BOT_TOKEN and network access: ${err?.message ?? err}`,
  );
  process.exit(1);
});
