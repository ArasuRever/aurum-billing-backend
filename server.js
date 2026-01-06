const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./config/db'); // Import DB connection for Auto-Fix

const app = express();

// Middleware (Increased limit for large backups)
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// --- AUTOMATIC DATABASE REPAIR SCRIPT ---
// This runs on startup to fix "Duplicate Key" errors after a restore
const autoFixDatabase = async () => {
    console.log("🔧 Running Database Auto-Repair...");
    const client = await pool.connect();
    try {
        const tables = [
            'users', 'business_settings', 'shop_assets', 'daily_rates', 'product_types', 'item_masters',
            'customers', 'vendors', 'vendor_agents', 'external_shops',
            'stock_batches', 'inventory_items', 'item_stock_logs', 'item_updates',
            'sales', 'sale_items', 'sale_exchange_items', 'sale_payments',
            'gst_bills', 'gst_bill_items', 'gst_bill_exchange_items',
            'old_metal_purchases', 'old_metal_items', 'refinery_batches',
            'chits', 'chit_payments', 'general_expenses',
            'vendor_transactions', 'shop_transactions', 'shop_transaction_payments',
            'inventory_audits', 'audit_scans'
        ];

        for (const table of tables) {
            try {
                // Check if table exists
                const check = await client.query(`SELECT to_regclass('public.${table}')`);
                if (check.rows[0].to_regclass) {
                    // Check if table has an 'id' column
                    const colCheck = await client.query(
                        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name='id'`, 
                        [table]
                    );
                    if (colCheck.rows.length > 0) {
                        // Reset ID sequence to MAX(id) + 1
                        await client.query(
                            `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${table}`
                        );
                    }
                }
            } catch (e) { 
                // Ignore errors for tables without sequences
            }
        }
        console.log("✅ Database Auto-Repair Complete. System is Ready!");
    } catch (err) {
        console.error("❌ Auto-Repair Failed:", err.message);
    } finally {
        client.release();
    }
};

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
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
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/chits', require('./routes/chits'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await autoFixDatabase(); // <--- RUNS FIX ON STARTUP
});