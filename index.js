// index.js
const express = require('express');
const cors = require('cors');
const config = require('./config');
require('dotenv').config();

const metricsRoute = require('./routes/metricsRoutes');
const authRoute    = require('./routes/authRoutes');

const app = express();

// 1) Enable CORS _before_ your routes
app.use(cors({
  origin: ['https://your-frontend.vercel.app'],  // or '*' while in dev
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  credentials: true
}));

// 2) Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3) Mount your routes
app.use('/api/auth',   authRoute);
app.use('/api/metrics', metricsRoute);

// 4) Healthcheck
app.get('/health', (_, res) =>
  res.send({ status: 'ok', env: config.env })
);

// 5) Error handler (after all routes)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// 6) Start the server
app.listen(config.port, () => {
  console.log(`🚀 Server running in ${config.env} on port ${config.port}`);
});
