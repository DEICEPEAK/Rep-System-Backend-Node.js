// workers/emailWorker.js
require('dotenv').config();
process.title = 'email-worker';

process.on('unhandledRejection', err => console.error('[email-worker] unhandledRejection', err));
process.on('uncaughtException',  err => console.error('[email-worker] uncaughtException',  err));


require('../services/emailQueue');

console.log('[email-worker] booted. REDIS_URL=%s', process.env.REDIS_URL);
