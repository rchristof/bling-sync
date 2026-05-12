import fs from 'fs';
import { Pool } from 'pg';
import { DATABASE_URL, SCHEMA_FILE } from './config';
import { log } from './logger';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

export async function ensureSchema(): Promise<void> {
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  await pool.query(schema);
  log('info', 'database schema ensured');
}
