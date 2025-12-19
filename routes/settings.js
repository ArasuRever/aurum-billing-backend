const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// --- 1. DAILY RATES ENDPOINTS ---

// GET Rates
router.get('/rates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM daily_rates");
        // Convert array to object { GOLD: 7000, SILVER: 85 } for easier frontend use
        const rates = {};
        result.rows.forEach(row => {
            rates[row.metal_type] = parseFloat(row.rate);
        });
        res.json(rates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// UPDATE Rate
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
        res.json({ success: true, metal_type, rate });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 2. MASTER ITEMS ENDPOINTS (Existing) ---

router.get('/items', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM item_masters ORDER BY item_name ASC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/items', async (req, res) => {
    // Added calc_method to destructuring
    const { item_name, metal_type, default_wastage, mc_type, mc_value, calc_method } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO item_masters 
            (item_name, metal_type, default_wastage, mc_type, mc_value, calc_method) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                item_name, 
                metal_type, 
                default_wastage || 0, 
                mc_type || 'FIXED', 
                mc_value || 0,
                calc_method || 'STANDARD' // Default to Standard logic
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: "Item name already exists for this metal." });
        }
        res.status(500).json({ error: err.message });
    }
});

router.delete('/items/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM item_masters WHERE id = $1", [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;