// services/geminiClientImpl.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

function makeGeminiClient({ apiKey, defaultModel = 'gemini-1.5-flash' } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    /**
     * Translate text with a tight, “translate-only” prompt.
     * options: { targetLang, domain, formality, timeoutMs, temperature, preserveEmojis, requestId }
     */
    async translate(text, options) {
      const t0 = Date.now();

      // System prompt: keep it strict to avoid extra commentary
      const sys = [
        `You are a professional translator.`,
        `Translate the user text to ${options.targetLang}.`,
        `Preserve meaning, tone, brand/product names, URLs and emojis.`,
        `Return ONLY the translated text — no preface, no quotes.`
      ].join(' ');

      // Bind the system instruction at model creation (cleaner than mixing with user text)
      const model = genAI.getGenerativeModel({
        model: defaultModel,
        systemInstruction: sys
      });

      const payload = {
        contents: [
          { role: 'user', parts: [{ text }] }
        ],
        generationConfig: {
          temperature: options.temperature ?? 0.1
        }
      };

      const timeoutMs = options.timeoutMs ?? 10_000;

      // Enforce timeout even if the SDK doesn't honor AbortSignals
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

      // Usage may appear as usageMetadata or usage depending on SDK version
      const usage = response?.usageMetadata || response?.usage;

      return {
        ok: true,
        translatedText: out.trim(),
        detectedLang: 'unknown', // Use provider metadata if/when exposed
        tokensIn: usage?.promptTokenCount,
        tokensOut: usage?.candidatesTokenCount ?? usage?.totalTokenCount,
        latencyMs: Date.now() - t0,
        model: defaultModel
      };
    }
  };
}

module.exports = { makeGeminiClient };