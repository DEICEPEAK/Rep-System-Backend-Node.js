// src/config/index.js
const Joi = require('joi');
require('dotenv').config();

const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development','staging','production').default('development'),
  PORT: Joi.number().default(4000),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USER: Joi.string().required(),
  DB_PASS: Joi.string().required(),
  DB_NAME: Joi.string().required(),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),

  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().required(),
  SMTP_USER: Joi.string().required(),
  SMTP_PASS: Joi.string().required(),
})
  .unknown()    // allow other vars
  .required();

const { error, value: env } = envSchema.validate(process.env);
if (error) {
  console.error('❌ Invalid environment configuration:', error.message);
  process.exit(1);
}

module.exports = {
  env: env.NODE_ENV,
  port: env.PORT,

  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    pass: env.DB_PASS,
    name: env.DB_NAME,
  },

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },

  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
};
