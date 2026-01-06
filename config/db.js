const { Pool } = require('pg');
// require('dotenv').config(); // <-- REMOVED (Loaded in server.js)

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

pool.on('connect', () => {
  // console.log('✅ Connected to PostgreSQL Database'); // Optional: Commented out to reduce noise
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;