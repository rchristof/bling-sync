const { endpoints, RECONCILIATION_WINDOW_DAYS, REQUEST_DELAY_MS } = require('./config');
const { blingGet } = require('./bling');
const { pool } = require('./db');
const { log } = require('./logger');
const {
  syncState,
  upsertConta,
  upsertContato,
  upsertNotaFiscal,
  upsertPedido,
  upsertProduto,
} = require('./repositories');

const DEFAULT_ENTITIES = 'produtos,pedidos,contatos,notas_fiscais,contas_receber,contas_pagar';
const PAGE_SIZE = 100;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function buildDateParams(entity, options: any = {}) {
  const mode = options.filterMode === 'updated' ? 'updated' : 'business';
  const config = DATE_FILTERS[mode][entity];
  if (!config) return {};

  const [startParam, endParam, format, extraParams = {}] = config;
  const params = { ...extraParams };

  if (options.desde) params[startParam] = formattedDate(options.desde, format);
  if (options.ate) params[endParam] = formattedDate(options.ate, format, true);

  return params;
}

function maxPagesOption(options: any = {}) {
  const maxPages = Number(options.maxPages || 0);
  return Number.isInteger(maxPages) && maxPages > 0 ? maxPages : undefined;
}

function entityFingerprint(options: any = {}) {
  return {
    desde: options.desde || null,
    ate: options.ate || null,
    filterMode: options.filterMode === 'updated' ? 'updated' : 'business',
  };
}

async function loadCheckpoint(entity, fingerprint) {
  const { rows } = await pool.query('SELECT metadata FROM sync_state WHERE entity = $1', [entity]);
  const meta = rows[0]?.metadata;
  if (!meta || meta.completed) return null;
  if (meta.desde !== fingerprint.desde) return null;
  if (meta.ate !== fingerprint.ate) return null;
  if (meta.filterMode !== fingerprint.filterMode) return null;

  const lastPage = Number(meta.lastPage || 0);
  if (!Number.isInteger(lastPage) || lastPage < 1) return null;
  return { lastPage, count: Number(meta.count || 0) };
}

async function saveCheckpoint(entity, fingerprint, lastPage, count, completed) {
  await syncState(entity, { ...fingerprint, lastPage, count, completed });
}

async function streamPages(resourcePath, params, options, onPage) {
  const maxPages = maxPagesOption(options);
  const startPage = Number(options.startPage || 1);
  let pagina = startPage;

  while (true) {
    const data = await blingGet(resourcePath, { ...params, pagina, limite: PAGE_SIZE });
    const items = data?.data || [];
    await onPage(items, pagina);

    if (maxPages && pagina - startPage + 1 >= maxPages) break;
    if (items.length < PAGE_SIZE) break;
    pagina++;
    await sleep(REQUEST_DELAY_MS);
  }
}

async function backfillListEntity(entity, resourcePath, upsert, options: any = {}) {
  const params = buildDateParams(entity, options);
  const fingerprint = entityFingerprint(options);
  const checkpoint = await loadCheckpoint(entity, fingerprint);
  const startPage = checkpoint ? checkpoint.lastPage + 1 : 1;
  let count = checkpoint?.count || 0;
  let lastPage = startPage - 1;

  log('info', `${entity} fetching`, { params, ...fingerprint, startPage, resumed: Boolean(checkpoint) });

  await streamPages(resourcePath, params, { ...options, startPage }, async (items, pagina) => {
    for (const item of items) {
      await upsert(item);
    }
    count += items.length;
    lastPage = pagina;
    await saveCheckpoint(entity, fingerprint, pagina, count, false);
  });

  await saveCheckpoint(entity, fingerprint, lastPage, count, true);
  log('info', `${entity} synced`, { count, lastPage });
}

async function backfillDetailEntity(entity, resourcePath, upsert, options: any = {}) {
  const params = buildDateParams(entity, options);
  const fingerprint = entityFingerprint(options);
  const checkpoint = await loadCheckpoint(entity, fingerprint);
  const startPage = checkpoint ? checkpoint.lastPage + 1 : 1;
  let count = checkpoint?.count || 0;
  let lastPage = startPage - 1;

  log('info', `${entity} fetching`, { params, ...fingerprint, startPage, resumed: Boolean(checkpoint) });

  await streamPages(resourcePath, params, { ...options, startPage }, async (items, pagina) => {
    for (const item of items) {
      const detail = await blingGet(`${resourcePath}/${item.id}`);
      await upsert(detail.data || detail);
      count++;

      if (count % 25 === 0) {
        log('info', `${entity} backfill progress`, { processed: count, page: pagina });
      }

      await sleep(REQUEST_DELAY_MS);
    }
    lastPage = pagina;
    await saveCheckpoint(entity, fingerprint, pagina, count, false);
  });

  await saveCheckpoint(entity, fingerprint, lastPage, count, true);
  log('info', `${entity} synced`, { count, lastPage });
}

async function runBackfill(options: any = {}) {
  const entities = (options.entities || process.env.BACKFILL_ENTITIES || DEFAULT_ENTITIES)
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
  const succeeded = [];

  for (const entity of entities) {
    try {
      if (entity === 'pedidos') await backfillDetailEntity('pedidos', endpoints.pedidos, upsertPedido, options);
      else if (entity === 'produtos') await backfillListEntity(entity, endpoints.produtos, upsertProduto, options);
      else if (entity === 'contatos') await backfillListEntity(entity, endpoints.contatos, upsertContato, options);
      else if (entity === 'notas_fiscais') await backfillDetailEntity(entity, endpoints.notas_fiscais, upsertNotaFiscal, options);
      else if (entity === 'contas_receber') await backfillListEntity(entity, endpoints.contas_receber, item => upsertConta('contas_receber', item), options);
      else if (entity === 'contas_pagar') await backfillListEntity(entity, endpoints.contas_pagar, item => upsertConta('contas_pagar', item), options);
      else { log('warn', 'unknown backfill entity ignored', { entity }); continue; }
      succeeded.push(entity);
    } catch (err) {
      log('error', `${entity} backfill failed`, { entity, error: err.message });
      failed.push(entity);
    }
  }

  if (failed.length > 0) {
    log('warn', 'backfill finished with errors', { failed, succeeded });
  } else {
    log('info', 'backfill finished', { entities });
  }

  return { succeeded, failed };
}

async function runReconciliation() {
  const fallbackMs = RECONCILIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const { rows } = await pool.query(
    "SELECT last_synced_at FROM sync_state WHERE entity = 'daily_reconciliation'"
  );
  const lastMs = rows[0]?.last_synced_at ? new Date(rows[0].last_synced_at).getTime() : null;
  const sinceMs = lastMs ? Math.min(Date.now() - fallbackMs, lastMs) : Date.now() - fallbackMs;
  const since = new Date(sinceMs).toISOString().slice(0, 10);

  log('info', 'reconciliation window resolved', { since, hadPreviousRun: Boolean(lastMs) });

  await runBackfill({
    desde: since,
    filterMode: 'updated',
    entities: process.env.RECONCILIATION_ENTITIES || DEFAULT_ENTITIES,
  });

  await syncState('daily_reconciliation', { since });
}

async function ensureInitialBackfill() {
  const { rows } = await pool.query(
    "SELECT metadata FROM sync_state WHERE entity = 'initial_backfill'"
  );
  if (rows[0]?.metadata?.completed === true) {
    log('info', 'initial backfill already completed, skipping');
    return;
  }

  const desde = process.env.BACKFILL_START_DATE;
  log('info', 'initial backfill starting', { desde, resuming: Boolean(rows[0]) });

  const result = await runBackfill({ desde });

  if (result.failed.length === 0) {
    await syncState('initial_backfill', {
      completed: true,
      desde,
      finishedAt: new Date().toISOString(),
    });
    log('info', 'initial backfill completed');
  } else {
    await syncState('initial_backfill', {
      completed: false,
      desde,
      failed: result.failed,
      succeeded: result.succeeded,
      lastAttempt: new Date().toISOString(),
    });
    log('warn', 'initial backfill partial, will retry on next start', { failed: result.failed });
  }
}

module.exports = { runBackfill, runReconciliation, ensureInitialBackfill };
