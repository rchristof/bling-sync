const { endpoints, RECONCILIATION_WINDOW_DAYS, REQUEST_DELAY_MS } = require('./config');
const { blingGet, fetchPaginated } = require('./bling');
const { log } = require('./logger');
const {
  syncState,
  upsertConta,
  upsertContato,
  upsertEstoqueMovimento,
  upsertNotaFiscal,
  upsertPedido,
  upsertProduto,
} = require('./repositories');
const { sleep } = require('./utils');

async function backfillPedidos(options = {}) {
  const params = {};
  if (options.desde) params.dataInicial = options.desde;
  if (options.ate) params.dataFinal = options.ate;

  const pedidos = await fetchPaginated(endpoints.pedidos, params);
  log('info', 'pedidos list fetched', { count: pedidos.length, params });

  for (const [index, pedido] of pedidos.entries()) {
    const detail = await blingGet(`${endpoints.pedidos}/${pedido.id}`);
    await upsertPedido(detail.data || detail);

    if ((index + 1) % 25 === 0) {
      log('info', 'pedidos backfill progress', { done: index + 1, total: pedidos.length });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await syncState('pedidos', { ...options, count: pedidos.length });
}

async function backfillListEntity(entity, resourcePath, upsert, options = {}) {
  const params = {};
  if (options.desde) params.dataInicial = options.desde;
  if (options.ate) params.dataFinal = options.ate;

  const items = await fetchPaginated(resourcePath, params);
  log('info', `${entity} list fetched`, { count: items.length, params });

  for (const item of items) {
    await upsert(item);
  }

  await syncState(entity, { ...options, count: items.length });
}

async function runBackfill(options = {}) {
  const entities = (options.entities || process.env.BACKFILL_ENTITIES || 'produtos,pedidos,contatos,notas_fiscais,contas_receber,contas_pagar,estoque_movimentos')
    .split(',')
    .map(entity => entity.trim())
    .filter(Boolean);

  log('info', 'backfill started', { entities, desde: options.desde, ate: options.ate });

  for (const entity of entities) {
    if (entity === 'pedidos') await backfillPedidos(options);
    else if (entity === 'produtos') await backfillListEntity(entity, endpoints.produtos, upsertProduto, options);
    else if (entity === 'contatos') await backfillListEntity(entity, endpoints.contatos, upsertContato, options);
    else if (entity === 'notas_fiscais') await backfillListEntity(entity, endpoints.notas_fiscais, upsertNotaFiscal, options);
    else if (entity === 'contas_receber') await backfillListEntity(entity, endpoints.contas_receber, item => upsertConta('contas_receber', item), options);
    else if (entity === 'contas_pagar') await backfillListEntity(entity, endpoints.contas_pagar, item => upsertConta('contas_pagar', item), options);
    else if (entity === 'estoque_movimentos') await backfillListEntity(entity, endpoints.estoque_movimentos, upsertEstoqueMovimento, options);
    else log('warn', 'unknown backfill entity ignored', { entity });
  }

  log('info', 'backfill finished', { entities });
}

async function runReconciliation() {
  const since = new Date(Date.now() - RECONCILIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  await runBackfill({
    desde: since,
    entities: process.env.RECONCILIATION_ENTITIES || 'produtos,pedidos,contatos,notas_fiscais,contas_receber,contas_pagar,estoque_movimentos',
  });

  await syncState('daily_reconciliation', { since });
}

module.exports = { runBackfill, runReconciliation };
