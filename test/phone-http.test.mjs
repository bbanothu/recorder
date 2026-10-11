import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPhoneHandler } from '../src/phone/http.js';

const TOKEN = 't'.repeat(32);

/** A fake service recording calls; the HTTP layer only routes and validates. */
function fakeService() {
  const calls = [];
  return {
    calls,
    setWindow: (d, m) => {
      calls.push(['setWindow', d, m]);
      if (m === 0) throw Object.assign(new Error('Invalid windowMinutes: 0'), { status: 400 });
      return m;
    },
    receiveChunk: async (d, s, ms, body) => {
      calls.push(['chunk', d, s, ms, body.toString()]);
      return s === 1 ? 'exists' : 'created';
    },
    createClip: (d, a, b) => {
      calls.push(['clip', d, a, b]);
      return 7;
    },
    listClips: (d) => [{ id: 7, deviceId: d, state: 'ready' }],
    getClip: async (d, id) => (id === 7 ? { id: 7, state: 'ready', markdown: '# hi\n' } : null),
    deleteClip: async (d, id) => {
      calls.push(['deleteClip', d, id]);
      return id === 7;
    },
    deleteAllClips: async (d) => {
      calls.push(['deleteAllClips', d]);
      return 3;
    },
    translateClip: async (d, id) => {
      calls.push(['translateClip', d, id]);
      return id === 7 ? { translatedMarkdown: '# hi (en)\n' } : null;
    },
    redoClip: async (d, id) => {
      calls.push(['redoClip', d, id]);
      return id === 7 ? { markdown: '# redone\n', language: 'en' } : null;
    },
    updateClipMarkdown: async (d, id, markdown) => {
      calls.push(['updateClipMarkdown', d, id, markdown]);
      return id === 7;
    },
    deleteClipAudio: async (d, id) => {
      calls.push(['deleteClipAudio', d, id]);
      return id === 7;
    },
    deleteClipText: async (d, id) => {
      calls.push(['deleteClipText', d, id]);
      return id === 7;
    },
  };
}

async function withServer(fn, opts = {}) {
  const service = fakeService();
  const server = createServer(createPhoneHandler({ service, token: TOKEN, maxBytes: opts.maxBytes ?? 1024, version: '9.9.9' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { body, auth = TOKEN, type } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(type ? { 'content-type': type } : {}),
      },
      body,
    });
  try {
    await fn({ call, service });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('health needs no token; everything else does', async () => {
  await withServer(async ({ call }) => {
    const h = await call('GET', '/v1/health', { auth: null });
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true, version: '9.9.9' });
    assert.equal((await call('GET', '/v1/devices/p/clips', { auth: null })).status, 401);
    assert.equal((await call('GET', '/v1/devices/p/clips', { auth: 'wrong' })).status, 401);
    assert.equal((await call('GET', '/v1/devices/p/clips')).status, 200);
  });
});

test('PUT chunk: raw body, 201 when new, 200 when already stored', async () => {
  await withServer(async ({ call, service }) => {
    const r1 = await call('PUT', '/v1/devices/pixel/chunks/1000?durationMs=60000', { body: 'audio', type: 'audio/mp4' });
    assert.equal(r1.status, 201);
    const r2 = await call('PUT', '/v1/devices/pixel/chunks/1?durationMs=60000', { body: 'audio' });
    assert.equal(r2.status, 200);
    assert.deepEqual(service.calls[0], ['chunk', 'pixel', 1000, 60000, 'audio']);
  });
});

test('PUT chunk: too large is 413, missing durationMs is 400', async () => {
  await withServer(
    async ({ call }) => {
      assert.equal((await call('PUT', '/v1/devices/p/chunks/1000?durationMs=60000', { body: 'x'.repeat(20) })).status, 413);
      assert.equal((await call('PUT', '/v1/devices/p/chunks/1000', { body: 'x' })).status, 400);
    },
    { maxBytes: 10 },
  );
});

test('device window and clips round-trip as JSON', async () => {
  await withServer(async ({ call, service }) => {
    const w = await call('PUT', '/v1/devices/p', { body: JSON.stringify({ windowMinutes: 30 }), type: 'application/json' });
    assert.deepEqual(await w.json(), { windowMinutes: 30 });
    const bad = await call('PUT', '/v1/devices/p', { body: JSON.stringify({ windowMinutes: 0 }), type: 'application/json' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /windowMinutes/);

    const c = await call('POST', '/v1/devices/p/clips', { body: JSON.stringify({ fromMs: 1, toMs: 2 }), type: 'application/json' });
    assert.equal(c.status, 202);
    assert.deepEqual(await c.json(), { clipId: 7, state: 'pending' });
    assert.deepEqual(service.calls.at(-1), ['clip', 'p', 1, 2]);

    assert.deepEqual(await (await call('GET', '/v1/devices/p/clips')).json(), { clips: [{ id: 7, deviceId: 'p', state: 'ready' }] });
    assert.deepEqual(await (await call('GET', '/v1/devices/p/clips/7')).json(), { id: 7, state: 'ready', markdown: '# hi\n' });
    assert.equal((await call('GET', '/v1/devices/p/clips/8')).status, 404);
    assert.equal((await call('GET', '/v1/nope')).status, 404);
    assert.equal((await call('POST', '/v1/devices/p/clips', { body: '{oops', type: 'application/json' })).status, 400);
  });
});

test('DELETE clip: 200 + deleted flag when it existed, 404 when it did not; DELETE all returns the count', async () => {
  await withServer(async ({ call, service }) => {
    const one = await call('DELETE', '/v1/devices/p/clips/7');
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { deleted: true });
    assert.deepEqual(service.calls.at(-1), ['deleteClip', 'p', 7]);

    const missing = await call('DELETE', '/v1/devices/p/clips/8');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'No such clip' });

    const all = await call('DELETE', '/v1/devices/p/clips');
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { deleted: 3 });
    assert.deepEqual(service.calls.at(-1), ['deleteAllClips', 'p']);
  });
});

test('POST translate: 200 + markdown when the clip exists, 404 when it does not', async () => {
  await withServer(async ({ call, service }) => {
    const ok = await call('POST', '/v1/devices/p/clips/7/translate');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { translatedMarkdown: '# hi (en)\n' });
    assert.deepEqual(service.calls.at(-1), ['translateClip', 'p', 7]);

    const missing = await call('POST', '/v1/devices/p/clips/8/translate');
    assert.equal(missing.status, 404);
  });
});

test('POST redo: 200 + markdown when the clip exists, 404 when it does not', async () => {
  await withServer(async ({ call, service }) => {
    const ok = await call('POST', '/v1/devices/p/clips/7/redo');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { markdown: '# redone\n', language: 'en' });
    assert.deepEqual(service.calls.at(-1), ['redoClip', 'p', 7]);

    assert.equal((await call('POST', '/v1/devices/p/clips/8/redo')).status, 404);
  });
});

test('PUT transcript: revises a clip\'s markdown, 404 when it does not exist', async () => {
  await withServer(async ({ call, service }) => {
    const ok = await call('PUT', '/v1/devices/p/clips/7/transcript', {
      body: JSON.stringify({ markdown: '# edited\n' }),
      type: 'application/json',
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.deepEqual(service.calls.at(-1), ['updateClipMarkdown', 'p', 7, '# edited\n']);

    const missing = await call('PUT', '/v1/devices/p/clips/8/transcript', {
      body: JSON.stringify({ markdown: 'x' }),
      type: 'application/json',
    });
    assert.equal(missing.status, 404);
  });
});

test('DELETE audio / DELETE transcript: each its own route, 200 when the clip exists, 404 when not', async () => {
  await withServer(async ({ call, service }) => {
    const audio = await call('DELETE', '/v1/devices/p/clips/7/audio');
    assert.equal(audio.status, 200);
    assert.deepEqual(await audio.json(), { deleted: true });
    assert.deepEqual(service.calls.at(-1), ['deleteClipAudio', 'p', 7]);

    const text = await call('DELETE', '/v1/devices/p/clips/7/transcript');
    assert.equal(text.status, 200);
    assert.deepEqual(service.calls.at(-1), ['deleteClipText', 'p', 7]);

    assert.equal((await call('DELETE', '/v1/devices/p/clips/8/audio')).status, 404);
    assert.equal((await call('DELETE', '/v1/devices/p/clips/8/transcript')).status, 404);
  });
});

test('CORS: the web app gets a preflight answer and readable responses', async () => {
  await withServer(async ({ call, service }) => {
    const pre = await call('OPTIONS', '/v1/devices/p/chunks/5?durationMs=60000', { auth: null });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
    assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
    assert.equal(service.calls.length, 0);
    // Errors too, so the app can show the server's message instead of a CORS failure.
    const denied = await call('GET', '/v1/devices/p/clips', { auth: 'wrong' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('access-control-allow-origin'), '*');
  });
});
