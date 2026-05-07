const fs = require('fs');
const { Pool } = require('pg');
const { DATABASE_URL, SCHEMA_FILE } = require('./config');
const { log } = require('./logger');

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

async function ensureSchema() {
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  await pool.query(schema);
  log('info', 'database schema ensured');
}

module.exports = { pool, ensureSchema };
