// workers/keywordQueue.js
const Queue = require('bull');

// Create Redis connection
const redisConfig = {
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  }
};

// Three separate queues for better control
const generalQueue = new Queue('general keywords', redisConfig);
const socialQueue = new Queue('social keywords', redisConfig);
const reviewQueue = new Queue('review keywords', redisConfig);

// Export all queues
module.exports = {
  generalQueue,
  socialQueue,
  reviewQueue,
  allQueues: [generalQueue, socialQueue, reviewQueue]
};