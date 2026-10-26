// The HTTP API with a fake WhatsApp connection: no real message is ever sent.

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createGateway } from '../src/server.js';

const API_KEY = 'k'.repeat(40);

class FakeInstance {
  state = 'open';
  qr = null;
  me = '919000000000:1@s.whatsapp.net';
  sent = [];
  failNext = false;

  async lookup(number) {
    return number === '910000000000' ? null : `${number}@s.whatsapp.net`;
  }

  async sendText(jid, text) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('socket closed');
    }
    this.sent.push({ jid, text, at: Date.now() });
    return `MSG${this.sent.length}`;
  }

  async logout() {
    this.state = 'connecting';
    this.qr = 'QR-TEXT';
  }
}

let server;
let base;
let wa;

function call(path, { method = 'GET', body, key = API_KEY, headers = {} } = {}) {
  return fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { apikey: key } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('gateway', () => {
  before(async () => {
    wa = new FakeInstance();
    server = createGateway({ apiKey: API_KEY, sendGapMs: 50, sendWaitMs: 2000 }, new Map([['automobiles', wa]]), pino({ level: 'silent' }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  beforeEach(() => {
    wa.state = 'open';
    wa.qr = null;
    wa.sent = [];
  });

  test('health needs no key and shows each instance', async () => {
    const res = await call('/health', { key: null });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', instances: { automobiles: 'open' } });
  });

  test('refuses a wrong or missing key', async () => {
    assert.equal((await call('/instance/connectionState/automobiles', { key: null })).status, 401);
    const res = await call('/instance/connectionState/automobiles', { key: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  });

  test('sends a text the way Evolution API takes it', async () => {
    const res = await call('/message/sendText/automobiles', { method: 'POST', body: { number: '+91 98765 43210', text: 'Your code is 482913.' } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { key: { id: 'MSG1' }, status: 'sent' });
    assert.deepEqual(wa.sent.map(({ jid, text }) => ({ jid, text })), [{ jid: '919876543210@s.whatsapp.net', text: 'Your code is 482913.' }]);
  });

  test('checks the number and the text', async () => {
    for (const [body, error] of [
      [{ number: '12', text: 'hi' }, 'invalid_number'],
      [{ number: '919876543210', text: '  ' }, 'invalid_text'],
      [{ number: '919876543210', text: 'x'.repeat(4097) }, 'invalid_text'],
    ]) {
      const res = await call('/message/sendText/automobiles', { method: 'POST', body });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, error);
    }
  });

  test('says when the number is not on WhatsApp', async () => {
    const res = await call('/message/sendText/automobiles', { method: 'POST', body: { number: '910000000000', text: 'hi' } });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'not_on_whatsapp', message: 'This number is not on WhatsApp.' });
  });

  test('says when the phone is not linked', async () => {
    wa.state = 'close';
    const res = await call('/message/sendText/automobiles', { method: 'POST', body: { number: '919876543210', text: 'hi' } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'not_connected');
  });

  test('a send failure answers 502 and the next message still goes', async () => {
    wa.failNext = true;
    const failed = await call('/message/sendText/automobiles', { method: 'POST', body: { number: '919876543210', text: 'one' } });
    assert.equal(failed.status, 502);

    const ok = await call('/message/sendText/automobiles', { method: 'POST', body: { number: '919876543210', text: 'two' } });
    assert.equal(ok.status, 201);
  });

  test('a retried X-Message-Id is not sent twice', async () => {
    const send = () => call('/message/sendText/automobiles', { method: 'POST', body: { number: '919876543210', text: 'once' }, headers: { 'x-message-id': 'log-1' } });

    const first = await (await send()).json();
    const second = await (await send()).json();

    assert.deepEqual(second, first);
    assert.equal(wa.sent.length, 1);
  });

  test('keeps a gap between messages from one number', async () => {
    await Promise.all([1, 2, 3].map((n) => call('/message/sendText/automobiles', { method: 'POST', body: { number: '919876543210', text: `m${n}` } })));

    assert.equal(wa.sent.length, 3);
    for (let i = 1; i < wa.sent.length; i++) {
      assert.ok(wa.sent[i].at - wa.sent[i - 1].at >= 45, 'gap between sends');
    }
  });

  test('answers unknown instances with 404', async () => {
    const res = await call('/message/sendText/bakery', { method: 'POST', body: { number: '919876543210', text: 'hi' } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'unknown_instance');
  });

  test('connection state in Evolution API shape, and the QR code', async () => {
    assert.deepEqual(await (await call('/instance/connectionState/automobiles')).json(), { instance: { instanceName: 'automobiles', state: 'open' } });

    await call('/instance/logout/automobiles', { method: 'DELETE' });
    const connect = await (await call('/instance/connect/automobiles')).json();
    assert.equal(connect.state, 'connecting');
    assert.match(connect.qr, /^data:image\/png;base64,/);
  });

  test('QR page asks for the API key as browser password', async () => {
    const denied = await fetch(`${base}/qr/automobiles`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic/);

    wa.state = 'connecting';
    wa.qr = 'QR-TEXT';
    const page = await fetch(`${base}/qr/automobiles`, { headers: { authorization: `Basic ${Buffer.from(`admin:${API_KEY}`).toString('base64')}` } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Link a device[\s\S]*<img src="data:image\/png/);
  });
});
