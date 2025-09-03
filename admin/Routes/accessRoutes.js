const express = require('express');
const router = express.Router();

const {
  suspendUserAccount,
  deleteUserAccount,
  unsuspendUserAccount
} = require('../controllers/accessController');

const { protectAdmin, requireAdmin, requireGlobalAdmin } = require('../middlewares/adminAuthMiddleware');

router.post('/suspend',   protectAdmin, requireAdmin,        suspendUserAccount);
router.post('/unsuspend', protectAdmin, requireAdmin,        unsuspendUserAccount);
router.post('/delete',    protectAdmin, requireGlobalAdmin,  deleteUserAccount);

module.exports = router;
