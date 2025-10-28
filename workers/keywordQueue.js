// workers/keywordQueue.js

require('dotenv').config();
const Queue = require('bull');
const IORedis = require('ioredis');

const redisUrl = process.env.REDIS_URL;
const common = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const opts = {
  createClient: (type) => new IORedis(redisUrl, common)
};

const generalQueue = new Queue('general keywords', opts);
const socialQueue  = new Queue('social keywords',  opts);
const reviewQueue  = new Queue('review keywords',  opts);

module.exports = {
  generalQueue,
  socialQueue,
  reviewQueue,
  allQueues: [generalQueue, socialQueue, reviewQueue]
};