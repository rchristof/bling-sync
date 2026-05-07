const { endpoints, RECONCILIATION_WINDOW_DAYS, REQUEST_DELAY_MS } = require('./config');
const { blingGet, fetchPaginated } = require('./bling');
const { pool } = require('./db');
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

const DATE_FILTERS = {
  business: {
    produtos: ['dataInclusaoInicial', 'dataInclusaoFinal', 'datetime'],
    pedidos: ['dataInicial', 'dataFinal', 'date'],
    contatos: ['dataInclusaoInicial', 'dataInclusaoFinal', 'datetime'],
    notas_fiscais: ['dataEmissaoInicial', 'dataEmissaoFinal', 'datetime'],
    contas_receber: ['dataInicial', 'dataFinal', 'date', { tipoFiltroData: 'E' }],
    contas_pagar: ['dataEmissaoInicial', 'dataEmissaoFinal', 'date'],
  },
  updated: {
    produtos: ['dataAlteracaoInicial', 'dataAlteracaoFinal', 'datetime'],
    pedidos: ['dataAlteracaoInicial', 'dataAlteracaoFinal', 'datetime'],
    contatos: ['dataAlteracaoInicial', 'dataAlteracaoFinal', 'datetime'],
    notas_fiscais: ['dataEmissaoInicial', 'dataEmissaoFinal', 'datetime'],
    contas_receber: ['dataInicial', 'dataFinal', 'date', { tipoFiltroData: 'E' }],
    contas_pagar: ['dataEmissaoInicial', 'dataEmissaoFinal', 'date'],
  },
};

function dateOnly(value) {
  return String(value).slice(0, 10);
}

function dateTime(value, endOfDay = false) {
  const asString = String(value);
  if (asString.includes('T') || asString.includes(' ')) {
    return asString.replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }

  return `${dateOnly(value)} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function formattedDate(value, format, endOfDay = false) {
  if (format === 'datetime') return dateTime(value, endOfDay);
  return dateOnly(value);
}

function buildDateParams(entity, options = {}) {
  const mode = options.filterMode === 'updated' ? 'updated' : 'business';
  const config = DATE_FILTERS[mode][entity];
  if (!config) return {};

  const [startParam, endParam, format, extraParams = {}] = config;
  const params = { ...extraParams };

  if (options.desde) params[startParam] = formattedDate(options.desde, format);
  if (options.ate) params[endParam] = formattedDate(options.ate, format, true);

  return params;
}

function maxPagesOption(options = {}) {
  const maxPages = Number(options.maxPages || 0);
  return Number.isInteger(maxPages) && maxPages > 0 ? maxPages : undefined;
}

async function backfillPedidos(options = {}) {
  const params = buildDateParams('pedidos', options);
  const maxPages = maxPagesOption(options);

  const pedidos = await fetchPaginated(endpoints.pedidos, params, { maxPages });
  log('info', 'pedidos list fetched', { count: pedidos.length, params, maxPages });

  for (const [index, pedido] of pedidos.entries()) {
    const detail = await blingGet(`${endpoints.pedidos}/${pedido.id}`);
    await upsertPedido(detail.data || detail);

    if ((index + 1) % 25 === 0) {
      log('info', 'pedidos backfill progress', { done: index + 1, total: pedidos.length });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await syncState('pedidos', { ...options, count: pedidos.length });
  log('info', 'pedidos synced', { count: pedidos.length });
}

async function backfillListEntity(entity, resourcePath, upsert, options = {}) {
  const params = buildDateParams(entity, options);
  const maxPages = maxPagesOption(options);

  log('info', `${entity} fetching`, { params, maxPages });
  const items = await fetchPaginated(resourcePath, params, { maxPages });
  log('info', `${entity} list fetched`, { count: items.length, params, maxPages });

  for (const item of items) {
    await upsert(item);
  }

  await syncState(entity, { ...options, count: items.length });
  log('info', `${entity} synced`, { count: items.length });
}

async function backfillDetailEntity(entity, resourcePath, upsert, options = {}) {
  const params = buildDateParams(entity, options);
  const maxPages = maxPagesOption(options);

  log('info', `${entity} fetching`, { params, maxPages });
  const items = await fetchPaginated(resourcePath, params, { maxPages });
  log('info', `${entity} list fetched`, { count: items.length, params, maxPages });

  for (const [index, item] of items.entries()) {
    const detail = await blingGet(`${resourcePath}/${item.id}`);
    await upsert(detail.data || detail);

    if ((index + 1) % 25 === 0) {
      log('info', `${entity} backfill progress`, { done: index + 1, total: items.length });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await syncState(entity, { ...options, count: items.length });
  log('info', `${entity} synced`, { count: items.length });
}

function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function backfillEstoqueMovimentos(options = {}) {
  const configuredChunkSize = Number(process.env.BLING_ESTOQUE_CHUNK_SIZE || 50);
  const chunkSize = Number.isInteger(configuredChunkSize) && configuredChunkSize > 0
    ? configuredChunkSize
    : 50;
  const maxPages = maxPagesOption(options);
  const productLimit = maxPages ? maxPages * chunkSize : null;
  const { rows } = await pool.query(
    `SELECT id
     FROM produtos
     WHERE deleted_at IS NULL
     ORDER BY id
     ${productLimit ? 'LIMIT $1' : ''}`,
    productLimit ? [productLimit] : []
  );

  const chunks = chunk(rows.map(row => row.id), chunkSize);
  let count = 0;

  log('info', 'estoque_movimentos fetching', {
    productCount: rows.length,
    chunkSize,
    requestCount: chunks.length,
    maxPages,
  });

  for (const ids of chunks) {
    const data = await blingGet(endpoints.estoque_movimentos, { 'idsProdutos[]': ids });
    const items = data?.data || [];

    for (const item of items) {
      await upsertEstoqueMovimento({
        id: item.produto?.id,
        produto: item.produto,
        dataMovimento: new Date().toISOString(),
        tipo: 'saldo',
        quantidade: item.saldoFisicoTotal,
        saldo: item.saldoVirtualTotal,
        raw: item,
      });
      count++;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await syncState('estoque_movimentos', { ...options, count, productCount: rows.length });
  log('info', 'estoque_movimentos synced', { count, productCount: rows.length });
}

async function runBackfill(options = {}) {
  const entities = (options.entities || process.env.BACKFILL_ENTITIES || 'produtos,pedidos,contatos,notas_fiscais,contas_receber,contas_pagar,estoque_movimentos')
    .split(',')
    .map(entity => entity.trim())
    .filter(Boolean);

  log('info', 'backfill started', {
    entities,
    desde: options.desde,
    ate: options.ate,
    filterMode: options.filterMode || 'business',
    maxPages: maxPagesOption(options),
  });

  const failed = [];

  for (const entity of entities) {
    try {
      if (entity === 'pedidos') await backfillPedidos(options);
      else if (entity === 'produtos') await backfillListEntity(entity, endpoints.produtos, upsertProduto, options);
      else if (entity === 'contatos') await backfillListEntity(entity, endpoints.contatos, upsertContato, options);
      else if (entity === 'notas_fiscais') await backfillDetailEntity(entity, endpoints.notas_fiscais, upsertNotaFiscal, options);
      else if (entity === 'contas_receber') await backfillListEntity(entity, endpoints.contas_receber, item => upsertConta('contas_receber', item), options);
      else if (entity === 'contas_pagar') await backfillListEntity(entity, endpoints.contas_pagar, item => upsertConta('contas_pagar', item), options);
      else if (entity === 'estoque_movimentos') await backfillEstoqueMovimentos(options);
      else log('warn', 'unknown backfill entity ignored', { entity });
    } catch (err) {
      log('error', `${entity} backfill failed`, { entity, error: err.message });
      failed.push(entity);
    }
  }

  if (failed.length > 0) {
    log('warn', 'backfill finished with errors', { failed, succeeded: entities.filter(e => !failed.includes(e)) });
  } else {
    log('info', 'backfill finished', { entities });
  }
}

async function runReconciliation() {
  const since = new Date(Date.now() - RECONCILIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  await runBackfill({
    desde: since,
    filterMode: 'updated',
    entities: process.env.RECONCILIATION_ENTITIES || 'produtos,pedidos,contatos,notas_fiscais,contas_receber,contas_pagar,estoque_movimentos',
  });

  await syncState('daily_reconciliation', { since });
}

module.exports = { runBackfill, runReconciliation };
