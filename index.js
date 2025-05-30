// index.js
const express = require('express');
const cors    = require('cors');
const config  = require('./config');
require('dotenv').config();

const metricsRoute = require('./routes/metricsRoutes');
const authRoute    = require('./routes/authRoutes');

const app = express();


const allowedOrigins = [
  'https://velvety-sunshine-d944db.netlify.app'
];


app.options('*', cors({
  origin: allowedOrigins,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type','Authorization']
}));



app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth',   authRoute);
app.use('/api/metrics', metricsRoute);


app.get('/health', (_, res) =>
  res.send({ status: 'ok', env: config.env })
);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});


app.listen(config.port, () => {
  console.log(`🚀 Server running in ${config.env} on port ${config.port}`);
});
