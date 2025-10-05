// services/emailQueue.js
require('dotenv').config();
const { Queue, Worker, QueueEvents } = require('bullmq');
const email = require('./email');

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const emailQueue = new Queue('email', { connection });

const emailEvents = new QueueEvents('email', { connection });
emailEvents.on('failed', ({ jobId, failedReason }) =>
  console.error('[emailQueue] job failed', jobId, failedReason)
);
emailEvents.on('completed', ({ jobId }) =>
  console.log('[emailQueue] job completed', jobId)
);

/**
 * Enqueue an email by template name and payload
 * Supported templates:
 *   - invite
 *   - onboarding
 *   - reset
 *   - complaint_ack
 *   - complaint_notify
 *   - contact_ack
 *   - contact_notify
 *   - ai_summary_report      // ⬅ NEW
 */
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
        case 'invite':
          return email.sendInviteEmail(job.data);
        case 'onboarding':
          return email.sendOnboardingEmail(job.data);
        case 'reset':
          return email.sendPasswordResetEmail(job.data);

        // Support workflows
        case 'complaint_ack':
          return email.sendComplaintAckEmail(job.data);
        case 'complaint_notify':
          return email.sendComplaintNotifyEmail(job.data);
        case 'contact_ack':
          return email.sendContactAckEmail(job.data);
        case 'contact_notify':
          return email.sendContactNotifyEmail(job.data);

        // NEW: AI summary report
        case 'ai_summary_report':
          return email.sendAiSummaryEmail(job.data);

        default:
          throw new Error(`Unknown email template: ${job.name}`);
      }
    },
    { connection }
  );
}

module.exports = { enqueueEmail };
