const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Configure Uploads
// We use diskStorage for backup files to handle larger files without crashing RAM
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, './'), // Temp save to root
        filename: (req, file, cb) => cb(null, `restore-${Date.now()}.json`)
    }),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB Limit
});

// For Logo (Memory Storage is fine for small images)
const logoUpload = multer({ storage: multer.memoryStorage() });

// ==========================================
// EXISTING SETTINGS ROUTES (Rates, Types, Items)
// ==========================================

// 1. DAILY RATES
router.get('/rates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM daily_rates");
        const rates = {};
        result.rows.forEach(row => rates[row.metal_type] = parseFloat(row.rate));
        res.json(rates);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rates', async (req, res) => {
    const { metal_type, rate } = req.body;
    try {
        if(metal_type) {
             await pool.query(
                `INSERT INTO daily_rates (metal_type, rate, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (metal_type) DO UPDATE SET rate = $2, updated_at = NOW()`,
                [metal_type, rate]
            );
        } else {
            // Handle Bulk Update object { GOLD: 123, SILVER: 456 }
            for(const [key, val] of Object.entries(req.body)) {
                await pool.query(
                    `INSERT INTO daily_rates (metal_type, rate, updated_at) VALUES ($1, $2, NOW())
                     ON CONFLICT (metal_type) DO UPDATE SET rate = $2, updated_at = NOW()`,
                    [key, val]
                );
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. PRODUCT TYPES
router.get('/types', async (req, res) => {
    const result = await pool.query("SELECT * FROM product_types ORDER BY id ASC");
    res.json(result.rows);
});
router.post('/types', async (req, res) => {
    const { name, metal_type, formula, display_color, hsn_code } = req.body;
    const resDb = await pool.query("INSERT INTO product_types (name, metal_type, formula, display_color, hsn_code) VALUES ($1, $2, $3, $4, $5) RETURNING *", [name, metal_type, formula, display_color, hsn_code]);
    res.json(resDb.rows[0]);
});
router.put('/types/:id', async (req, res) => {
    const { name, metal_type, formula, display_color, hsn_code } = req.body;
    await pool.query("UPDATE product_types SET name=$1, metal_type=$2, formula=$3, display_color=$4, hsn_code=$5 WHERE id=$6", [name, metal_type, formula, display_color, hsn_code, req.params.id]);
    res.json({ success: true });
});
router.delete('/types/:id', async (req, res) => {
    await pool.query("DELETE FROM product_types WHERE id=$1", [req.params.id]);
    res.json({ success: true });
});

// 3. MASTER ITEMS
router.get('/items', async (req, res) => {
    const result = await pool.query("SELECT * FROM item_masters ORDER BY item_name ASC");
    res.json(result.rows);
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
    await pool.query("UPDATE item_masters SET item_name=$1, metal_type=$2, default_wastage=$3, mc_type=$4, mc_value=$5, calc_method=$6, hsn_code=$7 WHERE id=$8", [item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code, req.params.id]);
    res.json({ success: true });
});
router.delete('/items/:id', async (req, res) => {
    await pool.query("DELETE FROM item_masters WHERE id=$1", [req.params.id]);
    res.json({ success: true });
});

// 4. BUSINESS PROFILE
router.get('/business', async (req, res) => {
    const result = await pool.query("SELECT * FROM business_settings ORDER BY id DESC LIMIT 1");
    if (result.rows.length > 0) {
        const row = result.rows[0];
        if (row.logo) row.logo = `data:image/png;base64,${row.logo.toString('base64')}`;
        res.json(row);
    } else { res.json({}); }
});

router.post('/business', logoUpload.single('logo'), async (req, res) => {
    const { business_name, address, contact_number, email, license_number, gst, display_preference } = req.body;
    const logoBuffer = req.file ? req.file.buffer : undefined;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const check = await client.query("SELECT id FROM business_settings LIMIT 1");
        if (check.rows.length === 0) {
            await client.query(`INSERT INTO business_settings (business_name, address, contact_number, email, license_number, gst, display_preference, logo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [business_name, address, contact_number, email, license_number, gst, display_preference, logoBuffer]);
        } else {
            const id = check.rows[0].id;
            let query = `UPDATE business_settings SET business_name=$1, address=$2, contact_number=$3, email=$4, license_number=$5, gst=$6, display_preference=$7`;
            const params = [business_name, address, contact_number, email, license_number, gst, display_preference];
            if (logoBuffer) { query += `, logo=$8 WHERE id=$9`; params.push(logoBuffer, id); } 
            else { query += ` WHERE id=$8`; params.push(id); }
            await client.query(query, params);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// ==========================================
// 5. BACKUP & RESTORE SYSTEM (NEW)
// ==========================================

router.get('/backup', async (req, res) => {
    try {
        // List of all tables to backup
        const tables = [
            'users', 'business_settings', 'daily_rates', 'product_types', 'item_masters',
            'vendors', 'vendor_agents', 'external_shops', 'customers',
            'inventory_items', 'old_metal_items', 'old_metal_purchases',
            'bills', 'bill_items', 'gst_bills', 'gst_bill_items',
            'ledger_entries', 'refinery_batches', 'chits', 'chit_transactions'
        ];

        const backupData = { timestamp: new Date(), version: '1.0', data: {} };

        for (const table of tables) {
            try {
                // Check if table exists to be safe
                const check = await pool.query(`SELECT to_regclass('public.${table}')`);
                if (check.rows[0].to_regclass) {
                    const rows = await pool.query(`SELECT * FROM ${table}`);
                    backupData.data[table] = rows.rows;
                }
            } catch (e) { console.warn(`Backup skipping ${table}:`, e.message); }
        }

        const fileName = `AURUM_BACKUP_${new Date().toISOString().slice(0,10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(backupData, null, 2));

    } catch (err) {
        console.error("Backup Error:", err);
        res.status(500).json({ error: "Backup generation failed" });
    }
});

router.post('/restore', upload.single('backup_file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) return res.status(400).json({ error: "No backup file uploaded" });

        const filePath = req.file.path;
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const backup = JSON.parse(fileContent);

        if (!backup.data) throw new Error("Invalid Backup File Format");

        await client.query('BEGIN');

        // Order of deletion (Children first, then Parents)
        const cleanupOrder = [
            'chit_transactions', 'chits', 
            'refinery_batches', 
            'ledger_entries', 
            'bill_items', 'bills', 
            'gst_bill_items', 'gst_bills',
            'old_metal_items', 'old_metal_purchases', 
            'inventory_items', 
            'vendor_agents', 'vendors', 'external_shops', 'customers',
            'item_masters', 'product_types', 'daily_rates', 
            'business_settings', 'users'
        ];

        // 1. Clear Database
        for (const table of cleanupOrder) {
            try {
                // Use CASCADE to handle any missed dependencies
                await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
            } catch (e) { console.log(`Truncate skipped for ${table}`); }
        }

        // 2. Restore Data (Parents first, then Children)
        const restoreOrder = cleanupOrder.reverse();

        for (const table of restoreOrder) {
            const rows = backup.data[table];
            if (rows && rows.length > 0) {
                for (const row of rows) {
                    // Filter out any columns that might not exist in current schema (optional safety)
                    const keys = Object.keys(row).map(k => `"${k}"`).join(", ");
                    const values = Object.values(row);
                    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
                    
                    // Safe Insert
                    const query = `INSERT INTO ${table} (${keys}) VALUES (${placeholders})`;
                    await client.query(query, values);
                }
            }
        }

        await client.query('COMMIT');
        
        // Clean up temp file
        fs.unlinkSync(filePath);
        
        res.json({ success: true, message: "System Restored Successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Restore Failed:", err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Restore Failed: " + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;