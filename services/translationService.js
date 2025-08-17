// services/translationService.js
const pool = require('../db/pool');
const windowsRepo = require('../repos/translationWindowsRepo');
const { fetchText } = require('./sourceResolver');
const { normalize, sha256, detectLangHeuristic } = require('./textUtil');

const QUOTA_MAX = 5;
const WINDOW_HOURS = 12;

exports.translateOnceOrLock = async (ctx) => {
  const { userId, company, body, geminiClient, requestId } = ctx;
  const targetLang = String(body.target_lang || '').toLowerCase();
  if (!targetLang) {
    const e = new Error('target_lang is required');
    e.status = 400; throw e;
  }

  // Resolve text & key
  let text, key;
  if (body.text && !body.source) {
    text = String(body.text);
    key  = { sourceTable: 'adhoc', sourceId: requestId, sourceField: 'text' };
  } else {
    const r = await fetchText(company, body.source);
    text = r.text; key = r.key;
  }

  const normalized = normalize(text);
  if (!normalized) { const e = new Error('Empty text'); e.status = 400; throw e; }
  const hash = sha256(normalized);

  // Existing active window?
  const existing = await windowsRepo.findActive(userId, key);
  if (existing) {
    if (existing.target_lang !== targetLang) {
      const e = new Error(`Language locked to ${existing.target_lang} until ${existing.expires_at.toISOString?.() || existing.expires_at}`);
      e.status = 409; e.code = 'LANGUAGE_LOCKED'; e.expires_at = existing.expires_at;
      throw e;
    }
    return {
      cached: true,
      translated_text: existing.translated_text,
      detected_lang: existing.detected_lang,
      target_lang: existing.target_lang,
      window_expires_at: existing.expires_at,
      source_ref: key
    };
  }

  // Quota check
  const activeCount = await windowsRepo.countActive(userId);
  if (activeCount >= QUOTA_MAX) {
    const at = await windowsRepo.earliestExpiry(userId);
    const e = new Error('Max 5 active reviews in 12h');
    e.status = 429; e.code = 'WINDOW_QUOTA'; e.retry_after_seconds = at ? Math.max(1, Math.floor((new Date(at) - Date.now())/1000)) : undefined;
    throw e;
  }

  // Translate (short-circuit if same lang)
  let detected = detectLangHeuristic(normalized);
  let translated = normalized;
  if (!detected || detected !== targetLang) {
    const r = await geminiClient.translate(normalized, {
      targetLang,
      domain: body.domain || 'review',
      formality: body.formality || 'default',
      preserveEmojis: body.preserve_emojis !== false,
      requestId
    });
    if (!r.ok) {
      const e = new Error(r.message || 'Translation failed');
      e.status = (r.code === 'BAD_REQUEST' || r.code === 'UNSUPPORTED_LANG') ? 400 : 503;
      e.retryable = r.retryable; throw e;
    }
    translated = r.translatedText;
    detected   = r.detectedLang || detected || 'unknown';

    // Insert window atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const expiresAt = new Date(Date.now() + WINDOW_HOURS*60*60*1000);
      const inserted = await windowsRepo.insertIfActiveUnique(client, {
        user_id: userId,
        company_name: company,
        source_table: key.sourceTable,
        source_id: key.sourceId,
        source_field: key.sourceField,
        content_hash: hash,
        target_lang: targetLang,
        detected_lang: detected,
        translated_text: translated,
        provider: 'gemini-1.5-flash',
        tokens_in: r.tokensIn || null,
        tokens_out: r.tokensOut || null,
        latency_ms: r.latencyMs || null,
        expires_at: expiresAt
      });

      if (!inserted) {
        // Race: someone inserted while we were translating—re-read and apply same rules
        const nowExisting = await windowsRepo.findActive(userId, key);
        await client.query('COMMIT');
        if (nowExisting.target_lang !== targetLang) {
          const e = new Error(`Language locked to ${nowExisting.target_lang} until ${nowExisting.expires_at}`);
          e.status = 409; e.code = 'LANGUAGE_LOCKED'; e.expires_at = nowExisting.expires_at;
          throw e;
        }
        return {
          cached: true,
          translated_text: nowExisting.translated_text,
          detected_lang: nowExisting.detected_lang,
          target_lang: nowExisting.target_lang,
          window_expires_at: nowExisting.expires_at,
          source_ref: key
        };
      }

      await client.query('COMMIT');
      return {
        cached: false,
        translated_text: translated,
        detected_lang: detected,
        target_lang: targetLang,
        window_expires_at: inserted.expires_at,
        source_ref: key
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Same language; store window with original text for consistency
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expiresAt = new Date(Date.now() + WINDOW_HOURS*60*60*1000);
    const inserted = await windowsRepo.insertIfActiveUnique(client, {
      user_id: userId,
      company_name: company,
      source_table: key.sourceTable,
      source_id: key.sourceId,
      source_field: key.sourceField,
      content_hash: hash,
      target_lang: targetLang,
      detected_lang: detected || targetLang,
      translated_text: normalized,
      provider: 'gemini-1.5-flash',
      tokens_in: null, tokens_out: null, latency_ms: 0,
      expires_at: expiresAt
    });
    await client.query('COMMIT');
    return {
      cached: false,
      translated_text: normalized,
      detected_lang: detected || targetLang,
      target_lang: targetLang,
      window_expires_at: inserted ? inserted.expires_at : new Date(Date.now() + WINDOW_HOURS*60*60*1000),
      source_ref: key
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};
