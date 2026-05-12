import fs from 'fs';
import { Pool } from 'pg';
import { DATABASE_URL, DB_POOL_MAX, SCHEMA_FILE } from './config';
import { log } from './logger';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: DB_POOL_MAX,
});

export async function ensureSchema(): Promise<void> {
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  await pool.query(schema);
  log('info', 'database schema ensured');
}
