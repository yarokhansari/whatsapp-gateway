# WhatsApp gateway

A small service that sends WhatsApp text messages from your own number, through [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web).
Apps on this server call it over HTTP. Its routes are a subset of [Evolution API](https://doc.evolution-api.com)'s, so an app written for Evolution API works by changing its URL.

- Plain Node.js, no build step. 3 packages: Baileys, `qrcode`, `pino`.
- One WhatsApp number per **instance** (`automobiles`, later `bakery`…).
- Sends one message at a time per number, with a gap, and refuses numbers that aren't on WhatsApp.
- A retried request with the same `X-Message-Id` is never sent twice.
- Listens only on `127.0.0.1`. The public domain shows only the QR page and the health check.

> **Unofficial.** Baileys logs in like WhatsApp Web. WhatsApp may ban numbers that look like bulk senders.
> Use a separate number for each app, never your personal one, and keep volumes low (codes, receipts, reminders).

## Set up (once)

```bash
# 1. Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Code and packages
cd /var/www/whatsapp-gateway
npm ci --omit=dev

# 3. Settings
cp .env.example .env
sed -i "s/^API_KEY=.*/API_KEY=$(openssl rand -hex 32)/" .env

# 4. Service
sudo cp deploy/whatsapp-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now whatsapp-gateway

# 5. Domain for the QR page — DNS: A record  wa.yaari.store → 89.117.48.243
sudo cp deploy/nginx-wa.yaari.store.conf /etc/nginx/sites-available/wa-gateway
sudo ln -s /etc/nginx/sites-available/wa-gateway /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d wa.yaari.store
```

**Link the phone:** open `https://wa.yaari.store/qr/automobiles`, log in with any user name and the `API_KEY` as password.
On the phone: WhatsApp → **Linked devices** → **Link a device** → scan. The page then says "Connected".

## Connect an app

| Setting | Value |
| --- | --- |
| URL | `http://127.0.0.1:3100` (same server) |
| Key | the `API_KEY` from `.env`, in the `apikey` header |
| Instance | e.g. `automobiles` |

For the automobiles Laravel app (`.env`):
```
WHATSAPP_DRIVER=evolution
EVOLUTION_URL=http://127.0.0.1:3100
EVOLUTION_API_KEY=<API_KEY>
EVOLUTION_INSTANCE=automobiles
```

## API

All routes except `/health` and `/qr` need the header `apikey: <API_KEY>`. Errors look like `{ "error": "not_connected", "message": "…" }`.

| Route | Answer |
| --- | --- |
| `POST /message/sendText/{instance}` body `{ "number": "919876543210", "text": "…" }`, optional header `X-Message-Id` | `201 { "key": { "id": "…" }, "status": "sent" }`; `202 { "status": "queued" }` if it waited longer than `SEND_WAIT_MS` (it is still sent) |
| `GET /instance/connectionState/{instance}` | `{ "instance": { "instanceName": "automobiles", "state": "open" } }` — `open`, `connecting`, `close` |
| `GET /instance/connect/{instance}` | `{ "state": "connecting", "me": null, "qr": "data:image/png;base64,…" }` |
| `DELETE /instance/logout/{instance}` | unlinks the phone; a new QR code follows |
| `GET /qr/{instance}` | page with the QR code (browser password = `API_KEY`) |
| `GET /health` | `{ "status": "ok", "instances": { "automobiles": "open" } }` |

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_number`, `invalid_text`, `invalid_json` | Fix the request; don't retry |
| 401 | `unauthorized` | Wrong `apikey` |
| 404 | `unknown_instance` | Not in `INSTANCES` |
| 422 | `not_on_whatsapp` | That number has no WhatsApp; don't retry |
| 502 | `send_failed` | WhatsApp didn't take it; retry later |
| 503 | `not_connected` | Phone not linked or connection down; retry later |

## Running it

| Task | Command |
| --- | --- |
| Logs | `journalctl -u whatsapp-gateway -f` |
| Restart | `sudo systemctl restart whatsapp-gateway` |
| Status | `curl -s http://127.0.0.1:3100/health` |
| Link a different phone | `curl -X DELETE -H "apikey: $KEY" http://127.0.0.1:3100/instance/logout/automobiles`, then scan the new QR |
| Add a number for another app | add it to `INSTANCES` in `.env`, restart, scan its QR at `/qr/<name>` |
| Update code | `git pull && npm ci --omit=dev && sudo systemctl restart whatsapp-gateway` |
| Tests | `npm test` (no real messages are sent) |

The connection reconnects by itself (2 s, then up to 1 minute apart). If the phone unlinks the server, the session is cleared and the QR page shows a new code.

**Upgrading Baileys:** all Baileys code is in `src/whatsapp.js`. Change the version in `package.json` (it's pinned exactly), `npm install`, run `npm test`, restart, and check the QR page still connects.

**Backups:** `sessions/` holds the login. Losing it only means scanning the QR again.
