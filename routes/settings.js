const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- 1. DAILY RATES ---
router.get('/rates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM daily_rates");
        const rates = {};
        result.rows.forEach(row => { rates[row.metal_type] = parseFloat(row.rate); });
        res.json(rates);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rates', async (req, res) => {
    const { metal_type, rate } = req.body;
    try {
        await pool.query(
            `INSERT INTO daily_rates (metal_type, rate, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (metal_type) DO UPDATE SET rate = $2, updated_at = NOW()`,
            [metal_type, rate]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. PRODUCT TYPES (Added HSN) ---
router.get('/types', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM product_types ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/types', async (req, res) => {
    const { name, formula, display_color, hsn_code } = req.body;
    try {
        await pool.query(
            `INSERT INTO product_types (name, formula, display_color, hsn_code) VALUES ($1, $2, $3, $4)`,
            [name.toUpperCase(), formula, display_color, hsn_code]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/types/:id', async (req, res) => {
    const { formula, display_color, hsn_code } = req.body;
    try {
        await pool.query(`UPDATE product_types SET formula=$1, display_color=$2, hsn_code=$3 WHERE id=$4`, 
            [formula, display_color, hsn_code, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/types/:id', async (req, res) => {
    try {
        const typeRes = await pool.query("SELECT name FROM product_types WHERE id=$1", [req.params.id]);
        if(typeRes.rows.length > 0) {
            await pool.query("DELETE FROM item_masters WHERE metal_type=$1", [typeRes.rows[0].name]);
        }
        await pool.query("DELETE FROM product_types WHERE id=$1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. MASTER ITEMS (Added HSN) ---
router.get('/items', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM item_masters ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/items/bulk', async (req, res) => {
    const { item_names, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code } = req.body;
    if (!item_names || !Array.isArray(item_names) || item_names.length === 0) {
        return res.status(400).json({ error: "No item names provided" });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertedItems = [];
        for (const name of item_names) {
            const cleanName = name.trim();
            if(!cleanName) continue;
            const res = await client.query(
                `INSERT INTO item_masters (item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [cleanName, metal_type, default_wastage || 0, mc_type || 'FIXED', mc_value || 0, calc_method || 'STANDARD', hsn_code || '']
            );
            insertedItems.push(res.rows[0]);
        }
        await client.query('COMMIT');
        res.json({ success: true, count: insertedItems.length, items: insertedItems });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Failed to add items." });
    } finally {
        client.release();
    }
});

router.put('/items/:id', async (req, res) => {
    const { id } = req.params;
    const { item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code } = req.body;
    try {
        const result = await pool.query(
            `UPDATE item_masters SET item_name = $1, metal_type = $2, default_wastage = $3, mc_type = $4, mc_value = $5, calc_method = $6, hsn_code = $7 WHERE id = $8 RETURNING *`,
            [item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code, id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/items/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM item_masters WHERE id = $1", [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. BUSINESS PROFILE SETTINGS ---
router.get('/business', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM business_settings ORDER BY id DESC LIMIT 1");
        if (result.rows.length > 0) {
            const row = result.rows[0];
            const settings = {
                ...row,
                logo: row.logo ? `data:image/png;base64,${row.logo.toString('base64')}` : null
            };
            res.json(settings);
        } else {
            res.json({});
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/business', upload.single('logo'), async (req, res) => {
    const { business_name, address, contact_number, email, license_number, display_preference } = req.body;
    const logo = req.file ? req.file.buffer : undefined; 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const check = await client.query("SELECT id FROM business_settings LIMIT 1");
        
        if (check.rows.length === 0) {
            await client.query(
                `INSERT INTO business_settings (business_name, address, contact_number, email, license_number, logo, display_preference) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [business_name, address, contact_number, email, license_number, logo, display_preference || 'BOTH']
            );
        } else {
            const id = check.rows[0].id;
            let query = `UPDATE business_settings SET 
                business_name=$1, address=$2, contact_number=$3, email=$4, license_number=$5, display_preference=$6`;
            const params = [business_name, address, contact_number, email, license_number, display_preference];
            
            if (logo) {
                query += `, logo=$7 WHERE id=$8`;
                params.push(logo, id);
            } else {
                query += ` WHERE id=$7`;
                params.push(id);
            }
            await client.query(query, params);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;