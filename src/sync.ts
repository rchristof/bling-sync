const { endpoints, RECONCILIATION_WINDOW_DAYS, REQUEST_DELAY_MS } = require('./config');
const { blingGet } = require('./bling');
const { pool } = require('./db');
const { log } = require('./logger');
const { loadToken } = require('./oauth');
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
let initialBackfillPromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DATE_FILTERS = {
  business: {
    produtos: ['dataInclusaoInicial', 'dataInclusaoFinal', 'datetime', { criterio: 5, tipo: 'T' }],
    pedidos: ['dataInicial', 'dataFinal', 'date'],
    contatos: ['dataInclusaoInicial', 'dataInclusaoFinal', 'datetime'],
    notas_fiscais: ['dataEmissaoInicial', 'dataEmissaoFinal', 'datetime'],
    contas_receber: ['dataInicial', 'dataFinal', 'date', { tipoFiltroData: 'E' }],
    contas_pagar: ['dataEmissaoInicial', 'dataEmissaoFinal', 'date'],
  },
  updated: {
    produtos: ['dataAlteracaoInicial', 'dataAlteracaoFinal', 'datetime', { criterio: 5, tipo: 'T' }],
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

function optionalDateValue(value) {
  if (value === undefined || value === null || typeof value === 'boolean') return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizedBackfillOptions(options: any = {}) {
  return {
    ...options,
    desde: optionalDateValue(options.desde),
    ate: optionalDateValue(options.ate),
  };
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

function checkpointPageItems(meta) {
  return Array.isArray(meta?.pageItems) ? meta.pageItems : null;
}

function entityFingerprint(options: any = {}) {
  return {
    desde: optionalDateValue(options.desde) || null,
    ate: optionalDateValue(options.ate) || null,
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
  const currentPage = Number(meta.currentPage || 0);
  const nextItemIndex = Number(meta.nextItemIndex || 0);
  const pageItems = checkpointPageItems(meta);

  if (pageItems && Number.isInteger(currentPage) && currentPage > 0) {
    return {
      lastPage,
      currentPage,
      nextItemIndex: Number.isInteger(nextItemIndex) && nextItemIndex > 0 ? nextItemIndex : 0,
      pageItems,
      count: Number(meta.count || 0),
    };
  }

  if (!Number.isInteger(lastPage) || lastPage < 1) return null;
  return { lastPage, count: Number(meta.count || 0) };
}

async function saveCheckpoint(entity, fingerprint, lastPage, count, completed) {
  await syncState(entity, { ...fingerprint, lastPage, count, completed });
}

async function saveDetailCheckpoint(entity, fingerprint, page, nextItemIndex, pageItems, count) {
  await syncState(entity, {
    ...fingerprint,
    lastPage: page - 1,
    currentPage: page,
    nextItemIndex,
    pageItems,
    count,
    completed: false,
  });
}

async function streamPages(resourcePath, params, options, onPage) {
  const maxPages = maxPagesOption(options);
  const startPage = Number(options.startPage || 1);
  const resumePageItems = checkpointPageItems(options);
  let pagina = startPage;

  while (true) {
    let items;
    if (resumePageItems && pagina === startPage) {
      items = resumePageItems;
    } else {
      const data = await blingGet(resourcePath, { ...params, pagina, limite: PAGE_SIZE });
      items = data?.data || [];
    }
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
  const resumePageItems = checkpoint?.pageItems || null;
  const startPage = resumePageItems ? checkpoint.currentPage : (checkpoint ? checkpoint.lastPage + 1 : 1);
  let count = checkpoint?.count || 0;
  let lastPage = startPage - 1;

  log('info', `${entity} fetching`, {
    params,
    ...fingerprint,
    startPage,
    resumed: Boolean(checkpoint),
    resumeItemIndex: resumePageItems ? checkpoint.nextItemIndex : 0,
  });

  await streamPages(resourcePath, params, { ...options, startPage, pageItems: resumePageItems }, async (items, pagina) => {
    const startItemIndex = resumePageItems && pagina === startPage ? checkpoint.nextItemIndex : 0;

    await saveDetailCheckpoint(entity, fingerprint, pagina, startItemIndex, items, count);

    for (let index = startItemIndex; index < items.length; index++) {
      const item = items[index];
      const detail = await blingGet(`${resourcePath}/${item.id}`);
      await upsert({ ...item, ...(detail.data || detail) });
      count++;
      await saveDetailCheckpoint(entity, fingerprint, pagina, index + 1, items, count);

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
  options = normalizedBackfillOptions(options);
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
      else if (entity === 'produtos') await backfillDetailEntity(entity, endpoints.produtos, upsertProduto, options);
      else if (entity === 'contatos') await backfillListEntity(entity, endpoints.contatos, upsertContato, options);
      else if (entity === 'notas_fiscais') await backfillDetailEntity(entity, endpoints.notas_fiscais, upsertNotaFiscal, options);
      else if (entity === 'contas_receber') await backfillDetailEntity(entity, endpoints.contas_receber, item => upsertConta('contas_receber', item), options);
      else if (entity === 'contas_pagar') await backfillDetailEntity(entity, endpoints.contas_pagar, item => upsertConta('contas_pagar', item), options);
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
  const desde = optionalDateValue(process.env.BACKFILL_START_DATE);
  const desiredDesde = desde || null;
  const { rows } = await pool.query(
    "SELECT metadata FROM sync_state WHERE entity = 'initial_backfill'"
  );
  const previousMetadata = rows[0]?.metadata || {};
  const previousDesde = previousMetadata.desde || null;

  if (previousMetadata.completed === true && previousDesde === desiredDesde) {
    log('info', 'initial backfill already completed, skipping', { desde: desiredDesde });
    return;
  }

  const token = await loadToken();
  if (!token?.access_token && !token?.refresh_token) {
    log('info', 'initial backfill waiting for oauth token');
    return;
  }

  log('info', 'initial backfill starting', {
    desde: desiredDesde,
    fullBackfill: !desde,
    resuming: previousMetadata.completed !== true && Boolean(rows[0]),
    previousDesde,
  });

  const result = await runBackfill({ desde });

  if (result.failed.length === 0) {
    await syncState('initial_backfill', {
      completed: true,
      desde: desiredDesde,
      finishedAt: new Date().toISOString(),
    });
    log('info', 'initial backfill completed');
  } else {
    await syncState('initial_backfill', {
      completed: false,
      desde: desiredDesde,
      failed: result.failed,
      succeeded: result.succeeded,
      lastAttempt: new Date().toISOString(),
    });
    log('warn', 'initial backfill partial, will retry on next start', { failed: result.failed });
  }
}

function startInitialBackfill(reason = 'startup') {
  if (initialBackfillPromise) {
    log('info', 'initial backfill already running', { reason });
    return initialBackfillPromise;
  }

  initialBackfillPromise = ensureInitialBackfill()
    .catch(err => log('error', 'initial backfill failed', { reason, error: err.message }))
    .finally(() => {
      initialBackfillPromise = null;
    });

  return initialBackfillPromise;
}

module.exports = { runBackfill, runReconciliation, ensureInitialBackfill, startInitialBackfill };
