// Settings come from the environment (.env next to package.json). See .env.example.

export function loadConfig(env = process.env) {
  const apiKey = env.API_KEY ?? '';

  if (apiKey.length < 32) {
    throw new Error('API_KEY must be set to a random string of 32+ characters (see .env.example).');
  }

  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3100),
    apiKey,
    // One WhatsApp number per instance, e.g. INSTANCES=automobiles,bakery
    instances: (env.INSTANCES || 'automobiles').split(',').map((name) => name.trim()).filter(Boolean),
    sessionDir: env.SESSION_DIR || './sessions',
    // Gap between two messages from one number; keeps the number looking like a person, not a bulk sender.
    sendGapMs: Number(env.SEND_GAP_MS || 1500),
    // How long a send request waits for its turn before answering 202 "queued".
    sendWaitMs: Number(env.SEND_WAIT_MS || 20000),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
