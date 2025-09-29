// index.js
require('dotenv').config(); // load env FIRST

const express = require('express');
const cors    = require('cors');
const config  = require('./config');

const sentimentMiddleware = require('./middlewares/sentimentMiddleware');
const { recheckSentimentWithGemini } = require('./middlewares/geminiSentimentRecheck');
const metricsRoute = require('./routes/metricsRoutes');
const authRoute    = require('./routes/authRoutes');
const reviewRoutes = require('./routes/reviewRoutes'); 
const socialMediaAnalyticsRoute = require('./routes/socialMediaAnalyticsRoutes');
const videoContentRoutes =  require('./routes/videoContentRoutes');
const profileRoutes = require('./routes/profileRoutes');
const keywordRoutes = require('./routes/keywordRoutes'); 
const translationRoutes = require('./routes/translationRoutes'); 
const { makeGeminiClient } = require('./services/geminiClientImpl');
const { startTokenJanitorCron } = require('./services/tokenJanitor');
const impersonationRoutes = require('./routes/impersonationRoutes');
const impersonationGate = require('./middlewares/impersonationGate');
const impersonationAudit = require('./middlewares/impersonationAudit');
const supportRoutes = require('./routes/supportRoutes');
const { startSupportProcessingCron } = require('./middlewares/supportProcessing');











const geminiClient = makeGeminiClient({ apiKey: process.env.GEMINI_API_KEY });

// Safety nets (Node 22 stricter about async errors)
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// admin
const adminAuthRoute = require('./admin/Routes/adminAuthRoutes');
const adminDashboardRoutes = require('./admin/Routes/adminDashboardRoutes');
const {startUnsuspendCron} = require('./admin/middlewares/unsuspendCron');
const accessRoutes = require('./admin/Routes/accessRoutes');
const adminImpersonationRoutes = require('./admin/Routes/impersonationRoutes');



startUnsuspendCron();
startTokenJanitorCron();
startSupportProcessingCron();


const app = express();

// 1) CORS _before_ everything else
// index.js
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // non-browser clients
    return cb(null, allowedOrigins.includes(origin));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));


// 2) Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Optional: run once at boot without crashing the process
if (process.env.SENTIMENT_RUN_ON_BOOT === '1') {
  sentimentMiddleware().catch(e =>
    console.error('Initial sentiment run failed:', e.message)
  );
}





// 3) Your routes
app.use('/api/auth',   authRoute);
app.use('/api/auth/imp', impersonationRoutes);
app.use('/api/metrics', metricsRoute);
app.use('/api/review', reviewRoutes);
app.use('/api/social-media', socialMediaAnalyticsRoute);
app.use('/api/video', videoContentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/keyword', keywordRoutes);
app.use('/api/translation', translationRoutes);
app.use('/api/support', supportRoutes);

// ADMIN
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/auth', adminAuthRoute);
app.use('/api/admin/access', accessRoutes);
app.use('/api/admin/imp', adminImpersonationRoutes);
app.use(impersonationGate);
app.use(impersonationAudit);

app.set('geminiClient', geminiClient);

// 4) Health check
app.get('/health', (_, res) => 
  res.send({ status: 'ok', env: config.env })
);

// 5) Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// 6) Start
app.listen(config.port, () => {
  console.log(`🚀 Server running in ${config.env} on port ${config.port}`);
});
