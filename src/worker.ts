import { DAILY_RECONCILIATION_HOUR, WORKER_BATCH_SIZE, WORKER_INTERVAL_MS } from './config';
import { pool } from './db';
import { log } from './logger';
import { runReconciliation } from './sync';
import { processWebhookBatch } from './webhooks';

export function startWorker(): void {
  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processWebhookBatch();
    } catch (err) {
      log('error', 'worker loop failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  }, WORKER_INTERVAL_MS);

  log('info', 'worker started', { intervalMs: WORKER_INTERVAL_MS, batchSize: WORKER_BATCH_SIZE });
}

async function dailyReconciliationAlreadyRanToday(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT last_synced_at
     FROM sync_state
     WHERE entity = 'daily_reconciliation'`
  );

  if (!rows[0]?.last_synced_at) return false;
  return rows[0].last_synced_at.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

export function startDailyReconciliation(): void {
  let running = false;

  setInterval(async () => {
    const hour = new Date().getHours();
    if (running) return;
    if (hour !== DAILY_RECONCILIATION_HOUR) return;
    if (await dailyReconciliationAlreadyRanToday()) return;

    running = true;
    try {
      log('info', 'daily reconciliation started');
      await runReconciliation();
      log('info', 'daily reconciliation finished');
    } catch (err) {
      log('error', 'daily reconciliation failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  }, 60 * 1000);

  log('info', 'daily reconciliation scheduler started', { hour: DAILY_RECONCILIATION_HOUR });
}
