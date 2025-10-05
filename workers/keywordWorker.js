// workers/keywordWorker.js
const { generalQueue, socialQueue, reviewQueue } = require('./keywordQueue');
const { processGeneralKeywords } = require('./processors/generalProcessor');
const { processSocialKeywords } = require('./processors/socialProcessor');
const { processReviewKeywords } = require('./processors/reviewProcessor');

// Set up queue processors with the correct job type
generalQueue.process('process-keywords', 3, async (job) => {
//  console.log(`🔄 Processing general keywords for user: ${job.data.userId}`);
  try {
    const result = await processGeneralKeywords(job.data);
  //  console.log(`✅ General keywords completed for user: ${job.data.userId}`);
    return result;
  } catch (error) {
    console.error(`❌ General keywords failed for user ${job.data.userId}:`, error.message);
    throw error;
  }
});

socialQueue.process('process-keywords', 3, async (job) => {
//  console.log(`🔄 Processing social keywords for user: ${job.data.userId}`);
  try {
    const result = await processSocialKeywords(job.data);
  //  console.log(`✅ Social keywords completed for user: ${job.data.userId}`);
    return result;
  } catch (error) {
    console.error(`❌ Social keywords failed for user ${job.data.userId}:`, error.message);
    throw error;
  }
});

reviewQueue.process('process-keywords', 3, async (job) => {
//  console.log(`🔄 Processing review keywords for user: ${job.data.userId}`);
  try {
    const result = await processReviewKeywords(job.data);
  //  console.log(`✅ Review keywords completed for user: ${job.data.userId}`);
    return result;
  } catch (error) {
    console.error(`❌ Review keywords failed for user ${job.data.userId}:`, error.message);
    throw error;
  }
});

// Set up event listeners for monitoring
generalQueue.on('completed', (job, result) => {
  //console.log(`✅ General keywords job completed for user: ${job.data.userId}`);
});

socialQueue.on('completed', (job, result) => {
//  console.log(`✅ Social keywords job completed for user: ${job.data.userId}`);
});

reviewQueue.on('completed', (job, result) => {
//  console.log(`✅ Review keywords job completed for user: ${job.data.userId}`);
});

generalQueue.on('failed', (job, err) => {
  console.error(`❌ General keywords job failed for user ${job.data.userId}:`, err.message);
});

socialQueue.on('failed', (job, err) => {
  console.error(`❌ Social keywords job failed for user ${job.data.userId}:`, err.message);
});

reviewQueue.on('failed', (job, err) => {
  console.error(`❌ Review keywords job failed for user ${job.data.userId}:`, err.message);
});

// Clean up function for graceful shutdown
async function closeQueues() {
  await generalQueue.close();
  await socialQueue.close();
  await reviewQueue.close();
}

process.on('SIGTERM', closeQueues);
process.on('SIGINT', closeQueues);

//console.log('👷 Keyword workers started and listening for process-keywords jobs...');

// Export for testing/manual control
module.exports = {
  generalQueue,
  socialQueue,
  reviewQueue,
  closeQueues
};