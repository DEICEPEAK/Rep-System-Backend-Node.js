// workers/processors/generalProcessor.js
const BaseKeywordProcessor = require('./baseProcessor');

class GeneralProcessor extends BaseKeywordProcessor {
  constructor() {
    super('general');
  }

  getTableConfigs() {
    return [
      { table: 'google_maps_reviews', dateField: 'review_date' },
      { table: 'trustpilot_reviews', dateField: 'review_date' },
      { table: 'feefo_reviews', dateField: 'review_date' },
      { table: 'reddit_posts', dateField: 'review_date' },
      { table: 'tiktok_posts', dateField: 'created_at' },
      { table: 'linkedin_posts', dateField: 'posted_at_iso' },
      { table: 'facebook_posts', dateField: 'created_at' },
      { table: 'twitter_mentions', dateField: 'created_at' },
      { table: 'instagram_mentions', dateField: 'created_at' },
      { table: 'youtube_data', dateField: 'published_at' }
    ];
  }
}

// Fix the export to properly handle the job data
const processGeneralKeywords = async (jobData) => {
  const processor = new GeneralProcessor();
  return await processor.process(jobData.userId);
};

module.exports = { GeneralProcessor, processGeneralKeywords };