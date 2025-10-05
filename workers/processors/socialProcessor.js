// workers/processors/socialProcessor.js
const BaseKeywordProcessor = require('./baseProcessor');

class SocialProcessor extends BaseKeywordProcessor {
  constructor() {
    super('social');
  }

  getTableConfigs() {
    return [
      { table: 'tiktok_posts', dateField: 'created_at' },
      { table: 'linkedin_posts', dateField: 'posted_at_iso' },
      { table: 'facebook_posts', dateField: 'created_at' },
      { table: 'twitter_mentions', dateField: 'created_at' },
      { table: 'instagram_mentions', dateField: 'created_at' },
      { table: 'youtube_data', dateField: 'published_at' }
    ];
  }
}

const processSocialKeywords = async (jobData) => {
  const processor = new SocialProcessor();
  return await processor.process(jobData.userId);
};

module.exports = { SocialProcessor, processSocialKeywords };