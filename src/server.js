// HTTP API. A subset of Evolution API's routes, so apps that talk to Evolution API work unchanged:
//   POST   /message/sendText/:instance          send a text           (header: apikey)
//   GET    /instance/connectionState/:instance  'open' | 'connecting' | 'close'
//   GET    /instance/connect/:instance          QR code to link the phone (data URL)
//   DELETE /instance/logout/:instance           unlink the phone (POST works too)
//   GET    /qr/:instance                        page with the QR code (browser login: any name, password = API key)
//   GET    /health                              no key needed

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { SendQueue } from './queue.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 4096;
// A repeated X-Message-Id within this time gets the first answer and is not sent again.
const DEDUPE_MS = 15 * 60_000;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{ apiKey: string, sendGapMs: number, sendWaitMs: number }} config
 * @param {Map<string, import('./whatsapp.js').WhatsAppInstance>} instances
 * @param {import('pino').Logger} logger
 */
export function createGateway(config, instances, logger) {
  const queues = new Map([...instances.keys()].map((name) => [name, new SendQueue(config.sendGapMs)]));
  const sent = new Map(); // message id → { at, status, body }

  const routes = [
    ['GET', /^\/health$/, false, health],
    ['POST', /^\/message\/sendText\/([\w-]+)$/, true, sendText],
    ['GET', /^\/instance\/connectionState\/([\w-]+)$/, true, connectionState],
    ['GET', /^\/instance\/connect\/([\w-]+)$/, true, connect],
    ['DELETE', /^\/instance\/logout\/([\w-]+)$/, true, logout],
    ['POST', /^\/instance\/logout\/([\w-]+)$/, true, logout],
    ['GET', /^\/qr\/([\w-]+)$/, 'basic', qrPage],
  ];

  async function health() {
    return [200, { status: 'ok', instances: Object.fromEntries([...instances].map(([name, i]) => [name, i.state])) }];
  }

  async function sendText(req, name) {
    const instance = find(name);
    const body = await readJson(req);
    const number = String(body.number ?? '').replace(/[^\d]/g, '');
    const text = typeof body.text === 'string' ? body.text : '';

    if (number.length < 8 || number.length > 15) {
      throw new HttpError(400, 'invalid_number', 'Send the number with country code, e.g. 919876543210.');
    }
    if (text.trim() === '' || text.length > MAX_TEXT_LENGTH) {
      throw new HttpError(400, 'invalid_text', `Text must be 1 to ${MAX_TEXT_LENGTH} characters.`);
    }

    const messageId = req.headers['x-message-id'];
    const key = messageId ? `${name}:${messageId}` : null;
    forgetOldSends();

    if (key && sent.has(key)) {
      const first = sent.get(key);
      return [first.status, first.body];
    }

    if (instance.state !== 'open') {
      throw new HttpError(503, 'not_connected', `WhatsApp "${name}" is not connected. Open /qr/${name} and scan the code.`);
    }

    const jid = await instance.lookup(number);
    if (jid === null) {
      throw new HttpError(422, 'not_on_whatsapp', 'This number is not on WhatsApp.');
    }

    const sending = queues.get(name).push(() => instance.sendText(jid, text));
    // A send that fails after we answered "queued" must be logged, never crash the process.
    sending.catch((error) => logger.error({ err: error, instance: name }, 'Send failed'));
    // Remember it at once, so a retry while it waits in the queue isn't sent twice.
    if (key) {
      sent.set(key, { at: Date.now(), status: 202, body: { status: 'queued' } });
    }

    const result = await Promise.race([
      sending.then((id) => ({ id })),
      new Promise((resolve) => setTimeout(() => resolve(null), config.sendWaitMs)),
    ]).catch(() => {
      if (key) sent.delete(key);
      throw new HttpError(502, 'send_failed', 'WhatsApp did not take the message. Try again.');
    });

    const answer = result === null ? [202, { status: 'queued' }] : [201, { key: { id: result.id }, status: 'sent' }];
    if (key) {
      sent.set(key, { at: Date.now(), status: answer[0], body: answer[1] });
      sending.then((id) => sent.set(key, { at: Date.now(), status: 201, body: { key: { id }, status: 'sent' } })).catch(() => sent.delete(key));
    }

    return answer;
  }

  async function connectionState(_req, name) {
    return [200, { instance: { instanceName: name, state: find(name).state } }];
  }

  async function connect(_req, name) {
    const instance = find(name);
    return [200, { state: instance.state, me: instance.me, qr: instance.qr ? await QRCode.toDataURL(instance.qr) : null }];
  }

  async function logout(_req, name) {
    await find(name).logout();
    return [200, { status: 'logged_out' }];
  }

  async function qrPage(_req, name) {
    const instance = find(name);
    const image = instance.qr ? `<img src="${await QRCode.toDataURL(instance.qr, { width: 300 })}" alt="QR code">` : '';
    const text = {
      open: `Connected${instance.me ? ` as ${escapeHtml(instance.me.split(':')[0].split('@')[0])}` : ''}. Nothing to do.`,
      connecting: instance.qr ? 'On the phone: WhatsApp → Linked devices → Link a device, then scan this code.' : 'Connecting…',
      close: 'Not connected. Trying again…',
    }[instance.state];

    return [200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="5"><title>WhatsApp ${escapeHtml(name)}</title>
<body style="font-family:sans-serif;text-align:center;padding:24px"><h2>WhatsApp: ${escapeHtml(name)}</h2>
<p>${text}</p>${image}<p style="color:#888">This page refreshes every 5 seconds.</p></body>`, 'text/html; charset=utf-8'];
  }

  function find(name) {
    const instance = instances.get(name);
    if (!instance) {
      throw new HttpError(404, 'unknown_instance', `No WhatsApp instance "${name}". Instances: ${[...instances.keys()].join(', ')}.`);
    }
    return instance;
  }

  function forgetOldSends() {
    const cutoff = Date.now() - DEDUPE_MS;
    for (const [key, entry] of sent) {
      if (entry.at < cutoff) sent.delete(key);
    }
  }

  function authorized(req, kind) {
    if (kind === 'basic') {
      const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
      const password = scheme === 'Basic' ? Buffer.from(encoded ?? '', 'base64').toString().split(':').slice(1).join(':') : '';
      return same(password, config.apiKey);
    }
    return same(String(req.headers.apikey ?? ''), config.apiKey);
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(path));

    try {
      if (!route) {
        throw new HttpError(404, 'not_found', 'Not found.');
      }

      const [, pattern, auth, handler] = route;

      if (auth && !authorized(req, auth)) {
        if (auth === 'basic') {
          res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp gateway", charset="UTF-8"');
        }
        throw new HttpError(401, 'unauthorized', 'Wrong or missing API key.');
      }

      const [status, body, type] = await handler(req, ...pattern.exec(path).slice(1));
      reply(res, status, body, type);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        logger.error({ err: error, path }, 'Request failed');
      }
      const status = error instanceof HttpError ? error.status : 500;
      reply(res, status, { error: error instanceof HttpError ? error.code : 'server_error', message: error instanceof HttpError ? error.message : 'Server error.' });
    }
  });

  return server;
}

function reply(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'too_large', 'Request too large.');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'invalid_json', 'Send a JSON body.');
  }
}

/** Compares in constant time, so the key can't be guessed by timing. */
function same(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
