// routes/businessDetailsRoutes.js
const express = require('express');
const router = express.Router();
const {createBusinessDetails, editBusinessDetails, getBusinessRegistrationPct, getMyCompany} = require('../controllers/businessDetailsController');

const { protect } = require('../middlewares/authMiddleware');

// all analytics endpoints require a valid JWT:
router.use(protect);


// Set initial business details
router.post('/create-bus-details', createBusinessDetails);

// Edit existing business details
router.put('/edit-bus-details', editBusinessDetails);

// Get registration % (how many of the 6 fields are filled)
router.get('/completion%', getBusinessRegistrationPct);

// Get companu name by user
router.get('/company-name', getMyCompany);

module.exports = router;