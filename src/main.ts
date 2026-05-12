import 'dotenv/config';
import { RUN_DAILY_RECONCILIATION, RUN_WORKER } from './config';
import { ensureSchema, pool } from './db';
import { createApp, listen } from './app';
import { log } from './logger';
import { seedTokenFromFileIfNeeded } from './oauth';
import { runBackfill, runReconciliation, startInitialBackfill } from './sync';
import { startDailyReconciliation, startWorker } from './worker';

function parseCliOptions(args: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[key] = rawValue === undefined ? true : rawValue;
  }

  return options;
}

async function startServer(): Promise<void> {
  await ensureSchema();
  await seedTokenFromFileIfNeeded();

  const app = createApp();
  const server = listen(app);

  const shutdown = async (signal: string) => {
    log('info', 'shutdown requested', { signal });
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (RUN_WORKER) startWorker();
  if (RUN_DAILY_RECONCILIATION) startDailyReconciliation();
  startInitialBackfill('startup');
}

async function main(): Promise<void> {
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

export { main };
