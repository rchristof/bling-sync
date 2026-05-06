const path = require('path');

const APP_NAME = 'bling-sync';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://bling:blingpass@localhost:5432/blingdb';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

module.exports = {
  APP_NAME,
  PORT,
  DATABASE_URL,
  PUBLIC_BASE_URL,
  BLING_REDIRECT_URI: process.env.BLING_REDIRECT_URI || `${PUBLIC_BASE_URL}/auth/callback`,
  BLING_API_BASE_URL: process.env.BLING_API_BASE_URL || 'https://api.bling.com.br/Api/v3',
  BLING_OAUTH_BASE_URL: process.env.BLING_OAUTH_BASE_URL || 'https://www.bling.com.br/Api/v3/oauth',
  REQUEST_DELAY_MS: Number(process.env.BLING_REQUEST_DELAY_MS || 350),
  TOKEN_EXPIRY_SKEW_MS: Number(process.env.TOKEN_EXPIRY_SKEW_MS || 120000),
  WORKER_INTERVAL_MS: Number(process.env.WORKER_INTERVAL_MS || 10000),
  WORKER_BATCH_SIZE: Number(process.env.WORKER_BATCH_SIZE || 25),
  DAILY_RECONCILIATION_HOUR: Number(process.env.DAILY_RECONCILIATION_HOUR || 3),
  RECONCILIATION_WINDOW_DAYS: Number(process.env.RECONCILIATION_WINDOW_DAYS || 7),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  LOG_FILE: process.env.LOG_FILE || '',
  TOKEN_FILE: path.join(__dirname, '..', '.token.json'),
  SCHEMA_FILE: path.join(__dirname, '..', 'db', 'schema.sql'),
  endpoints: {
    pedidos: process.env.BLING_PEDIDOS_PATH || '/pedidos/vendas',
    produtos: process.env.BLING_PRODUTOS_PATH || '/produtos',
    contatos: process.env.BLING_CONTATOS_PATH || '/contatos',
    notas_fiscais: process.env.BLING_NOTAS_FISCAIS_PATH || '/nfe',
    contas_receber: process.env.BLING_CONTAS_RECEBER_PATH || '/contas/receber',
    contas_pagar: process.env.BLING_CONTAS_PAGAR_PATH || '/contas/pagar',
    estoque_movimentos: process.env.BLING_ESTOQUE_MOVIMENTOS_PATH || '/estoques/movimentacoes',
  },
};
