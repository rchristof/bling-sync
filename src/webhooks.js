const { endpoints, REQUEST_DELAY_MS, WORKER_BATCH_SIZE } = require('./config');
const { blingGet } = require('./bling');
const { pool } = require('./db');
const { log } = require('./logger');
const { upsertEstoqueMovimento, upsertNotaFiscal, upsertPedido, upsertProduto } = require('./repositories');
const { sleep } = require('./utils');

function normalizeWebhookResource(resource) {
  const normalized = String(resource || '').replace(/-/g, '_').toLowerCase();
  const aliases = {
    orders: 'order',
    sale_order: 'order',
    sales_order: 'order',
    pedido: 'order',
    pedido_venda: 'order',
    pedidos_vendas: 'order',
    products: 'product',
    produto: 'product',
    produtos: 'product',
    stocks: 'stock',
    estoque: 'stock',
    invoice_nfe: 'invoice',
    invoices: 'invoice',
    nota_fiscal: 'invoice',
    notas_fiscais: 'invoice',
  };

  return aliases[normalized] || normalized;
}

function webhookEntityFromEvent(eventName) {
  const [resource, action] = String(eventName || '').split('.');
  return { resource: normalizeWebhookResource(resource), action };
}

function webhookResourceId(event) {
  return event.payload?.data?.id || event.payload?.data?.pedido?.id || event.payload?.data?.produto?.id || null;
}

async function processWebhookEvent(event) {
  const { resource, action } = webhookEntityFromEvent(event.event_name);
  const resourceId = webhookResourceId(event);

  if (!resource || !resourceId) {
    log('warn', 'webhook ignored without resource/id', { eventId: event.id, eventName: event.event_name });
    return;
  }

  if (action === 'deleted') {
    if (resource === 'order') await pool.query('UPDATE pedidos SET deleted_at = NOW() WHERE id = $1', [resourceId]);
    if (resource === 'product') await pool.query('UPDATE produtos SET deleted_at = NOW() WHERE id = $1', [resourceId]);
    return;
  }

  if (resource === 'order') {
    const detail = await blingGet(`${endpoints.pedidos}/${resourceId}`);
    await upsertPedido(detail.data || detail);
  } else if (resource === 'product') {
    const detail = await blingGet(`${endpoints.produtos}/${resourceId}`);
    await upsertProduto(detail.data || detail);
  } else if (resource === 'stock' || resource === 'virtual_stock') {
    await upsertEstoqueMovimento(event.payload?.data || event.payload);
  } else if (resource === 'invoice' || resource === 'consumer_invoice') {
    const detail = await blingGet(`${endpoints.notas_fiscais}/${resourceId}`);
    await upsertNotaFiscal(detail.data || detail);
  } else {
    log('warn', 'unsupported webhook resource', { eventId: event.id, resource, action });
  }
}

async function claimWebhookEvents(limit = WORKER_BATCH_SIZE) {
  const { rows } = await pool.query(
    `WITH next_events AS (
       SELECT id
       FROM bling_webhook_events
       WHERE status IN ('pending', 'failed')
         AND attempts < 10
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
    [limit]
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
      log('error', 'webhook processing failed', { id: event.id, error: err.message });
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

module.exports = { webhookEntityFromEvent, processWebhookBatch };
