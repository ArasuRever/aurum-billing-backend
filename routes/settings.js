const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

// Configure upload for Logo
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// 1. DAILY RATES
// ==========================================
router.get('/rates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM daily_rates");
        const rates = {};
        result.rows.forEach(row => {
            rates[row.metal_type] = parseFloat(row.rate);
        });
        res.json(rates);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/rates', async (req, res) => {
    const { metal_type, rate } = req.body;
    try {
        await pool.query(
            `INSERT INTO daily_rates (metal_type, rate, updated_at) 
             VALUES ($1, $2, NOW())
             ON CONFLICT (metal_type) 
             DO UPDATE SET rate = $2, updated_at = NOW()`,
            [metal_type, rate]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. PRODUCT TYPES (Categories)
// ==========================================
router.get('/types', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM product_types ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/types', async (req, res) => {
    // Expects: name, metal_type, formula, display_color, hsn_code
    const { name, metal_type, formula, display_color, hsn_code } = req.body;
    
    try {
        const result = await pool.query(
            `INSERT INTO product_types (name, metal_type, formula, display_color, hsn_code) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, metal_type, formula, display_color, hsn_code]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.put('/types/:id', async (req, res) => {
    const { id } = req.params;
    const { name, metal_type, formula, display_color, hsn_code } = req.body;
    
    try {
        await pool.query(
            `UPDATE product_types 
             SET name = COALESCE($1, name), 
                 metal_type = COALESCE($2, metal_type), 
                 formula = $3, 
                 display_color = $4, 
                 hsn_code = $5 
             WHERE id = $6`,
            [name, metal_type, formula, display_color, hsn_code, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/types/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM product_types WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. ITEM MASTERS (Product Library)
// ==========================================
router.get('/items', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM item_masters ORDER BY item_name ASC");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/items/bulk', async (req, res) => {
    const { item_names, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code } = req.body;
    
    if (!item_names || !Array.isArray(item_names)) {
        return res.status(400).json({ error: "Invalid input format" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        for (const name of item_names) {
            if (!name.trim()) continue;
            await client.query(
                `INSERT INTO item_masters 
                (item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [name.trim(), metal_type, default_wastage || 0, mc_type || 'FIXED', mc_value || 0, calc_method || 'STANDARD', hsn_code]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.put('/items/:id', async (req, res) => {
    const { id } = req.params;
    const { item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code } = req.body;
    
    try {
        await pool.query(
            `UPDATE item_masters 
             SET item_name=$1, metal_type=$2, default_wastage=$3, mc_type=$4, mc_value=$5, calc_method=$6, hsn_code=$7 
             WHERE id=$8`,
            [item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, hsn_code, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/items/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM item_masters WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 4. BUSINESS PROFILE
// ==========================================
router.get('/business', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM business_settings ORDER BY id DESC LIMIT 1");
        if (result.rows.length > 0) {
            const row = result.rows[0];
            // Convert Buffer to Base64 string for frontend
            if (row.logo) {
                row.logo = `data:image/png;base64,${row.logo.toString('base64')}`;
            }
            res.json(row);
        } else {
            res.json({});
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/business', upload.single('logo'), async (req, res) => {
    const { business_name, address, contact_number, email, license_number, display_preference, gst } = req.body;
    const logoBuffer = req.file ? req.file.buffer : undefined;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Check if row exists
        const check = await client.query("SELECT id FROM business_settings LIMIT 1");
        
        if (check.rows.length === 0) {
            // INSERT
            await client.query(
                `INSERT INTO business_settings 
                (business_name, address, contact_number, email, license_number, gst, display_preference, logo) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [business_name, address, contact_number, email, license_number, gst, display_preference, logoBuffer]
            );
        } else {
            // UPDATE
            const id = check.rows[0].id;
            let query = `UPDATE business_settings SET 
                business_name=$1, address=$2, contact_number=$3, email=$4, license_number=$5, gst=$6, display_preference=$7`;
            const params = [business_name, address, contact_number, email, license_number, gst, display_preference];
            
            if (logoBuffer) {
                query += `, logo=$8 WHERE id=$9`;
                params.push(logoBuffer, id);
            } else {
                query += ` WHERE id=$8`;
                params.push(id);
            }
            await client.query(query, params);
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;