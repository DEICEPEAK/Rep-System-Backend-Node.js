// middlewares/languageDetectionWorker.js
require('dotenv').config();
const cron = require('node-cron');
const pool = require('../db/pool');
const { makeGeminiClient } = require('../services/geminiClientImpl');

// Initialize Gemini client
const geminiClient = makeGeminiClient({ apiKey: process.env.GEMINI_API_KEY });

// Configuration
const BATCH_LIMIT = Number(process.env.LANG_DETECTION_BATCH_LIMIT) || 50;
const DETECTION_TIMEOUT_MS = Number(process.env.LANG_DETECTION_TIMEOUT_MS) || 10000;

// Tables and their text fields to process
const SOURCES = [
  { 
    table: 'tiktok_posts', 
    pk: 'post_id', 
    fields: ['caption'],
    textField: 'caption'
  },
  { 
    table: 'youtube_data', 
    pk: 'video_id', 
    fields: ['title', 'description'],
    textField: 'title' // We'll combine fields
  },
  { 
    table: 'instagram_mentions', 
    pk: 'post_id', 
    fields: ['caption'],
    textField: 'caption'
  },
  { 
    table: 'twitter_mentions', 
    pk: 'tweet_id', 
    fields: ['text'],
    textField: 'text'
  },
  { 
    table: 'reddit_posts', 
    pk: 'id', 
    fields: ['title', 'full_review'],
    textField: 'title' // We'll combine fields
  },
  { 
    table: 'facebook_posts', 
    pk: 'post_id', 
    fields: ['message'],
    textField: 'message'
  },
  { 
    table: 'linkedin_posts', 
    pk: 'id', 
    fields: ['text'],
    textField: 'text'
  },
  { 
    table: 'trustpilot_reviews', 
    pk: 'id', 
    fields: ['review_title', 'review_body'],
    textField: 'review_title' // We'll combine fields
  },
  { 
    table: 'feefo_reviews', 
    pk: 'id', 
    fields: ['service_review', 'product_review'],
    textField: 'service_review' // We'll combine fields
  },
  { 
    table: 'google_maps_reviews', 
    pk: 'id', 
    fields: ['review_text'],
    textField: 'review_text'
  }
];

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function combineTextFields(row, fields) {
  const texts = fields
    .map(field => row[field])
    .filter(text => text && typeof text === 'string' && text.trim().length > 0);
  
  return texts.join('. ').trim();
}

function trimText(text, maxLength = 2000) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength);
}

async function detectLanguageForBatch() {
//  console.log('Starting language detection batch processing...');
  let totalProcessed = 0;
  let totalErrors = 0;

  for (const source of SOURCES) {
    const { table, pk, fields } = source;
    
    try {
      // Get records with null lan_detected
      const { rows } = await pool.query(
        `SELECT ${pk}, ${fields.map(f => `"${f}"`).join(', ')} 
         FROM ${table} 
         WHERE lan_detected IS NULL 
         LIMIT $1`,
        [BATCH_LIMIT]
      );

     // console.log(`[${table}] Found ${rows.length} records to process`);

      let processed = 0;
      let errors = 0;

      for (const row of rows) {
        try {
          const combinedText = combineTextFields(row, fields);
          
          if (!combinedText) {
            // If no text content, mark as 'unknown'
            await pool.query(
              `UPDATE ${table} SET lan_detected = 'unknown' WHERE ${pk} = $1`,
              [row[pk]]
            );
            processed++;
            continue;
          }

          const trimmedText = trimText(combinedText);
          
          // Use Gemini to detect language
          const result = await geminiClient.detectLanguage(trimmedText);
          
          if (result.ok) {
            await pool.query(
              `UPDATE ${table} SET lan_detected = $1 WHERE ${pk} = $2`,
              [result.languageCode, row[pk]]
            );
            processed++;
          } else {
            console.error(`Language detection failed for ${table} ${row[pk]}:`, result.message);
            errors++;
            
            // Mark as 'unknown' on failure
            await pool.query(
              `UPDATE ${table} SET lan_detected = 'unknown' WHERE ${pk} = $1`,
              [row[pk]]
            );
          }

          // Rate limiting - small delay between API calls
          await sleep(500);

        } catch (error) {
          console.error(`Error processing ${table} ${row[pk]}:`, error.message);
          errors++;
        }
      }

     // console.log(`[${table}] Processed: ${processed}, Errors: ${errors}`);
      totalProcessed += processed;
      totalErrors += errors;

    } catch (error) {
      console.error(`Error processing table ${table}:`, error.message);
      totalErrors++;
    }
  }

//  console.log(`Language detection batch completed. Total processed: ${totalProcessed}, Total errors: ${totalErrors}`);
  return { totalProcessed, totalErrors };
}

// Schedule the job to run every 15 minutes
cron.schedule('*/15 * * * *', async () => {
//  console.log('🔄 Running scheduled language detection...');
  try {
    await detectLanguageForBatch();
  } catch (error) {
    console.error('Language detection cron job failed:', error);
  }
});

// Export for manual execution
module.exports = {
  detectLanguageForBatch,
  startLanguageDetectionWorker: () => {
   console.log('🚀 Language detection worker started (runs every 15 minutes)');
  }
};