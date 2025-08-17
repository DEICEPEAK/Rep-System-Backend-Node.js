// geminiClient.d.ts
export type TranslateOptions = {
  targetLang: string;                 // 'fr', 'pt-BR'
  domain?: 'general'|'review'|'social';
  formality?: 'default'|'formal'|'informal';
  timeoutMs?: number;                 // default 10000
  temperature?: number;               // default 0.1
  preserveEmojis?: boolean;           // default true
  requestId?: string;
};

export type TranslateResult =
  | { ok: true; translatedText: string; detectedLang: string; tokensIn?: number; tokensOut?: number; latencyMs: number; model: 'gemini-1.5-flash'; }
  | { ok: false; code: 'TIMEOUT'|'RATE_LIMIT'|'PROVIDER_ERROR'|'UNSUPPORTED_LANG'|'BAD_REQUEST'; message: string; retryable: boolean; };

export interface GeminiClient {
  translate(text: string, options: TranslateOptions): Promise<TranslateResult>;
}
