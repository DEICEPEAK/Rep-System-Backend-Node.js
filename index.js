// index.js
const express = require('express');
const cors    = require('cors');
const config  = require('./config');
require('dotenv').config();

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

const geminiClient = makeGeminiClient({ apiKey: process.env.GEMINI_API_KEY });


const app = express();

// 1) CORS _before_ everything else
const allowedOrigins = [
  'https://velvety-sunshine-d944db.netlify.app',
  'http://localhost:5173'        
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

// 2) Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

sentimentMiddleware();
// 3) Your routes
app.use('/api/auth',   authRoute);
app.use('/api/metrics', metricsRoute);
app.use('/api/review', reviewRoutes);
app.use('/api/social-media', socialMediaAnalyticsRoute);
app.use('/api/video', videoContentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/keyword', keywordRoutes);
app.use('/api/translation', translationRoutes);

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
