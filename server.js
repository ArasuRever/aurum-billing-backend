const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/shops', require('./routes/shops'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/ledger', require('./routes/ledger'));
app.use('/api/old-metal', require('./routes/old_metal'));
app.use('/api/refinery', require('./routes/refinery'));
app.use('/api/gst', require('./routes/gst_billing')); 

// --- ADD THIS MISSING LINE ---
app.use('/api/dashboard', require('./routes/dashboard')); 
// -----------------------------

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));