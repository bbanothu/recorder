import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Chrome for the notetaker. One persistent profile (NOTETAKER_BROWSER_PROFILE)
 * so a Google account signed in once with `npm run notetaker:login` is reused
 * for every meeting. The browser plays into the meeting's own PulseAudio sink
 * (PULSE_SINK), never the desktop speakers.
 */

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export const CHROME_ARGS = [
  '--deny-permission-prompts', // no mic/camera: the bot only listens
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * @param {string | null} configured NOTETAKER_CHROME_PATH
 * @param {(p: string) => boolean} [exists]
 */
export function resolveChromePath(configured, exists = existsSync) {
  if (configured) return configured;
  const found = CHROME_CANDIDATES.find((p) => exists(p));
  if (!found) throw new Error(`No Chrome/Chromium found (looked in ${CHROME_CANDIDATES.join(', ')}); set NOTETAKER_CHROME_PATH`);
  return found;
}

/**
 * Launch Chrome exactly like `notetaker:login` does (same binary, profile and
 * password store; no Playwright default flags), then attach Playwright over
 * CDP. Letting Playwright launch Chrome itself reads the profile as signed
 * out, and Meet refuses signed-out guests on personal-account meetings.
 * @param {{ profileDir: string, chromePath: string, headless: boolean, sinkName: string }} o
 * @returns {Promise<{ page: import('playwright-core').Page, close: () => Promise<void> }>}
 */
export async function openBrowser({ profileDir, chromePath, headless, sinkName }) {
  const { chromium } = await import('playwright-core');
  mkdirSync(profileDir, { recursive: true });
  const portFile = join(profileDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    ...CHROME_ARGS,
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore', env: { ...process.env, PULSE_SINK: sinkName } });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  let port = null;
  for (let i = 0; i < 300 && port == null; i++) {
    if (child.exitCode != null) throw new Error(`Chrome exited with code ${child.exitCode} (is another Chrome using ${profileDir}?)`);
    try {
      port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || null;
    } catch {
      await sleep(100);
    }
  }
  if (port == null) {
    child.kill();
    throw new Error('Chrome did not open its DevTools port within 30 s');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  return {
    page,
    close: async () => {
      await browser.close().catch(() => {});
      child.kill();
      await Promise.race([exited, sleep(10_000)]);
    },
  };
}
