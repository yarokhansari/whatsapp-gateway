// One WhatsApp number, connected through Baileys (WhatsApp Web).
// All Baileys code lives in this file, so a Baileys upgrade only touches this file.

import { rm } from 'node:fs/promises';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';

const MAX_RETRY_MS = 60_000;

export class WhatsAppInstance {
  /** 'close' | 'connecting' | 'open' — same words as Evolution API */
  state = 'close';

  /** The QR text to scan while not linked, else null. */
  qr = null;

  /** The linked phone's WhatsApp id once connected. */
  me = null;

  #sock = null;
  #retryMs = 2000;
  #stopped = false;

  /**
   * @param {string} name
   * @param {string} dir     folder for this number's login session (keep private)
   * @param {import('pino').Logger} logger
   */
  constructor(name, dir, logger) {
    this.name = name;
    this.dir = dir;
    this.logger = logger.child({ instance: name });
  }

  async start() {
    this.#stopped = false;
    this.state = 'connecting';

    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    // WhatsApp Web version; Baileys' built-in one is used if GitHub can't be reached.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu('Chrome'),
      logger: this.logger.child({ module: 'baileys' }, { level: 'warn' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.#sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => this.#onUpdate(update));
  }

  async #onUpdate({ connection, lastDisconnect, qr }) {
    if (qr) {
      this.qr = qr;
      this.logger.info('Waiting for the QR code to be scanned');
    }

    if (connection === 'open') {
      this.state = 'open';
      this.qr = null;
      this.me = this.#sock?.user?.id ?? null;
      this.#retryMs = 2000;
      this.logger.info({ me: this.me }, 'Connected');
    }

    if (connection === 'close') {
      this.state = 'close';
      this.me = null;
      const code = lastDisconnect?.error?.output?.statusCode;

      if (this.#stopped) {
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: forget the session and show a new QR code.
        this.logger.warn('Logged out from the phone; a new QR code is needed');
        await rm(this.dir, { recursive: true, force: true });
        this.#retryMs = 2000;
      } else {
        this.logger.warn({ code }, `Connection closed; trying again in ${this.#retryMs / 1000} s`);
      }

      setTimeout(() => this.start().catch((error) => this.logger.error(error, 'Restart failed')), this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    }
  }

  /**
   * The WhatsApp id for a phone number, or null when the number has no WhatsApp.
   * @param {string} number digits only, with country code, e.g. 919876543210
   */
  async lookup(number) {
    const [result] = (await this.#sock.onWhatsApp(number)) ?? [];

    return result?.exists ? result.jid : null;
  }

  /**
   * @returns {Promise<string|null>} the message id
   */
  async sendText(jid, text) {
    const message = await this.#sock.sendMessage(jid, { text });

    return message?.key?.id ?? null;
  }

  /** Unlink this server from the phone. A new QR code follows. */
  async logout() {
    await this.#sock?.logout();
  }

  stop() {
    this.#stopped = true;
    this.#sock?.end(undefined);
  }
}
