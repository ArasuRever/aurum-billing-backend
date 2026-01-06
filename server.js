require('dotenv').config(); 

// --- SAFETY NET ---
if (!process.env.JWT_SECRET) {
    console.warn("⚠️ WARNING: JWT_SECRET not found. Using fallback.");
    process.env.JWT_SECRET = "temp_fallback_secret_key_2025"; 
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); 
const pool = require('./config/db');

const app = express();

// --- MIDDLEWARE ---
app.use(helmet()); 
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- DATABASE CHECK ---
const checkDatabaseConnection = async () => {
    try {
        const client = await pool.connect();
        const res = await client.query('SELECT NOW()');
        console.log(`✅ Database Active: ${res.rows[0].now}`);
        client.release();
    } catch (err) {
        console.error("❌ Database Connection Failed:", err.message);
    }
};

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/billing', require('./routes/billing')); // Now with Audit Logs
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/shops', require('./routes/shops'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/ledger', require('./routes/ledger'));
app.use('/api/old-metal', require('./routes/old_metal'));
app.use('/api/refinery', require('./routes/refinery'));
app.use('/api/gst', require('./routes/gst_billing'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/audit', require('./routes/audit')); // Stock Audit
app.use('/api/chits', require('./routes/chits'));

// --- NEW ROUTE: VIEW SYSTEM AUDIT LOGS ---
// (Simple inline route for Admin viewing)
app.get('/api/system-logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM system_audit_logs ORDER BY created_at DESC LIMIT 100');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, error: "Internal Server Error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await checkDatabaseConnection();
});