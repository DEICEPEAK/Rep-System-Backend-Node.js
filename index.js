// index.js
const express = require('express');
const config = require('./config');
require('dotenv').config();

const metricsRoute = require('./routes/metricsRoutes');
const authRoute    = require('./routes/authRoutes');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// mount...
app.use('/api/auth',  authRoute);
app.use('/api/metrics', metricsRoute);
app.get('/health', (_,res) => res.send({ status: 'ok', env: config.env }));

// start the server


app.listen(config.port, () => {
  console.log(`🚀 Server running in ${config.env} on port ${config.port}`);
});


// after all routes...
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
