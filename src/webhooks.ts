const crypto = require('crypto');
const { BLING_CLIENT_SECRET, endpoints, REQUEST_DELAY_MS, WEBHOOK_MAX_ATTEMPTS, WORKER_BATCH_SIZE } = require('./config');
const { blingGet } = require('./bling');
const { pool } = require('./db');
const { log } = require('./logger');
const { upsertNotaFiscal, upsertPedido, upsertProduto } = require('./repositories');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function blankToNull(value) {
  return value === undefined || value === '' ? null : value;
}

function verifyBlingSignature(rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', BLING_CLIENT_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function webhookEntityFromEvent(eventName) {
  const [resource, action] = String(eventName || '').toLowerCase().split('.');
  return { resource: resource || null, action: action || null };
}

function webhookResourceId(payload) {
  return payload?.data?.id || null;
}

async function enqueueWebhook(payload, headers, rawBody) {
  const safePayload = payload || {};
  const { resource, action } = webhookEntityFromEvent(safePayload.event);

  const { rows } = await pool.query(
    `INSERT INTO bling_webhook_events (
       event_id, event_name, resource, action, company_id, event_date,
       payload, headers, raw_body, received_at, status, attempts
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'pending', 0)
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO UPDATE SET
       payload  = EXCLUDED.payload,
       headers  = EXCLUDED.headers,
       raw_body = EXCLUDED.raw_body
     RETURNING id, (xmax = 0) AS inserted`,
    [
      blankToNull(safePayload.eventId),
      blankToNull(safePayload.event),
      blankToNull(resource),
      blankToNull(action),
      blankToNull(safePayload.companyId),
      blankToNull(safePayload.date),
      JSON.stringify(safePayload),
      JSON.stringify(headers || {}),
      rawBody || JSON.stringify(safePayload),
    ]
  );

  const row = rows[0];
  log('info', row?.inserted ? 'webhook enqueued' : 'webhook duplicate ignored', {
    id: row?.id,
    eventId: safePayload.eventId || null,
    event: safePayload.event || null,
    resource,
    action,
  });
}

async function processWebhookEvent(event) {
  const { resource, action } = webhookEntityFromEvent(event.event_name);
  const resourceId = webhookResourceId(event.payload);

  if (!resource || !action) {
    log('warn', 'webhook ignored: malformed event name', {
      id: event.id,
      eventName: event.event_name,
    });
    return;
  }

  if (!resourceId && action !== 'deleted') {
    log('warn', 'webhook ignored: missing data.id', {
      id: event.id,
      eventName: event.event_name,
    });
    return;
  }

  if (action === 'deleted') {
    if (!resourceId) {
      log('warn', 'webhook delete ignored: missing data.id', { id: event.id, eventName: event.event_name });
      return;
    }
    if (resource === 'order') {
      await pool.query('UPDATE pedidos SET deleted_at = NOW() WHERE id = $1', [resourceId]);
      log('info', 'webhook applied: order deleted', { id: event.id, resourceId });
      return;
    }
    if (resource === 'product') {
      await pool.query('UPDATE produtos SET deleted_at = NOW() WHERE id = $1', [resourceId]);
      log('info', 'webhook applied: product deleted', { id: event.id, resourceId });
      return;
    }
    if (resource === 'invoice') {
      await pool.query('UPDATE notas_fiscais SET deleted_at = NOW() WHERE id = $1', [resourceId]);
      log('info', 'webhook applied: invoice deleted', { id: event.id, resourceId });
      return;
    }
    log('warn', 'webhook delete ignored: unsupported resource', {
      id: event.id,
      resource,
      eventName: event.event_name,
    });
    return;
  }

  if (resource === 'order') {
    const detail = await blingGet(`${endpoints.pedidos}/${resourceId}`);
    await upsertPedido(detail.data || detail);
    log('info', 'webhook applied: order upserted', { id: event.id, resourceId });
    return;
  }

  if (resource === 'product') {
    const detail = await blingGet(`${endpoints.produtos}/${resourceId}`);
    await upsertProduto(detail.data || detail);
    log('info', 'webhook applied: product upserted', { id: event.id, resourceId });
    return;
  }

  if (resource === 'invoice') {
    const detail = await blingGet(`${endpoints.notas_fiscais}/${resourceId}`);
    await upsertNotaFiscal(detail.data || detail);
    log('info', 'webhook applied: invoice upserted', { id: event.id, resourceId });
    return;
  }

  log('warn', 'webhook ignored: unsupported resource', {
    id: event.id,
    resource,
    action,
    eventName: event.event_name,
  });
}

async function claimWebhookEvents(limit = WORKER_BATCH_SIZE) {
  const { rows } = await pool.query(
    `WITH next_events AS (
       SELECT id
       FROM bling_webhook_events
       WHERE status IN ('pending', 'failed')
         AND attempts < $2
         AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '10 minutes')
       ORDER BY received_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE bling_webhook_events e
     SET status = 'processing',
         attempts = attempts + 1,
         locked_at = NOW()
     FROM next_events
     WHERE e.id = next_events.id
     RETURNING e.*`,
    [limit, WEBHOOK_MAX_ATTEMPTS]
  );

  return rows;
}

async function processWebhookBatch() {
  const events = await claimWebhookEvents();
  if (events.length === 0) return;

  for (const event of events) {
    try {
      await processWebhookEvent(event);
      await pool.query(
        `UPDATE bling_webhook_events
         SET status = 'processed', processed_at = NOW(), locked_at = NULL, error = NULL
         WHERE id = $1`,
        [event.id]
      );
    } catch (err) {
      const isFinalAttempt = event.attempts >= WEBHOOK_MAX_ATTEMPTS;
      log(isFinalAttempt ? 'error' : 'warn', 'webhook processing failed', {
        id: event.id,
        eventName: event.event_name,
        attempts: event.attempts,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        finalAttempt: isFinalAttempt,
        error: err.message,
      });
      await pool.query(
        `UPDATE bling_webhook_events
         SET status = 'failed', locked_at = NULL, error = $2
         WHERE id = $1`,
        [event.id, err.message]
      );
    }

    await sleep(REQUEST_DELAY_MS);
  }
}

module.exports = {
  webhookEntityFromEvent,
  verifyBlingSignature,
  enqueueWebhook,
  processWebhookBatch,
};
