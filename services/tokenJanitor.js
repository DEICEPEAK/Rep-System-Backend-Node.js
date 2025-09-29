// services/tokenJanitor.js
const cron = require('node-cron');
const { purgeOldTokens } = require('./tokenService');

function startTokenJanitorCron() {
  // Run at 02:17 every day
  cron.schedule('17 2 * * *', async () => {
    try {
      await purgeOldTokens();
    } catch (e) {
      console.error('[token-janitor] failed:', e);
    }
  });
}

module.exports = { startTokenJanitorCron };
