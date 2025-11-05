// services/emailQueue.js

require('dotenv').config();
const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const email = require('./email');

const redisOpts = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};


const makeConn = () => new IORedis(process.env.REDIS_URL, redisOpts);

const emailQueue   = new Queue('email',      { connection: makeConn() });
const emailEvents  = new QueueEvents('email',{ connection: makeConn() });

emailEvents.on('failed',   ({ jobId, failedReason }) => console.error('[emailQueue] job failed', jobId, failedReason));
emailEvents.on('completed',({ jobId }) => console.log('[emailQueue] job completed', jobId));

async function enqueueEmail(template, payload) {
  return emailQueue.add(template, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: 1000,
    removeOnFail: 500,
  });
}

if (process.env.EMAIL_WORKER_ENABLED !== '0') {
  new Worker(
    'email',
    async job => {
      switch (job.name) {
        case 'invite':           return email.sendInviteEmail(job.data);
        case 'onboarding':       return email.sendOnboardingEmail(job.data);
        case 'reset':            return email.sendPasswordResetEmail(job.data);
        case 'complaint_ack':    return email.sendComplaintAckEmail(job.data);
        case 'complaint_notify': return email.sendComplaintNotifyEmail(job.data);
        case 'contact_ack':      return email.sendContactAckEmail(job.data);
        case 'contact_notify':   return email.sendContactNotifyEmail(job.data);
        case 'ai_summary_report':return email.sendAiSummaryEmail(job.data);
        default: throw new Error(`Unknown email template: ${job.name}`);
      }
    },
    { connection: makeConn() }
  );
}

module.exports = { enqueueEmail };