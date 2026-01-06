const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');
const fs = require('fs');
const os = require('os'); 
const path = require('path');

// ==========================================
// 1. CONFIGURATION
// ==========================================

// Current System Version - Increment this when you make major DB changes
const SYSTEM_VERSION = '2.1'; 

// Use system temp directory to prevent Nodemon from restarting the server
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `restore-${Date.now()}.json`)
});

// Increased limit for large backup files (500MB)
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } 
});

// Middleware to catch upload errors
const uploadMiddleware = (req, res, next) => {
    const uploadSingle = upload.single('backup_file');
    uploadSingle(req, res, (err) => {
        if (err) {
            console.error("UPLOAD ERROR:", err);
            return res.status(400).json({ error: `Upload Failed: ${err.message}` });
        }
        next();
    });
};

const logoUpload = multer({ storage: multer.memoryStorage() });

// --- HELPER: RESET SEQUENCES ---
const resetSequences = async (client) => {
    console.log("Resetting DB Sequences...");
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
            // Only try to reset sequence if the table actually exists
            const check = await client.query(`SELECT to_regclass('public.${table}')`);
            if (check.rows[0].to_regclass) {
                const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name='id'`, [table]);
                if (res.rows.length > 0) {
                    await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${table}`);
                }
            }
        } catch (e) { 
            console.warn(`Skipped sequence reset for ${table}: ${e.message}`);
        }
    }
    console.log("Sequences Reset Done.");
};

// ==========================================
// 2. STANDARD SETTINGS ROUTES
// ==========================================

router.get('/rates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM daily_rates");
        const rates = {};
        result.rows.forEach(row => rates[row.metal_type] = parseFloat(row.rate));
        res.json(rates);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rates', async (req, res) => {
    try {
        for(const [key, val] of Object.entries(req.body)) {
            if (key === 'metal_type' || key === 'rate') continue; 
            await pool.query(
                `INSERT INTO daily_rates (metal_type, rate, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (metal_type) DO UPDATE SET rate = $2, updated_at = NOW()`,
                [key, val]
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/types', async (req, res) => {
    try { const result = await pool.query("SELECT * FROM product_types ORDER BY id ASC"); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/types', async (req, res) => {
    const { name, metal_type, formula, display_color, hsn_code } = req.body;
    try { const resDb = await pool.query("INSERT INTO product_types (name, metal_type, formula, display_color, hsn_code) VALUES ($1, $2, $3, $4, $5) RETURNING *", [name, metal_type, formula, display_color, hsn_code]); res.json(resDb.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/types/:id', async (req, res) => {
    const { name, metal_type, formula, display_color, hsn_code } = req.body;
    try { await pool.query("UPDATE product_types SET name=$1, metal_type=$2, formula=$3, display_color=$4, hsn_code=$5 WHERE id=$6", [name, metal_type, formula, display_color, hsn_code, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/types/:id', async (req, res) => {
    try { await pool.query("DELETE FROM product_types WHERE id=$1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/items', async (req, res) => {
    try { const result = await pool.query("SELECT * FROM item_masters ORDER BY item_name ASC"); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/items/bulk', async (req, res) => {
    const { item_names, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const name of item_names) {
            if (!name.trim()) continue;
            await client.query("INSERT INTO item_masters (item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code) VALUES ($1, $2, $3, $4, $5, $6, $7)", [name.trim(), metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json(e); } finally { client.release(); }
});

router.put('/items/:id', async (req, res) => {
    const { item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code } = req.body;
    try { await pool.query("UPDATE item_masters SET item_name=$1, metal_type=$2, default_wastage=$3, mc_type=$4, mc_value=$5, calc_method=$6, hsn_code=$7 WHERE id=$8", [item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/items/:id', async (req, res) => {
    try { await pool.query("DELETE FROM item_masters WHERE id=$1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/business', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM business_settings ORDER BY id DESC LIMIT 1");
        if (result.rows.length > 0) {
            const row = result.rows[0];
            if (row.logo) row.logo = `data:image/png;base64,${row.logo.toString('base64')}`;
            if (typeof row.invoice_config === 'string') { try { row.invoice_config = JSON.parse(row.invoice_config); } catch(e) { row.invoice_config = {}; } }
            res.json(row);
        } else { res.json({}); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/business', logoUpload.single('logo'), async (req, res) => {
    const { business_name, address, contact_number, email, license_number, gst, display_preference, invoice_config } = req.body;
    const logoBuffer = req.file ? req.file.buffer : undefined;
    const client = await pool.connect();
    let configJSON = invoice_config;
    if (typeof invoice_config === 'string') { try { configJSON = JSON.parse(invoice_config); } catch(e) { configJSON = {}; } }

    try {
        await client.query('BEGIN');
        const check = await client.query("SELECT id FROM business_settings LIMIT 1");
        if (check.rows.length === 0) {
            await client.query(`INSERT INTO business_settings (business_name, address, contact_number, email, license_number, gst, display_preference, logo, invoice_config) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [business_name, address, contact_number, email, license_number, gst, display_preference, logoBuffer, configJSON]);
        } else {
            const id = check.rows[0].id;
            let query = `UPDATE business_settings SET business_name=$1, address=$2, contact_number=$3, email=$4, license_number=$5, gst=$6, display_preference=$7, invoice_config=$8`;
            const params = [business_name, address, contact_number, email, license_number, gst, display_preference, configJSON];
            if (logoBuffer) { query += `, logo=$9 WHERE id=$10`; params.push(logoBuffer, id); } else { query += ` WHERE id=$9`; params.push(id); }
            await client.query(query, params);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// ==========================================
// 3. ROBUST BACKUP & RESTORE SYSTEM
// ==========================================

const DB_TABLES = [
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

router.get('/backup', async (req, res) => {
    try {
        // Tag backup with current system version
        const backupData = { timestamp: new Date(), version: SYSTEM_VERSION, data: {} };
        
        for (const table of DB_TABLES) {
            try {
                // Only backup tables that exist
                const check = await pool.query(`SELECT to_regclass('public.${table}')`);
                if (check.rows[0].to_regclass) {
                    const rows = await pool.query(`SELECT * FROM ${table}`);
                    backupData.data[table] = rows.rows;
                }
            } catch (e) { 
                console.error(`Backup Error on ${table}:`, e.message);
            }
        }
        
        const fileName = `AURUM_BACKUP_${new Date().toISOString().slice(0,10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(backupData, null, 2));
    } catch (err) { res.status(500).json({ error: "Backup generation failed" }); }
});

router.post('/restore', uploadMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) return res.status(400).json({ error: "No backup file uploaded" });
        const fileContent = await fs.promises.readFile(req.file.path, 'utf8');
        const backup = JSON.parse(fileContent);

        if (!backup.data) throw new Error("Invalid Backup Format");

        const backupVersion = backup.version || '1.0';
        console.log(`Restoring Backup Version ${backupVersion} on System Version ${SYSTEM_VERSION}`);

        // --- MIGRATION LOGIC: Map Old Tables to New Schema ---
        // V1.0 Compatibility: Map 'bills' to 'sales'
        if (backup.data['bills']) { 
            console.log("Migrating 'bills' -> 'sales'");
            backup.data['sales'] = backup.data['bills']; 
            delete backup.data['bills']; 
        }
        if (backup.data['bill_items']) { 
            console.log("Migrating 'bill_items' -> 'sale_items'");
            backup.data['sale_items'] = backup.data['bill_items']; 
            delete backup.data['bill_items']; 
        }
        
        await client.query('BEGIN');
        
        // --- STEP 1: CLEANUP (Delete old data) ---
        const cleanupOrder = [
            'audit_scans', 'inventory_audits', 'gst_bill_exchange_items', 'gst_bill_items', 'gst_bills',
            'sale_payments', 'sale_exchange_items', 'sale_items', 'sales',
            'shop_transaction_payments', 'shop_transactions', 'vendor_transactions', 'item_stock_logs', 'item_updates',
            'inventory_items', 'stock_batches', 'old_metal_items', 'old_metal_purchases', 'refinery_batches',
            'chit_payments', 'chits', 'general_expenses', 'vendor_agents', 'vendors', 'external_shops', 'customers',
            'item_masters', 'product_types', 'daily_rates', 'shop_assets', 'business_settings', 'users'
        ];

        for (const table of cleanupOrder) {
            const check = await client.query(`SELECT to_regclass('public.${table}')`);
            if (check.rows[0].to_regclass) {
                await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
            }
        }

        // --- STEP 2: RESTORE (Insert new data with Smart Matching) ---
        const restoreOrder = [...cleanupOrder].reverse();
        const BATCH_SIZE = 200; 

        for (const table of restoreOrder) {
            const rows = backup.data[table];
            if (rows && rows.length > 0) {
                // 1. Check if table exists in current DB
                const check = await client.query(`SELECT to_regclass('public.${table}')`);
                if (!check.rows[0].to_regclass) {
                    console.log(`Skipping table '${table}' (Not found in current DB)`);
                    continue; 
                }

                // 2. Get Valid Columns from current DB Schema
                const tableInfo = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]);
                const validColumns = new Set(tableInfo.rows.map(r => r.column_name));
                
                // 3. Filter Backup Data: Only keep keys that exist as columns
                const allKeys = Object.keys(rows[0]);
                const validKeys = allKeys.filter(k => validColumns.has(k));

                if (validKeys.length === 0) continue;

                // 4. FIX: Validate Foreign Keys for Inventory (Prevent Crashes)
                if (table === 'inventory_items') {
                    const [bRes, vRes, sRes] = await Promise.all([
                        client.query('SELECT id FROM stock_batches'),
                        client.query('SELECT id FROM vendors'),
                        client.query('SELECT id FROM external_shops')
                    ]);
                    const validBatches = new Set(bRes.rows.map(r => r.id));
                    const validVendors = new Set(vRes.rows.map(r => r.id));
                    const validShops = new Set(sRes.rows.map(r => r.id));
                    
                    rows.forEach(row => {
                        if (row.batch_id && !validBatches.has(row.batch_id)) row.batch_id = null;
                        if (row.vendor_id && !validVendors.has(row.vendor_id)) row.vendor_id = null;
                        if (row.neighbour_shop_id && !validShops.has(row.neighbour_shop_id)) row.neighbour_shop_id = null;
                    });
                }

                // 5. Bulk Insert
                const cols = validKeys.map(k => `"${k}"`).join(", ");
                for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                    const batch = rows.slice(i, i + BATCH_SIZE);
                    const values = [];
                    const placeholders = [];
                    batch.forEach((row, rowIndex) => {
                        const rowValues = validKeys.map(k => { 
                            let val = row[k]; 
                            if (val === "") return null; 
                            return val; 
                        });
                        values.push(...rowValues);
                        const start = (rowIndex * validKeys.length) + 1;
                        const p = validKeys.map((_, idx) => `$${start + idx}`);
                        placeholders.push(`(${p.join(", ")})`);
                    });
                    
                    if (placeholders.length > 0) {
                        const query = `INSERT INTO ${table} (${cols}) VALUES ${placeholders.join(", ")}`;
                        await client.query(query, values);
                    }
                }
            }
        }

        // --- STEP 3: RESET SEQUENCES (Vital for auto-increment IDs) ---
        await resetSequences(client);

        await client.query('COMMIT');
        
        // Cleanup temp file
        try { await fs.promises.unlink(req.file.path); } catch(e) {}
        
        res.json({ success: true, message: "System Restored Successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("RESTORE ERROR:", err);
        if (req.file) { try { await fs.promises.unlink(req.file.path); } catch(e) {} }
        res.status(500).json({ error: "Restore Failed: " + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;