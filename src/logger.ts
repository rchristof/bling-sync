const fs = require('fs');
const path = require('path');
const { APP_NAME, LOG_FILE } = require('./config');

function log(level, message, meta = {}) {
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

module.exports = { log };
