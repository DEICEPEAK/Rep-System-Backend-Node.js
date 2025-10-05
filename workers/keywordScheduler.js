// workers/keywordScheduler.js
const cron = require('node-cron');
const pool = require('../db/pool');
const { generalQueue, socialQueue, reviewQueue } = require('./keywordQueue');

class KeywordScheduler {
  async schedulePendingJobs() {
   // console.log('🔄 Checking for pending keyword jobs...');
    
    try {
      await this.scheduleTypeJobs('general');
      await this.scheduleTypeJobs('social'); 
      await this.scheduleTypeJobs('review');
      
     // console.log('✅ Keyword scheduling completed');
    } catch (error) {
      console.error('❌ Keyword scheduling failed:', error);
    }
  }

  async scheduleTypeJobs(sourceType) {
    const column = `${sourceType}_keyword_fetched`;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
      `SELECT id, company_name 
       FROM users 
       WHERE (${column} IS NULL OR ${column} < $1)
       LIMIT 50`, // Process 50 users at a time to avoid overload
      [twentyFourHoursAgo]
    );

   // console.log(`📋 Found ${rows.length} users needing ${sourceType} keywords`);

    for (const user of rows) {
      const queue = this.getQueueForType(sourceType);
      
      await queue.add('process-keywords', {
        userId: user.id,
        companyName: user.company_name,
        sourceType: sourceType
      }, {
        delay: Math.random() * 30000, // Stagger jobs over 30 seconds
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000 // 1 minute
        },
        removeOnComplete: true,
        removeOnFail: false
      });
      
     // console.log(`📤 Queued ${sourceType} keywords job for user: ${user.id}`);
    }
  }

  getQueueForType(sourceType) {
    switch(sourceType) {
      case 'general': return generalQueue;
      case 'social': return socialQueue;
      case 'review': return reviewQueue;
      default: throw new Error(`Unknown source type: ${sourceType}`);
    }
  }

  start() {
    // Run every 15 minutes
    cron.schedule('*/15 * * * *', () => {
  //    console.log('⏰ Running scheduled keyword job check...');
      this.schedulePendingJobs().catch(console.error);
    });

    // Also run immediately on startup
    setTimeout(() => {
      this.schedulePendingJobs().catch(console.error);
    }, 10000); // 10 seconds after startup

  //  console.log('🚀 Keyword scheduler started (runs every 15 minutes)');
  }
}

module.exports = new KeywordScheduler();