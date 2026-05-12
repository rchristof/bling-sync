import path from 'path';

function requiredEnv(name: string): string {
  if (!process.env[name]) throw new Error(`Missing required env var: ${name}`);
  return process.env[name]!;
}

// App
export const APP_NAME = 'bling-sync';
export const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Bling OAuth
export const BLING_CLIENT_ID = requiredEnv('BLING_CLIENT_ID');
export const BLING_CLIENT_SECRET = requiredEnv('BLING_CLIENT_SECRET');
export const BLING_REDIRECT_URI = process.env.BLING_REDIRECT_URI || `${PUBLIC_BASE_URL}/auth/callback`;
export const BLING_OAUTH_BASE_URL = process.env.BLING_OAUTH_BASE_URL || 'https://www.bling.com.br/Api/v3/oauth';
export const TOKEN_EXPIRY_SKEW_MS = Number(process.env.TOKEN_EXPIRY_SKEW_MS || 120000);

// Bling API
export const BLING_API_BASE_URL = process.env.BLING_API_BASE_URL || 'https://api.bling.com.br/Api/v3';
export const BLING_REQUEST_TIMEOUT_MS = Number(process.env.BLING_REQUEST_TIMEOUT_MS || 30000);
export const REQUEST_DELAY_MS = Number(process.env.BLING_REQUEST_DELAY_MS || 350);
export const endpoints = {
  pedidos: process.env.BLING_PEDIDOS_PATH || '/pedidos/vendas',
  produtos: process.env.BLING_PRODUTOS_PATH || '/produtos',
  contatos: process.env.BLING_CONTATOS_PATH || '/contatos',
  notas_fiscais: process.env.BLING_NOTAS_FISCAIS_PATH || '/nfe',
  contas_receber: process.env.BLING_CONTAS_RECEBER_PATH || '/contas/receber',
  contas_pagar: process.env.BLING_CONTAS_PAGAR_PATH || '/contas/pagar',
  lojas: process.env.BLING_LOJAS_PATH || '/canaisdevenda',
};

// Database
export const DATABASE_URL = process.env.DATABASE_URL || 'postgres://bling:blingpass@localhost:5432/blingdb';
export const DB_POOL_MAX = Number(process.env.DB_POOL_MAX || 10);

// HTTP server
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '5mb';

// Worker
export const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 10000);
export const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE || 25);
export const WEBHOOK_MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 10);
export const RUN_WORKER = process.env.RUN_WORKER !== 'false';
export const RUN_DAILY_RECONCILIATION = process.env.RUN_DAILY_RECONCILIATION !== 'false';

// Backfill / reconciliation
const DEFAULT_ENTITIES = 'lojas,produtos,pedidos,contatos,notas_fiscais,contas_receber,contas_pagar';
export const BACKFILL_START_DATE: string | undefined = process.env.BACKFILL_START_DATE?.trim() || undefined;
export const BACKFILL_ENTITIES = process.env.BACKFILL_ENTITIES || DEFAULT_ENTITIES;
export const RECONCILIATION_ENTITIES = process.env.RECONCILIATION_ENTITIES || DEFAULT_ENTITIES;
export const RECONCILIATION_WINDOW_DAYS = Number(process.env.RECONCILIATION_WINDOW_DAYS || 7);
export const DAILY_RECONCILIATION_HOUR = Number(process.env.DAILY_RECONCILIATION_HOUR || 3);

// Logging / paths
export const LOG_FILE = process.env.LOG_FILE || '';
export const TOKEN_FILE = path.join(process.cwd(), '.token.json');
export const SCHEMA_FILE = path.join(process.cwd(), 'db', 'schema.sql');
