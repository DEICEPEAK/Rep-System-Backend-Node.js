// middlewares/translationWorker.js
require('dotenv').config();
const cron = require('node-cron');
const pool = require('../db/pool');
const { makeGeminiClient } = require('../services/geminiClientImpl');

// Initialize Gemini client
const geminiClient = makeGeminiClient({ apiKey: process.env.GEMINI_API_KEY });

// Configuration
const BATCH_LIMIT = Number(process.env.TRANSLATION_BATCH_LIMIT) || 50;
const TRANSLATION_TIMEOUT_MS = Number(process.env.TRANSLATION_TIMEOUT_MS) || 15000;

// Same table configuration as language detection
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
    textField: 'title'
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
    textField: 'title'
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
    textField: 'review_title'
  },
  { 
    table: 'feefo_reviews', 
    pk: 'id', 
    fields: ['service_review', 'product_review'],
    textField: 'service_review'
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

async function translateTextForBatch() {
  //console.log('Starting translation batch processing...');
  let totalProcessed = 0;
  let totalSkippedEnglish = 0;
  let totalErrors = 0;

  for (const source of SOURCES) {
    const { table, pk, fields } = source;
    
    try {
      // Get records that have language detected but not translated, excluding English
      const { rows } = await pool.query(
        `SELECT ${pk}, ${fields.map(f => `"${f}"`).join(', ')}, lan_detected 
         FROM ${table} 
         WHERE lan_detected IS NOT NULL 
         AND eng_translated IS NULL 
         AND lan_detected != 'en'
         AND lan_detected != 'unknown'
         LIMIT $1`,
        [BATCH_LIMIT]
      );

    //  console.log(`[${table}] Found ${rows.length} non-English records to translate`);

      let processed = 0;
      let errors = 0;

      for (const row of rows) {
        try {
          const combinedText = combineTextFields(row, fields);
          
          if (!combinedText) {
            // If no text content, mark as empty
            await pool.query(
              `UPDATE ${table} SET eng_translated = '' WHERE ${pk} = $1`,
              [row[pk]]
            );
            processed++;
            continue;
          }

          const trimmedText = trimText(combinedText);
          
          // Use Gemini to translate to English
          const result = await geminiClient.translateText(trimmedText, 'en');
          
          if (result.ok) {
            await pool.query(
              `UPDATE ${table} SET eng_translated = $1 WHERE ${pk} = $2`,
              [result.translatedText, row[pk]]
            );
            processed++;
          } else {
            console.error(`Translation failed for ${table} ${row[pk]}:`, result.message);
            errors++;
            
            // Mark as failed but don't retry indefinitely
            await pool.query(
              `UPDATE ${table} SET eng_translated = '' WHERE ${pk} = $1`,
              [row[pk]]
            );
          }

          // Rate limiting - small delay between API calls
          await sleep(500);

        } catch (error) {
          console.error(`Error translating ${table} ${row[pk]}:`, error.message);
          errors++;
        }
      }

    //  console.log(`[${table}] Translated: ${processed}, Errors: ${errors}`);
      totalProcessed += processed;
      totalErrors += errors;

    } catch (error) {
     // console.error(`Error processing table ${table} for translation:`, error.message);
      totalErrors++;
    }
  }

  // Now handle English records - copy original text to eng_translated
  await processEnglishRecords();
  
//  console.log(`Translation batch completed. Total translated: ${totalProcessed}, Total errors: ${totalErrors}, English records copied: ${totalSkippedEnglish}`);
  return { totalProcessed, totalErrors, totalSkippedEnglish };
}

async function processEnglishRecords() {
//  console.log('Processing English records (copying to eng_translated)...');
  let totalEnglishProcessed = 0;

  for (const source of SOURCES) {
    const { table, pk, fields } = source;
    
    try {
      // Get English records that haven't been copied to eng_translated
      const { rows } = await pool.query(
        `SELECT ${pk}, ${fields.map(f => `"${f}"`).join(', ')} 
         FROM ${table} 
         WHERE lan_detected = 'en' 
         AND eng_translated IS NULL
         LIMIT $1`,
        [BATCH_LIMIT * 2] // Process more English records since it's just copying
      );

      if (rows.length > 0) {
        for (const row of rows) {
          const combinedText = combineTextFields(row, fields);
          
          await pool.query(
            `UPDATE ${table} SET eng_translated = $1 WHERE ${pk} = $2`,
            [combinedText || '', row[pk]]
          );
        }
        
      //  console.log(`[${table}] Copied ${rows.length} English records to eng_translated`);
        totalEnglishProcessed += rows.length;
      }
    } catch (error) {
      console.error(`Error processing English records for ${table}:`, error.message);
    }
  }

//  console.log(`Total English records processed: ${totalEnglishProcessed}`);
  return totalEnglishProcessed;
}

// Schedule the job to run every 15 minutes
cron.schedule('*/15 * * * *', async () => {
//  console.log('🔄 Running scheduled translation...');
  try {
    await translateTextForBatch();
  } catch (error) {
    console.error('Translation cron job failed:', error);
  }
});

// Export for manual execution
module.exports = {
  translateTextForBatch,
  processEnglishRecords,
  startTranslationWorker: () => {
  console.log('🚀 Translation worker started (runs every 15 minutes)');
  }
};