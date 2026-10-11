/**
 * Thin startup wiring pulled out of src/index.js so the Task 5 ledger/dispatch
 * seams are testable without touching a real gateway (repo DI convention).
 * index.js stays glue-only: loadEnv → open DB → build store → wire these.
 */

const MIN_NODE_SQLITE = { major: 22, minor: 13 };

/**
 * Loud runtime guard for node:sqlite, run BEFORE any DB is opened and before
 * the node:sqlite import executes (index.js imports it dynamically inside its
 * startup function so this check can speak first). `node:sqlite` is unflagged
 * only from Node >= 22.13 (behind --experimental-sqlite in 22.5–22.12).
 * @returns {void} throws when the runtime cannot open a DatabaseSync
 */
export function ensureNodeSqliteSupport(nodeVersion = process.versions.node) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion);
  const ok = Boolean(m) && (Number(m[1]) > MIN_NODE_SQLITE.major ||
    (Number(m[1]) === MIN_NODE_SQLITE.major && Number(m[2]) >= MIN_NODE_SQLITE.minor));
  if (!ok) {
    throw new Error(
      `node:sqlite is not available on Node v${nodeVersion} (only behind ` +
        '--experimental-sqlite in 22.5–22.12). ' +
        'discord-meeting-recorder 2.0.0 requires Node >= 22.13 (node:sqlite, unflagged). ' +
        'Upgrade Node (or check the Docker image) and try again.',
    );
  }
}

/** Events the ledger wiring subscribes to (discord.js Events values). */
export const GUILD_EVENTS = Object.freeze({
  CREATE: 'guildCreate',
  DELETE: 'guildDelete',
});

/**
 * Guild-ledger wiring: GuildCreate upserts the ledger row and deploys this
 * guild's slash commands; GuildDelete only forgets the deploy dedupe (rows
 * are permanent by design — a returning guild shows its history).
 *
 * @param {{
 *   client: { on: (event: string, fn: Function) => unknown },
 *   configStore: { upsertGuild: (guildId: string) => void },
 *   deployGuildCommands: ((guildId: string) => unknown) & { forget: (guildId: string) => void },
 *   events?: { CREATE?: string, DELETE?: string }, // testable event names
 * }} deps
 */
export function wireGuildLedger({ client, configStore, deployGuildCommands, events = GUILD_EVENTS }) {
  client.on(events.CREATE, (guild) => {
    // A SQLite throw inside a gateway callback must not become an uncaught
    // exception — wrap everything except deploy (already self-catches).
    try {
      configStore.upsertGuild(guild.id);
      void deployGuildCommands(guild.id);
    } catch (err) {
      console.error(`[ledger] upsertGuild failed for guild ${guild.id}:`, err);
    }
  });
  client.on(events.DELETE, (guild) => {
    // Kick/leave: Discord deletes the guild's command registrations with it.
    // Forget the dedupe entry so a reinvite's GUILD_CREATE re-registers.
    // Ledger rows are permanent — no delete call by design.
    deployGuildCommands.forget(guild.id);
  });
}

/**
 * InteractionCreate dispatch: one map, one handler per registered command.
 * Kept as an exported constant so a test can pin "every commandData command
 * has a dispatch entry and routes to its dedicated controller method" — the
 * Task 3 quality-review gap (index.js still dispatching the removed
 * `singlefile` while controller methods were renamed).
 */
export const DISPATCH_HANDLERS = Object.freeze({
  record: 'record',
  stop: 'stop',
  dm: 'dm',
  transcribe: 'transcribe',
  autostop: 'autostop',
  help: 'help',
});

/**
 * Dispatch one chat-input interaction to its controller method.
 * Unknown command names answer the user loudly instead of vanishing; the hint
 * names the most recently removed command (`/record_type` in 3.0.0) but only
 * for that command — an unrelated typo must not answer with a /record_type tip.
 *
 * @param {{
 *   interaction: any,
 *   controller: Record<string, Function> | null,
 *   configStore?: unknown, // informational: the controller holds the store
 * }} deps
 */
export async function wireInteractionDispatch({ interaction, controller }) {
  if (!interaction?.isChatInputCommand?.()) return;
  if (!controller) return;
  const handler = DISPATCH_HANDLERS[interaction.commandName];
  if (!handler) {
    const known = Object.keys(DISPATCH_HANDLERS).map((c) => `/${c}`).join(', ');
    const tip = interaction.commandName === 'record_type'
      ? ' Tip: `/record_type` was removed in 3.0.0 — recording type is always both.'
      : '';
    try {
      await interaction.reply({
        content: `Unknown command: \`/${interaction.commandName}\`. This bot's commands are: ${known}.${tip}`,
      });
    } catch {
      // Best-effort notice only; never crash the handler chain on it.
    }
    return;
  }
  await controller[handler](interaction);
}

/**
 * Build the seed defaults for the SQLite config store from a loadEnv() result.
 * v3.0.0: the four-field v2 shape. There is no mode/type left to carry — every
 * session records per-user tracks AND the master mix, and the DM toggles have
 * no env var (per-guild settings, seeded TRUE = send everything).
 *
 * @param {{ TRANSCRIBE: boolean, AUTO_STOP_MINUTES: number }} env
 */
export function buildSeedDefaults(env) {
  return {
    transcribeEnabled: env.TRANSCRIBE,
    dmAudioEnabled: true,
    dmTranscribeEnabled: true,
    autostopMinutes: env.AUTO_STOP_MINUTES,
  };
}
