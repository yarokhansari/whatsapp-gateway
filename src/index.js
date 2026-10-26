// Starts the gateway: one WhatsApp connection per instance, then the HTTP API.

import { join } from 'node:path';
import pino from 'pino';
import { loadConfig } from './config.js';
import { createGateway } from './server.js';
import { WhatsAppInstance } from './whatsapp.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });

const instances = new Map(config.instances.map((name) => [name, new WhatsAppInstance(name, join(config.sessionDir, name), logger)]));

for (const instance of instances.values()) {
  instance.start().catch((error) => logger.error({ err: error, instance: instance.name }, 'Could not start'));
}

const server = createGateway(config, instances, logger);

server.listen(config.port, config.host, () => {
  logger.info(`WhatsApp gateway on http://${config.host}:${config.port} — instances: ${config.instances.join(', ')}`);
});

function shutdown() {
  logger.info('Stopping');
  for (const instance of instances.values()) instance.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
