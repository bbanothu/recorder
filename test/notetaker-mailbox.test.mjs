import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pollMailbox, calendarParts, describeImapError } from '../src/notetaker/mailbox.js';

test('calendarParts: finds text/calendar and .ics attachments anywhere in the tree', () => {
  const tree = {
    type: 'multipart/mixed',
    childNodes: [
      {
        type: 'multipart/alternative',
        childNodes: [
          { part: '1.1', type: 'text/plain' },
          { part: '1.2', type: 'text/html' },
          { part: '1.3', type: 'text/calendar', parameters: { method: 'REQUEST' } },
        ],
      },
      { part: '2', type: 'application/ics', dispositionParameters: { filename: 'invite.ics' } },
      { part: '3', type: 'application/octet-stream', parameters: { name: 'Meeting.ICS' } },
      { part: '4', type: 'application/pdf', dispositionParameters: { filename: 'agenda.pdf' } },
    ],
  };
  assert.deepEqual(calendarParts(tree), ['1.3', '2', '3']);
});

test('calendarParts: a single-part calendar message is body part 1', () => {
  assert.deepEqual(calendarParts({ type: 'text/calendar' }), ['1']);
  assert.deepEqual(calendarParts({ type: 'text/plain' }), []);
  assert.deepEqual(calendarParts(undefined), []);
});

function fakeClient({ uids = [], structures = {}, bodies = {}, uidValidity = 7n, failDownload = null } = {}) {
  const calls = [];
  const client = {
    mailbox: null,
    calls,
    async connect() { calls.push(['connect']); },
    async getMailboxLock(path, opts) {
      calls.push(['lock', path, opts]);
      client.mailbox = { path, uidValidity, readOnly: opts?.readOnly };
      return { release: () => calls.push(['release']) };
    },
    async search(query, opts) {
      calls.push(['search', query, opts]);
      return uids;
    },
    async *fetch(range, query, opts) {
      calls.push(['fetch', range, query, opts]);
      for (const uid of range) yield { uid, bodyStructure: structures[uid], envelope: { subject: `s${uid}` } };
    },
    async download(uid, part, opts) {
      calls.push(['download', uid, part, opts]);
      if (failDownload === uid) throw new Error('download failed');
      return { content: Readable.from([Buffer.from(bodies[`${uid}:${part}`] ?? '')]) };
    },
    async logout() { calls.push(['logout']); },
  };
  return client;
}

function memoryStore() {
  const seen = new Set();
  return {
    seen,
    isMessageProcessed: (k) => seen.has(k),
    markMessageProcessed: (k) => seen.add(k),
  };
}

test('pollMailbox: read-only INBOX, only calendar parts downloaded, messages remembered', async () => {
  const client = fakeClient({
    uids: [10, 11],
    structures: {
      10: { type: 'multipart/alternative', childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'text/calendar' }] },
      11: { type: 'text/plain' },
    },
    bodies: { '10:2': 'BEGIN:VCALENDAR...' },
  });
  const store = memoryStore();
  const got = [];
  const res = await pollMailbox({
    createClient: () => client,
    store,
    sinceMs: Date.parse('2026-09-20T00:00:00Z'),
    onCalendar: (text, meta) => got.push([text, meta]),
    log: () => {},
  });
  assert.deepEqual(got, [['BEGIN:VCALENDAR...', { uid: 10, subject: 's10' }]]);
  assert.deepEqual(res, { checked: 2, fresh: 2, calendars: 1 });
  const lock = client.calls.find((c) => c[0] === 'lock');
  assert.deepEqual(lock, ['lock', 'INBOX', { readOnly: true }]);
  const search = client.calls.find((c) => c[0] === 'search');
  assert.deepEqual(search[1], { since: new Date('2026-09-20T00:00:00Z') });
  assert.deepEqual([...store.seen].sort(), ['7:10', '7:11']);
  assert.deepEqual(client.calls.filter((c) => c[0] === 'download').map((c) => [c[1], c[2]]), [['10', '2']]);
  assert.deepEqual(client.calls.slice(-2).map((c) => c[0]), ['release', 'logout']);
});

test('pollMailbox: already-processed messages are not fetched again', async () => {
  const client = fakeClient({ uids: [10] });
  const store = memoryStore();
  store.seen.add('7:10');
  const res = await pollMailbox({ createClient: () => client, store, sinceMs: 0, onCalendar: () => {}, log: () => {} });
  assert.deepEqual(res, { checked: 1, fresh: 0, calendars: 0 });
  assert.equal(client.calls.some((c) => c[0] === 'fetch'), false);
});

test('pollMailbox: a failing message is logged, left unprocessed for retry, and others continue', async () => {
  const client = fakeClient({
    uids: [10, 11],
    structures: { 10: { type: 'text/calendar' }, 11: { type: 'text/calendar' } },
    bodies: { '11:1': 'ok' },
    failDownload: '10',
  });
  const store = memoryStore();
  const lines = [];
  const got = [];
  await pollMailbox({ createClient: () => client, store, sinceMs: 0, onCalendar: (x) => got.push(x), log: (m) => lines.push(m) });
  assert.deepEqual(got, ['ok']);
  assert.deepEqual([...store.seen], ['7:11']);
  assert.ok(lines.some((l) => /message 10.*download failed/.test(l)));
});

test('pollMailbox: logout still runs when the lock fails', async () => {
  const client = fakeClient();
  client.getMailboxLock = async () => { throw new Error('no inbox'); };
  await assert.rejects(
    pollMailbox({ createClient: () => client, store: memoryStore(), sinceMs: 0, onCalendar: () => {}, log: () => {} }),
    /no inbox/,
  );
  assert.equal(client.calls.at(-1)[0], 'logout');
});

test('describeImapError: appends the server response text imapflow hides behind "Command failed"', () => {
  const err = Object.assign(new Error('Command failed'), { responseText: 'You are yet to enable IMAP for your account.' });
  assert.equal(describeImapError(err), 'Command failed: You are yet to enable IMAP for your account.');
  assert.equal(describeImapError(new Error('connect ETIMEDOUT')), 'connect ETIMEDOUT');
  assert.equal(describeImapError('boom'), 'boom');
});
