// workers/processors/baseProcessor.js
const pool = require('../../db/pool');
const { makeGeminiClient } = require('../../services/geminiClientImpl');

class BaseKeywordProcessor {
  constructor(sourceType) {
    this.sourceType = sourceType;
    this.geminiClient = makeGeminiClient({ apiKey: process.env.GEMINI_API_KEY });
    this.MIN_CONTENT_LENGTH = 200; 
    this.MAX_TEXT_LENGTH = 55000;  
  }

  async getUserData(userId) {
    const { rows } = await pool.query(
      `SELECT id, company_name, company_description 
       FROM users WHERE id = $1`,
      [userId]
    );
    return rows[0];
  }

  async getRecentTexts(userId, sourceType) {
    const tableConfigs = this.getTableConfigs(sourceType);
    const thirtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    
    let allTexts = [];
    
    for (const { table, dateField } of tableConfigs) {
      try {
        const { rows } = await pool.query(
          `SELECT eng_translated 
           FROM ${table} 
           WHERE company_name = (SELECT company_name FROM users WHERE id = $1)
           AND ${dateField} >= $2
           AND eng_translated IS NOT NULL 
           AND eng_translated != ''
           ---AND LENGTH(eng_translated) > 10`, 
          [userId, thirtyDaysAgo]
        );
        
       
        const meaningfulTexts = rows
          .map(row => row.eng_translated)
          .filter(text => {
            const trimmed = text.trim();
            return trimmed.length > 20 && 
                   !trimmed.match(/^(http|www|@|#)/i) && 
                   trimmed.split(' ').length > 3; 
          });
        
        allTexts.push(...meaningfulTexts);
      } catch (error) {
        console.error(`Error fetching from ${table}:`, error.message);
        // Continue with other tables
      }
    }
    
    // Join with ". " but limit total length to avoid token limits
    const combined = allTexts.join('. ');
    return combined.length > this.MAX_TEXT_LENGTH 
      ? combined.substring(0, this.MAX_TEXT_LENGTH) + "..." 
      : combined;
  }

  async callGeminiForKeywords(companyData, combinedTexts) {
    if (!combinedTexts || combinedTexts.trim().length === 0) {
      return null;
    }

    const systemInstruction = `
You are a business intelligence analyst specializing in customer feedback analysis.
Your task is to extract the most meaningful keywords and phrases from customer content.

Analyze the provided company information and customer content to identify:
1. Main customer concerns or pain points
2. Positive feedback themes  
3. Product/service features mentioned
4. Common topics of discussion

Return ONLY a valid JSON array of exactly 5 strings, no other text or explanation.
Example: ["slow_withdrawal_process", "helpful_customer_support", "mobile_app_bugs", "competitive_pricing", "easy_platform_use"]
    `;

    const prompt = this.buildPrompt(companyData, combinedTexts);
    
    try {
      const result = await this.geminiClient.generateText(prompt, systemInstruction, {
        maxOutputTokens: 500,
        temperature: 0.1
      });
      
      if (!result.ok) {
        console.error(`Gemini API error for ${this.sourceType}:`, result.message);
        return null;
      }
      
      return this.parseGeminiResponse(result.text);
    } catch (error) {
      console.error(`Gemini call failed for ${this.sourceType}:`, error.message);
      return null;
    }
  }

  buildPrompt(companyData, combinedTexts) {
    // Limit text to stay within token limits
    const limitedTexts = combinedTexts.length > this.MAX_TEXT_LENGTH 
      ? combinedTexts.substring(0, this.MAX_TEXT_LENGTH) + "... [text truncated]"
      : combinedTexts;

    return `
COMPANY ANALYSIS REQUEST

Company Name: ${companyData.company_name}
Business Description: ${companyData.company_description}

CUSTOMER CONTENT (Last 30 Days):
${limitedTexts}

ANALYSIS INSTRUCTIONS:
Extract the 5 most meaningful keywords or short phrases that represent key themes in this customer content.
Focus on actionable insights that would help the business understand customer sentiment and priorities.
Exclude the company name "${companyData.company_name}" and generic terms.

Return ONLY a JSON array of exactly 5 strings, no other text:
["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
    `;
  }

  parseGeminiResponse(response) {
    try {
      // Clean the response - remove any markdown code blocks
      const cleanedResponse = response.replace(/```json|```/g, '').trim();
      
      // Extract JSON from response
      const jsonMatch = cleanedResponse.match(/\[.*\]/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Validate we have a proper array of strings
        if (Array.isArray(parsed) && 
            parsed.length === 5 && 
            parsed.every(item => typeof item === 'string' && item.trim().length > 0)) {
          return parsed;
        }
      }
      throw new Error('Invalid response format from Gemini');
    } catch (error) {
      console.error('Failed to parse Gemini response:', response);
      
      return null;
    }
  }

  async saveResults(userId, keywords) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); 
    const today = new Date().toISOString().split('T')[0]; 
    
    try {
      await pool.query(
        `INSERT INTO keyword_cache (user_id, source_type, keywords, processed_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, source_type, processed_at) 
         DO UPDATE SET 
           keywords = EXCLUDED.keywords, 
           expires_at = EXCLUDED.expires_at`,
        [userId, this.sourceType, JSON.stringify(keywords), today, expiresAt]
      );

      
      const column = `${this.sourceType}_keyword_fetched`;
      await pool.query(
        `UPDATE users SET ${column} = NOW() WHERE id = $1`,
        [userId]
      );

     // console.log(`✅ Saved ${this.sourceType} keywords for user: ${userId}`);
    } catch (error) {
      console.error(`❌ Error saving ${this.sourceType} keywords for user ${userId}:`, error);
      throw error;
    }
  }

  async process(userId) {
    try {
      //console.log(`Processing ${this.sourceType} keywords for user: ${userId}`);
      
      // Get user data
      const userData = await this.getUserData(userId);
      if (!userData) {
        throw new Error(`User ${userId} not found`);
      }

      // Get recent texts
      const combinedTexts = await this.getRecentTexts(userId, this.sourceType);
      
      // Check if we have enough meaningful content
      if (!combinedTexts || combinedTexts.trim().length < this.MIN_CONTENT_LENGTH) {
      //  console.log(`Insufficient content for ${this.sourceType} analysis for user: ${userId} (${combinedTexts ? combinedTexts.length : 0} chars)`);
        return { 
          success: true, 
          reason: 'insufficient_content',
          contentLength: combinedTexts ? combinedTexts.length : 0
        };
      }

      //console.log(`Processing ${combinedTexts.length} characters of text for ${this.sourceType} keywords`);

      // Call Gemini for keyword extraction
      const keywords = await this.callGeminiForKeywords(userData, combinedTexts);
      
      // Only save if we got valid, meaningful keywords
      if (keywords && 
          Array.isArray(keywords) && 
          keywords.length > 0 &&
          !keywords.some(kw => kw.includes('unavailable') || kw.includes('error') || kw.includes('retry'))) {
        
        await this.saveResults(userId, keywords);
       // console.log(`Successfully processed ${this.sourceType} keywords for user: ${userId}`, keywords);
        return { success: true, keywords };
      } else {
     //   console.log(`No valid keywords generated for ${this.sourceType} for user: ${userId}`);
        return { success: true, reason: 'no_valid_keywords_generated' };
      }
      
    } catch (error) {
      console.error(`Error processing ${this.sourceType} keywords for user ${userId}:`, error);
      
      // Don't save error states to the cache - let it retry in the next cycle
      throw error;
    }
  }
}

module.exports = BaseKeywordProcessor;