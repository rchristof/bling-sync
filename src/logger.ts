import fs from 'fs';
import path from 'path';
import { APP_NAME, LOG_FILE } from './config';

export function log(level: string, message: string, meta: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    app: APP_NAME,
    message,
    ...meta,
  });

  if (level === 'error') console.error(line);
  else console.log(line);

  if (LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch (_err) {
      //
    }
  }
}
