// index.js
const express = require('express');
const cors    = require('cors');
const config  = require('./config');
require('dotenv').config();

const metricsRoute = require('./routes/metricsRoutes');
const authRoute    = require('./routes/authRoutes');

const app = express();

// 1) CORS _before_ everything else
app.use(cors({
  origin: ['https://velvety-sunshine-d944db.netlify.app'], 
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

// 2) Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3) Your routes
app.use('/api/auth',   authRoute);
app.use('/api/metrics', metricsRoute);

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
