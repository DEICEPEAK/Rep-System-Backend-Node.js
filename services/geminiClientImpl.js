// services/geminiClientImpl.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Use the stable version for production
const DEFAULT_MODEL = 'gemini-2.0-flash-001';

function makeGeminiClient({ apiKey, defaultModel = DEFAULT_MODEL } = {}) {
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing - Gemini features will be disabled');
    return {
      translate: () => Promise.resolve({ 
        ok: false, 
        code: 'CONFIG_ERROR', 
        message: 'GEMINI_API_KEY not configured' 
      }),
      refineBusinessDescription: () => Promise.resolve({ 
        ok: false, 
        code: 'CONFIG_ERROR', 
        message: 'GEMINI_API_KEY not configured' 
      }),
      detectLanguage: () => Promise.resolve({ 
        ok: false, 
        code: 'CONFIG_ERROR', 
        message: 'GEMINI_API_KEY not configured' 
      }),
      translateText: () => Promise.resolve({ 
        ok: false, 
        code: 'CONFIG_ERROR', 
        message: 'GEMINI_API_KEY not configured' 
      }),
      generateText: () => Promise.resolve({ 
        ok: false, 
        code: 'CONFIG_ERROR', 
        message: 'GEMINI_API_KEY not configured' 
      })
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  // Common error handling function
  const handleGeminiError = (err, timeoutMs) => {
    if (err.code === 'ETIMEDOUT') {
      return { ok: false, code: 'TIMEOUT', message: 'Gemini request timed out', retryable: true };
    }
    const msg = String(err.message || err);
    const code = /quota|rate/i.test(msg)
      ? 'RATE_LIMIT'
      : /invalid.*model|parameter/i.test(msg)
      ? 'BAD_REQUEST'
      : 'PROVIDER_ERROR';
    const retryable = code === 'RATE_LIMIT';
    return { ok: false, code, message: msg, retryable };
  };

  return {
    /**
     * Translate text
     */
    async translate(text, options) {
      const t0 = Date.now();
      
      try {
        const sys = [
          `You are a professional translator.`,
          `Translate the user text to ${options.targetLang}.`,
          `Preserve meaning, tone, brand/product names, URLs and emojis.`,
          `Return ONLY the translated text — no preface, no quotes.`
        ].join(' ');

        const model = genAI.getGenerativeModel({
          model: defaultModel,
          systemInstruction: sys
        });

        const payload = {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { temperature: options.temperature ?? 0.1 }
        };

        const timeoutMs = options.timeoutMs ?? 10_000;
        const result = await Promise.race([
          model.generateContent(payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
          )
        ]);

        const response = result.response;
        const out = response.text() || '';

        if (!out.trim()) {
          return { ok: false, code: 'PROVIDER_ERROR', message: 'Empty response', retryable: false };
        }

        const usage = response.usageMetadata;

        return {
          ok: true,
          translatedText: out.trim(),
          detectedLang: 'unknown',
          tokensIn: usage?.promptTokenCount,
          tokensOut: usage?.candidatesTokenCount,
          latencyMs: Date.now() - t0,
          model: defaultModel
        };
      } catch (err) {
        return handleGeminiError(err, options.timeoutMs);
      }
    },

    /**
     * Detect language of text and return ISO 639-1 code
     */
    async detectLanguage(text) {
      const t0 = Date.now();
      
      try {
        const sys = [
          'You are a language detection expert.',
          'Detect the language of the provided text and return ONLY the ISO 639-1 language code.',
          'Examples: "en" for English, "es" for Spanish, "fr" for French, "de" for German, "it" for Italian, "pt" for Portuguese, "nl" for Dutch, "ru" for Russian, "ja" for Japanese, "zh" for Chinese, "ar" for Arabic.',
          'If the text is mixed or unclear, return the predominant language code.',
          'If the text is too short or cannot be determined, return "unknown".',
          'Return ONLY the 2-letter code or "unknown", nothing else.'
        ].join(' ');

        const model = genAI.getGenerativeModel({
          model: defaultModel,
          systemInstruction: sys
        });

        const payload = {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { 
            temperature: 0.1,
            maxOutputTokens: 10
          }
        };

        const timeoutMs = 10_000;
        const result = await Promise.race([
          model.generateContent(payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
          )
        ]);

        const response = result.response;
        const languageCode = response.text().trim().toLowerCase();

        // Validate the response is a 2-letter code or "unknown"
        if (!/^[a-z]{2}$|^unknown$/i.test(languageCode)) {
          return { 
            ok: false, 
            code: 'INVALID_RESPONSE', 
            message: `Invalid language code received: ${languageCode}`,
            retryable: false 
          };
        }

        const usage = response.usageMetadata;

        return {
          ok: true,
          languageCode: languageCode === 'unknown' ? 'unknown' : languageCode,
          tokensIn: usage?.promptTokenCount,
          tokensOut: usage?.candidatesTokenCount,
          latencyMs: Date.now() - t0,
          model: defaultModel
        };
      } catch (err) {
        return handleGeminiError(err, 10_000);
      }
    },

    /**
     * Translate text to English
     */
    async translateText(text, targetLang = 'en') {
      const t0 = Date.now();
      
      try {
        const sys = [
          `You are a professional translator.`,
          `Translate the user text to ${targetLang}.`,
          `Preserve the original meaning, tone, and context.`,
          `Keep brand names, product names, URLs, and technical terms unchanged.`,
          `Make the translation sound natural and fluent in ${targetLang}.`,
          `Return ONLY the translated text — no explanations, no notes, no quotes.`
        ].join(' ');

        const model = genAI.getGenerativeModel({
          model: defaultModel,
          systemInstruction: sys
        });

        const payload = {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { 
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        };

        const timeoutMs = 15_000;
        const result = await Promise.race([
          model.generateContent(payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
          )
        ]);

        const response = result.response;
        const translatedText = response.text().trim();

        if (!translatedText) {
          return { ok: false, code: 'PROVIDER_ERROR', message: 'Empty translation response', retryable: false };
        }

        const usage = response.usageMetadata;

        return {
          ok: true,
          translatedText: translatedText,
          tokensIn: usage?.promptTokenCount,
          tokensOut: usage?.candidatesTokenCount,
          latencyMs: Date.now() - t0,
          model: defaultModel
        };
      } catch (err) {
        return handleGeminiError(err, 15_000);
      }
    },

    /**
     * Refine business description
     */
    async refineBusinessDescription(options) {
      const t0 = Date.now();
      
      const {
        companyName,
        description,
        website,
        tone = 'warm, credible, professional',
        wordLimit = 120,
        timeoutMs = 15_000,
        temperature = 0.4
      } = options || {};

      if (!companyName || !description) {
        return { 
          ok: false, 
          code: 'BAD_REQUEST', 
          message: 'companyName and description are required' 
        };
      }

      try {
        const sys = [
          'You are a senior marketing copy editor for business descriptions.',
          'Rewrite the description using ONLY the information provided.',
          'Do NOT invent awards, metrics, years in business, client names, guarantees, or certifications.',
          'No buzzword salad. Prioritize clarity, real benefits, and trust.',
          `Tone: ${tone}.`,
          `Length: one paragraph, max ${wordLimit} words.`,
          'No hashtags, no emojis, no quotes. Return ONLY the refined paragraph.'
        ].join(' ');

        const model = genAI.getGenerativeModel({
          model: defaultModel,
          systemInstruction: sys
        });

        const userText = [
          `Company name: ${companyName}`,
          website ? `Website: ${website}` : '',
          'Original description:',
          '"""',
          description,
          '"""'
        ].filter(Boolean).join('\n');

        const payload = {
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            temperature,
            topP: 0.9,
            maxOutputTokens: 256
          }
        };

        const result = await Promise.race([
          model.generateContent(payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
          )
        ]);

        const response = result.response;
        const out = response.text() || '';

        if (!out.trim()) {
          return { ok: false, code: 'PROVIDER_ERROR', message: 'Empty response', retryable: false };
        }

        const usage = response.usageMetadata;

        return {
          ok: true,
          refinedText: out.trim(),
          tokensIn: usage?.promptTokenCount,
          tokensOut: usage?.candidatesTokenCount,
          latencyMs: Date.now() - t0,
          model: defaultModel
        };
      } catch (err) {
        return handleGeminiError(err, timeoutMs);
      }
    },

    /**
     * General text generation with custom system instruction
     */
    async generateText(text, systemInstruction, options = {}) {
      const t0 = Date.now();
      
      try {
        const model = genAI.getGenerativeModel({
          model: defaultModel,
          systemInstruction: systemInstruction
        });

        const payload = {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { 
            temperature: options.temperature ?? 0.1,
            maxOutputTokens: options.maxOutputTokens ?? 1000
          }
        };

        const timeoutMs = options.timeoutMs ?? 15_000;
        const result = await Promise.race([
          model.generateContent(payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
          )
        ]);

        const response = result.response;
        const generatedText = response.text().trim();

        if (!generatedText) {
          return { ok: false, code: 'PROVIDER_ERROR', message: 'Empty response', retryable: false };
        }

        const usage = response.usageMetadata;

        return {
          ok: true,
          text: generatedText,
          tokensIn: usage?.promptTokenCount,
          tokensOut: usage?.candidatesTokenCount,
          latencyMs: Date.now() - t0,
          model: defaultModel
        };
      } catch (err) {
        return handleGeminiError(err, 15_000);
      }
    }
  };
}

module.exports = { makeGeminiClient };