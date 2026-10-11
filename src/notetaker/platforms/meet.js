/**
 * Google Meet page driver (spec D4). Every Meet selector lives in this file:
 * it is the expected breakage point when Google changes the UI. All
 * functions take a Playwright `Page`; nothing here records audio or decides
 * when to leave.
 */

const LEAVE_BUTTON = 'button[aria-label="Leave call"], [role="button"][aria-label="Leave call"]';
const JOIN_BUTTON = /^(join now|ask to join|join anyway)$/i;
const DISMISS_BUTTON = /^(continue without (microphone|camera|microphone and camera)|got it|dismiss|no thanks)$/i;
const REFUSED_TEXT =
  /(you can.t join this (video )?call|denied your request|no one responded to your request|you.ve been removed|returning to home screen|meeting hasn.t started|check your meeting code)/i;

/** @param {import('playwright-core').Page} page */
async function clickIfVisible(locator) {
  try {
    if (await locator.first().isVisible({ timeout: 500 })) {
      await locator.first().click({ timeout: 3000 });
      return true;
    }
  } catch {
    /* gone or covered */
  }
  return false;
}

/** @param {import('playwright-core').Page} page */
export async function isInCall(page) {
  try {
    return (await page.locator(LEAVE_BUTTON).count()) > 0;
  } catch {
    return false;
  }
}

/**
 * Open the link and get admitted: guest name (when not signed in), mic and
 * camera off, "Join now" / "Ask to join", then wait in the lobby. Throws with
 * a readable reason when Meet refuses or nobody admits the bot in time.
 * @param {import('playwright-core').Page} page
 * @param {{
 *   url: string, botName: string, admitTimeoutMs: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (m: string) => void,
 * }} p
 */
export async function join(page, { url, botName, admitTimeoutMs, now = Date.now, sleep, log = () => {} }) {
  const wait = sleep ?? ((ms) => page.waitForTimeout(ms));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Pre-join screen: find the join button, clearing permission/upsell dialogs.
  const joinBtn = page.getByRole('button', { name: JOIN_BUTTON });
  const prejoinDeadline = now() + 60_000;
  let named = false;
  while (now() < prejoinDeadline) {
    await clickIfVisible(page.getByRole('button', { name: DISMISS_BUTTON }));
    if (!named) {
      const nameInput = page.locator('input[aria-label="Your name"], input[placeholder="Your name"]');
      if (await nameInput.first().isVisible().catch(() => false)) {
        await nameInput.first().fill(botName);
        named = true;
        log(`meet: joining as guest "${botName}"`);
      }
    }
    await clickIfVisible(page.locator('[role="button"][aria-label^="Turn off microphone"]'));
    await clickIfVisible(page.locator('[role="button"][aria-label^="Turn off camera"]'));
    if (await joinBtn.first().isVisible().catch(() => false)) break;
    const body = await page.locator('body').innerText().catch(() => '');
    const refused = body.match(REFUSED_TEXT);
    if (refused) throw new Error(`Meet refused the join: "${refused[0]}"`);
    await wait(1000);
  }
  if (!(await joinBtn.first().isVisible().catch(() => false))) {
    throw new Error('no "Join now" / "Ask to join" button within 60 s (sign-in required, or the Meet UI changed)');
  }
  const label = (await joinBtn.first().innerText().catch(() => '')).trim();
  await joinBtn.first().click();
  log(`meet: clicked "${label}"${/ask/i.test(label) ? '; waiting to be admitted' : ''}`);

  const deadline = now() + admitTimeoutMs;
  while (now() < deadline) {
    if (await isInCall(page)) return;
    const body = await page.locator('body').innerText().catch(() => '');
    const refused = body.match(REFUSED_TEXT);
    if (refused) throw new Error(`Meet refused the join: "${refused[0]}"`);
    await wait(1000);
  }
  throw new Error(`not admitted within ${Math.round(admitTimeoutMs / 60_000)} min`);
}

/**
 * Participants in the call including the bot, or `null` when the page does
 * not say. Prefers the People button's badge, then the distinct tiles.
 * @param {import('playwright-core').Page} page
 */
export async function participantCount(page) {
  try {
    return await page.evaluate(() => {
      for (const b of document.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
        const label = b.getAttribute('aria-label') ?? '';
        if (!/^(people|show everyone|participants)/i.test(label)) continue;
        const fromLabel = label.match(/\((\d+)\)|(\d+)\s*(people|participants|joined)/i);
        if (fromLabel) return Number(fromLabel[1] ?? fromLabel[2]);
        const badge = (b.innerText ?? '').match(/\b(\d{1,4})\b/);
        if (badge) return Number(badge[1]);
      }
      const ids = new Set();
      for (const el of document.querySelectorAll('[data-participant-id]')) ids.add(el.getAttribute('data-participant-id'));
      return ids.size || null;
    });
  } catch {
    return null;
  }
}

/** @param {import('playwright-core').Page} page */
export async function status(page) {
  const inCall = await isInCall(page);
  return { inCall, participantCount: inCall ? await participantCount(page) : null };
}

/** Turn live captions on (the speaker timeline source). Returns whether they are on. */
export async function enableCaptions(page) {
  if (await clickIfVisible(page.locator('[aria-label^="Turn on captions"]'))) return true;
  if (await page.locator('[aria-label^="Turn off captions"]').count().catch(() => 0)) return true;
  await page.keyboard.press('c').catch(() => {});
  return (await page.locator('[aria-label^="Turn off captions"]').count().catch(() => 0)) > 0;
}

/**
 * Caption entries currently on screen: `{ id, name, text }`. Each entry DOM
 * node gets a stable id so a growing entry is recognized as the same one.
 * @param {import('playwright-core').Page} page
 */
export async function readCaptions(page) {
  try {
    return await page.evaluate(() => {
      const region = document.querySelector('[role="region"][aria-label*="aption" i]');
      if (!region) return [];
      // An entry is the largest block under the region holding exactly one avatar.
      const entries = new Set();
      for (const img of region.querySelectorAll('img')) {
        let el = img;
        while (el.parentElement && el.parentElement !== region && el.parentElement.querySelectorAll('img').length === 1) {
          el = el.parentElement;
        }
        entries.add(el);
      }
      if (!entries.size) for (const el of region.children) entries.add(el);
      const out = [];
      window.__notetakerSeq ??= 0;
      for (const el of entries) {
        const lines = (el.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        if (!el.dataset.notetakerId) el.dataset.notetakerId = String(++window.__notetakerSeq);
        out.push({ id: el.dataset.notetakerId, name: lines[0], text: lines.slice(1).join(' ') });
      }
      return out;
    });
  } catch {
    return [];
  }
}

/** Post the recording notice in the meeting chat (spec D3). Best effort. */
export async function announce(page, text) {
  const chatBtn = page.locator('[aria-label^="Chat with everyone"], [aria-label^="Open chat"]');
  await chatBtn.first().click({ timeout: 5000 });
  const box = page.locator('textarea[aria-label*="Send a message" i], textarea[placeholder*="Send a message" i]');
  await box.first().fill(text, { timeout: 5000 });
  await box.first().press('Enter');
  await page.waitForTimeout(500);
  await clickIfVisible(page.locator('[aria-label^="Close"][aria-label*="chat" i], [aria-label^="Chat with everyone"]'));
}

/** @param {import('playwright-core').Page} page */
export async function leave(page) {
  await clickIfVisible(page.locator(LEAVE_BUTTON));
}

export const meet = { join, status, enableCaptions, readCaptions, announce, leave };
