import { createHash, timingSafeEqual } from 'node:crypto';
import { logEvent } from '../log.js';

/**
 * HTTP layer for the phone server (node:http, no framework). Routing, auth,
 * body limits and status codes only; everything else is the service.
 */

const JSON_LIMIT = 16 * 1024;
const digest = (s) => createHash('sha256').update(String(s)).digest();

// The web build of the app calls from another origin. Auth is a bearer header,
// never a cookie, so allowing any origin exposes nothing without the token.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

/** Read the body up to `limit` bytes; `null` when it was larger (the rest is drained). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) tooLarge = true;
      else chunks.push(d);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, JSON_LIMIT);
  if (body == null) throw Object.assign(new Error('JSON body too large'), { status: 413 });
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

const toInt = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : NaN);

/**
 * @param {{
 *   service: ReturnType<typeof import('./service.js').createPhoneService>,
 *   token: string, maxBytes: number, version: string, log?: (m: string) => void,
 * }} o
 */
export function createPhoneHandler({ service, token, maxBytes, version, log = logEvent }) {
  const expected = digest(`Bearer ${token}`);
  const authorized = (req) => timingSafeEqual(digest(req.headers.authorization ?? ''), expected);

  const routes = [
    ['GET', /^\/v1\/health$/, async () => [200, { ok: true, version }], { public: true }],
    ['PUT', /^\/v1\/devices\/([^/]+)$/, async (req, [deviceId]) => {
      const { windowMinutes } = await readJson(req);
      return [200, { windowMinutes: service.setWindow(deviceId, windowMinutes) }];
    }],
    ['PUT', /^\/v1\/devices\/([^/]+)\/chunks\/(\d+)$/, async (req, [deviceId, startedAt], url) => {
      const durationMs = toInt(url.searchParams.get('durationMs'));
      if (!Number.isFinite(durationMs)) {
        req.resume();
        return [400, { error: 'durationMs query parameter is required' }];
      }
      const body = await readBody(req, maxBytes);
      if (body == null) return [413, { error: `Chunk larger than ${maxBytes} bytes` }];
      const result = await service.receiveChunk(deviceId, Number(startedAt), durationMs, body);
      return [result === 'created' ? 201 : 200, { result }];
    }],
    ['POST', /^\/v1\/devices\/([^/]+)\/clips$/, async (req, [deviceId]) => {
      const { fromMs, toMs } = await readJson(req);
      return [202, { clipId: service.createClip(deviceId, fromMs, toMs), state: 'pending' }];
    }],
    ['GET', /^\/v1\/devices\/([^/]+)\/clips$/, async (req, [deviceId]) => [200, { clips: await service.listClips(deviceId) }]],
    ['GET', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)$/, async (req, [deviceId, id]) => {
      const clip = await service.getClip(deviceId, Number(id));
      return clip ? [200, clip] : [404, { error: 'No such clip' }];
    }],
    ['POST', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)\/translate$/, async (req, [deviceId, id]) => {
      req.resume();
      const result = await service.translateClip(deviceId, Number(id));
      return result ? [200, result] : [404, { error: 'No such clip' }];
    }],
    ['POST', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)\/redo$/, async (req, [deviceId, id]) => {
      req.resume();
      const result = await service.redoClip(deviceId, Number(id));
      return result ? [200, result] : [404, { error: 'No such clip' }];
    }],
    ['PUT', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)\/transcript$/, async (req, [deviceId, id]) => {
      const { markdown } = await readJson(req);
      const ok = await service.updateClipMarkdown(deviceId, Number(id), markdown);
      return ok ? [200, { ok: true }] : [404, { error: 'No such clip' }];
    }],
    ['DELETE', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)\/audio$/, async (req, [deviceId, id]) => {
      req.resume();
      const ok = await service.deleteClipAudio(deviceId, Number(id));
      return ok ? [200, { deleted: true }] : [404, { error: 'No such clip' }];
    }],
    ['DELETE', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)\/transcript$/, async (req, [deviceId, id]) => {
      req.resume();
      const ok = await service.deleteClipText(deviceId, Number(id));
      return ok ? [200, { deleted: true }] : [404, { error: 'No such clip' }];
    }],
    ['DELETE', /^\/v1\/devices\/([^/]+)\/clips\/(\d+)$/, async (req, [deviceId, id]) => {
      req.resume();
      const deleted = await service.deleteClip(deviceId, Number(id));
      return deleted ? [200, { deleted: true }] : [404, { error: 'No such clip' }];
    }],
    ['DELETE', /^\/v1\/devices\/([^/]+)\/clips$/, async (req, [deviceId]) => {
      req.resume();
      return [200, { deleted: await service.deleteAllClips(deviceId) }];
    }],
  ];

  return async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        req.resume();
        res.writeHead(204, CORS);
        return res.end();
      }
      const url = new URL(req.url, 'http://phone.local');
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) {
        req.resume();
        return send(res, 404, { error: 'Not found' });
      }
      const [, re, handler, opts] = route;
      if (!opts?.public && !authorized(req)) {
        req.resume();
        return send(res, 401, { error: 'Missing or wrong bearer token' });
      }
      const params = re.exec(url.pathname).slice(1).map(decodeURIComponent);
      const [status, body] = await handler(req, params, url);
      send(res, status, body);
    } catch (err) {
      const status = err?.status ?? 500;
      if (status >= 500) log(`phone: ${req.method} ${req.url} failed (${err?.stack ?? err})`);
      send(res, status, { error: status >= 500 ? 'Internal error' : err.message });
    }
  };
}
