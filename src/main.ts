require('dotenv').config();

const { ensureSchema, pool } = require('./db');
const { createApp, listen } = require('./app');
const { log } = require('./logger');
const { seedTokenFromFileIfNeeded } = require('./oauth');
const { ensureInitialBackfill, runBackfill, runReconciliation } = require('./sync');
const { startDailyReconciliation, startWorker } = require('./worker');

function parseCliOptions(args) {
  const options = {};

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[key] = rawValue === undefined ? true : rawValue;
  }

  return options;
}

async function startServer() {
  await ensureSchema();
  await seedTokenFromFileIfNeeded();

  const app = createApp();
  const server = listen(app);

  const shutdown = async signal => {
    log('info', 'shutdown requested', { signal });
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (process.env.RUN_WORKER !== 'false') startWorker();
  if (process.env.RUN_DAILY_RECONCILIATION !== 'false') startDailyReconciliation();
  ensureInitialBackfill().catch(err => log('error', 'initial backfill failed', { error: err.message }));
}

async function main() {
  const command = process.argv[2] || 'serve';
  const options = parseCliOptions(process.argv.slice(3));

  if (command === 'serve') {
    await startServer();
    return;
  }

  await ensureSchema();
  await seedTokenFromFileIfNeeded();

  if (command === 'migrate') log('info', 'migration finished');
  else if (command === 'backfill' || command === 'sync') await runBackfill(options);
  else if (command === 'reconcile') await runReconciliation();
  else if (command === 'worker') {
    startWorker();
    setInterval(() => {}, 1 << 30);
    return;
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  await pool.end();
}

process.on('unhandledRejection', (err: any) => {
  log('error', 'unhandled rejection', { error: err.message, stack: err.stack });
});

process.on('uncaughtException', err => {
  log('error', 'uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

if (require.main === module) {
  main().catch((err: any) => {
    log('error', 'fatal error', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { main };
