import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SAMPLE_RATE, MASTER_CHANNELS, MASTER_APPLICATION, DEFAULT_MASTER_BITRATE } from '../master-mix.js';

/**
 * Meeting audio capture (spec D4): the browser plays into its own PulseAudio
 * null sink (PULSE_SINK), and ffmpeg records that sink's monitor straight to
 * Ogg/Opus with the master-mix settings (mono, voip, 24k).
 */

const STOP_GRACE_MS = 10_000;

/** ffmpeg argv: PulseAudio source → mono voip Opus. */
export function buildCaptureArgs(source, oggPath, bitrate = DEFAULT_MASTER_BITRATE) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'pulse', '-i', source,
    '-c:a', 'libopus', '-b:a', bitrate,
    '-ar', String(SAMPLE_RATE), '-ac', String(MASTER_CHANNELS), '-application', MASTER_APPLICATION,
    oggPath,
  ];
}

/** Sink names reach pactl argv: keep them to [A-Za-z0-9_]. */
export function sinkNameFor(id) {
  return `notetaker_${String(id).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}`;
}

/**
 * @param {string} name from sinkNameFor
 * @param {{ execFile?: (bin: string, args: string[]) => Promise<{ stdout: string }> }} [deps]
 */
export async function createNullSink(name, { execFile = promisify(nodeExecFile) } = {}) {
  const { stdout } = await execFile('pactl', [
    'load-module', 'module-null-sink', `sink_name=${name}`, `sink_properties=device.description=${name}`,
  ]);
  const moduleId = String(stdout).trim();
  return {
    name,
    monitor: `${name}.monitor`,
    remove: () => execFile('pactl', ['unload-module', moduleId]),
  };
}

/**
 * Start recording `source` to `oggPath`. `stop()` sends ffmpeg "q" so it
 * finalizes the Ogg, and kills it if it has not exited after the grace period.
 * @param {{
 *   source: string, oggPath: string, bitrate?: string,
 *   spawn?: typeof nodeSpawn, setTimeout?: typeof globalThis.setTimeout,
 *   clearTimeout?: typeof globalThis.clearTimeout, onError?: (message: string) => void,
 * }} p
 */
export function startCapture({
  source, oggPath, bitrate, spawn = nodeSpawn,
  setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout,
  onError = () => {},
}) {
  const child = spawn('ffmpeg', buildCaptureArgs(source, oggPath, bitrate), { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-500); });
  const closed = new Promise((resolve) => {
    child.on('error', (e) => { onError(`ffmpeg: ${e?.message ?? e}`); resolve(null); });
    child.on('close', (code) => {
      if (code) onError(`ffmpeg exit ${code}: ${stderr.trim() || 'no stderr'}`);
      resolve(code);
    });
  });
  return {
    closed,
    stop() {
      try {
        child.stdin.write('q');
        child.stdin.end();
      } catch {
        /* already gone */
      }
      const timer = setT(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      return closed.finally(() => clearT(timer));
    },
  };
}
