// services/textUtil.js
const crypto = require('crypto');

exports.normalize = (s) =>
  s.replace(/\s+/g, ' ').trim();

exports.sha256 = (s) =>
  crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Simple heuristic detector (optional). You can skip if relying on provider detection.
exports.detectLangHeuristic = (s) => null; // return e.g. 'en' or null to defer