require('dotenv').config();

const { main } = require('./src/main');
const { log } = require('./src/logger');

main().catch(err => {
  log('error', 'fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
