// workers/processors/reviewProcessor.js
const BaseKeywordProcessor = require('./baseProcessor');

class ReviewProcessor extends BaseKeywordProcessor {
  constructor() {
    super('review');
  }

  getTableConfigs() {
    return [
      { table: 'google_maps_reviews', dateField: 'review_date' },
      { table: 'trustpilot_reviews', dateField: 'review_date' },
      { table: 'feefo_reviews', dateField: 'review_date' },
      { table: 'reddit_posts', dateField: 'review_date' }
    ];
  }
}

const processReviewKeywords = async (jobData) => {
  const processor = new ReviewProcessor();
  return await processor.process(jobData.userId);
};

module.exports = { ReviewProcessor, processReviewKeywords };