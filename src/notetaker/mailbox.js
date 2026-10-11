import { logEvent } from '../log.js';

/**
 * Read-only IMAP intake. The notetaker mailbox is a shared, human-read inbox
 * (support@), so the poll must never change it: INBOX is opened with EXAMINE
 * (`readOnly`), nothing is flagged, moved or deleted, and progress is tracked
 * in our own `processed_messages` table instead of the \Seen flag.
 */

const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics']);

/**
 * IMAP part ids of every calendar body in a bodyStructure tree.
 * @param {any} node imapflow bodyStructure node
 * @returns {string[]}
 */
export function calendarParts(node) {
  if (!node) return [];
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    return node.childNodes.flatMap(calendarParts);
  }
  const type = String(node.type ?? '').toLowerCase();
  const name = String(node.dispositionParameters?.filename ?? node.parameters?.name ?? '').toLowerCase();
  if (!CALENDAR_TYPES.has(type) && !name.endsWith('.ics')) return [];
  // A single-part message has no part id: its body is part 1.
  return [node.part ?? '1'];
}

/**
 * imapflow's error message is generic ("Command failed"); the server's own
 * text (e.g. Zoho's "You are yet to enable IMAP…") is what an operator can act on.
 * @param {any} err
 * @returns {string}
 */
export function describeImapError(err) {
  const message = err?.message ?? String(err);
  return err?.responseText ? `${message}: ${err.responseText}` : message;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One poll: search INBOX since `sinceMs`, download only the calendar parts of
 * messages not seen before, hand each to `onCalendar`. A failing message is
 * logged and left unprocessed so the next poll retries it.
 * @param {{
 *   createClient: () => any, // ImapFlow-like (connect/getMailboxLock/search/fetch/download/logout)
 *   store: { isMessageProcessed: (k: string) => boolean, markMessageProcessed: (k: string) => void },
 *   sinceMs: number,
 *   onCalendar: (icsText: string, meta: { uid: number, subject: string | null }) => unknown,
 *   log?: (message: string) => void,
 * }} deps
 * @returns {Promise<{ checked: number, fresh: number, calendars: number }>}
 */
export async function pollMailbox({ createClient, store, sinceMs, onCalendar, log = logEvent }) {
  const client = createClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const validity = String(client.mailbox?.uidValidity ?? '0');
      const keyOf = (uid) => `${validity}:${uid}`;
      const uids = (await client.search({ since: new Date(sinceMs) }, { uid: true })) || [];
      const fresh = uids.filter((uid) => !store.isMessageProcessed(keyOf(uid)));
      let calendars = 0;
      if (!fresh.length) return { checked: uids.length, fresh: 0, calendars };

      // Collect first: downloading inside the fetch iterator deadlocks imapflow.
      const messages = [];
      for await (const msg of client.fetch(fresh, { uid: true, bodyStructure: true, envelope: true }, { uid: true })) {
        messages.push({
          uid: msg.uid,
          parts: calendarParts(msg.bodyStructure),
          subject: msg.envelope?.subject ?? null,
        });
      }
      for (const m of messages) {
        try {
          for (const part of m.parts) {
            const { content } = await client.download(String(m.uid), part, { uid: true });
            await onCalendar(await streamToString(content), { uid: m.uid, subject: m.subject });
            calendars += 1;
          }
          store.markMessageProcessed(keyOf(m.uid));
        } catch (err) {
          log(`mailbox: message ${m.uid} failed (${err?.message ?? err}); will retry next poll`);
        }
      }
      return { checked: uids.length, fresh: fresh.length, calendars };
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* connection already gone */
    }
  }
}
