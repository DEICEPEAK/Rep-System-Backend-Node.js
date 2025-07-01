// routes/profileRoutes.js

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/profileController');

router.get(  '/',                   protect, ctrl.viewProfile);
router.put(  '/edit-business-details',   protect, ctrl.editBusinessDetails);
router.put(  '/change-password',    protect, ctrl.changePassword);
router.get(  '/completed-info',     protect, ctrl.completedInfo);

// Get companu name by user
router.get('/company-name', protect, ctrl.getMyCompany);

module.exports = router;