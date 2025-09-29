// admin/Routes/impersonationRoutes.js


const express = require('express');
const router = express.Router();
const { protectAdmin, requireAdmin } = require('../middlewares/adminAuthMiddleware');
const { startImpersonation } = require('../controllers/adminImpersonationController');

router.post('/impersonations', protectAdmin, requireAdmin, startImpersonation);

module.exports = router;
