const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());

// --- FIX: INCREASE LIMIT FOR IMAGES ---
app.use(express.json({ limit: '50mb' })); // Allows large JSON (like Base64 images)
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Mount Routes (Feature-based)
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/shops', require('./routes/shops'));
app.use('/api/settings', require('./routes/settings'));

// --- NEW LEDGER ROUTE ---
app.use('/api/ledger', require('./routes/ledger'));

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});