/**
 * File: /admin/middlewares/adminAuth.js
 * Middlewares:
 *  - protectAdmin: verifies admin JWT and attaches req.admin = { adminId, role }
 *  - requireAdmin: allows "admin" or "global_admin"
 *  - requireGlobalAdmin: only "global_admin"
 */

const jwt = require('jsonwebtoken');
require('dotenv').config();

const ADMIN_ROLES = new Set(['admin', 'global_admin']);

function getJwtSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
}

exports.protectAdmin = (req, res, next) => {
  let token = null;

  // Expect header: Authorization: Bearer <token>
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authorized, no token.' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    // Basic sanity: ensure these admin claims exist
    if (!decoded.adminId || !decoded.role) {
      return res.status(401).json({ error: 'Invalid admin token.' });
    }

    req.admin = { adminId: decoded.adminId, role: decoded.role };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Not authorized, token failed.' });
  }
};

// Allows any admin role (admin or global_admin)
exports.requireAdmin = (req, res, next) => {
  if (!req.admin || !ADMIN_ROLES.has(req.admin.role)) {
    return res.status(403).json({ error: 'Forbidden: admin access required.' });
  }
  return next();
};

// Only global_admin
exports.requireGlobalAdmin = (req, res, next) => {
  if (!req.admin || req.admin.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: global_admin access required.' });
  }
  return next();
};
