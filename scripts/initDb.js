// services/geminiClientImpl.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

function makeGeminiClient({ apiKey, defaultModel = 'gemini-1.5-flash' } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    /**
     * Translate (already in your file) ...
     */
    async translate(text, options) {
      const t0 = Date.now();
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
      const sdkCall = model.generateContent(payload);
      let result;
      try {
        result = await Promise.race([
          sdkCall,
          new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('Gemini request timed out'), { code: 'ETIMEDOUT' })), timeoutMs)
          )
        ]);
      } catch (err) {
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
      }

      const response = result?.response;
      const out =
        (typeof response?.text === 'function' ? response.text() : '') ||
        response?.candidates?.[0]?.content?.parts?.[0]?.text ||
        '';

      if (!out || !out.trim()) {
        return { ok: false, code: 'PROVIDER_ERROR', message: 'Empty response', retryable: false };
      }

      const usage = response?.usageMetadata || response?.usage;

      return {
        ok: true,
        translatedText: out.trim(),
        detectedLang: 'unknown',
        tokensIn: usage?.promptTokenCount,
        tokensOut: usage?.candidatesTokenCount ?? usage?.totalTokenCount,
        latencyMs: Date.now() - t0,
        model: defaultModel
      };
    },

    /**
     * Refine a company's public-facing description.
     * options: { companyName, description, website, tone, wordLimit, timeoutMs, temperature, requestId }
     */
    async refineBusinessDescription(options) {
      const {
        companyName,
        description,
        website,
        tone = 'concise, plain-English, benefit-led, trustworthy, professional',
        wordLimit = 110,
        timeoutMs = 10_000,
        temperature = 0.4
      } = options || {};

      if (!companyName) return { ok: false, code: 'BAD_REQUEST', message: 'companyName required', retryable: false };
      if (!description) return { ok: false, code: 'BAD_REQUEST', message: 'description required', retryable: false };

      const t0 = Date.now();

      // Strict system guardrails to avoid hallucinated claims.
      const sys = [
        'You are a senior marketing copy editor for a business reputation page.',
        'Rewrite the description using ONLY the information provided by the user.',
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

      // Stuff we let the model see
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

      const sdkCall = model.generateContent(payload);
      let result;
      try {
        result = await Promise.race([
          sdkCall,
          new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('Gemini request timed out'), { code: 'ETIMEDOUT' })), timeoutMs)
          )
        ]);
      } catch (err) {
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
      }

      const response = result?.response;
      const out =
        (typeof response?.text === 'function' ? response.text() : '') ||
        response?.candidates?.[0]?.content?.parts?.[0]?.text ||
        '';

      if (!out || !out.trim()) {
        return { ok: false, code: 'PROVIDER_ERROR', message: 'Empty response', retryable: false };
      }

      const usage = response?.usageMetadata || response?.usage;

      return {
        ok: true,
        refinedText: out.trim(),
        tokensIn: usage?.promptTokenCount,
        tokensOut: usage?.candidatesTokenCount ?? usage?.totalTokenCount,
        latencyMs: Date.now() - t0,
        model: defaultModel
      };
    }
  };
}

module.exports = { makeGeminiClient };