//
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// --- 1. DAILY RATES ENDPOINTS ---
router.get('/rates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM daily_rates");
        const rates = {};
        result.rows.forEach(row => {
            rates[row.metal_type] = parseFloat(row.rate);
        });
        res.json(rates);
    } catch (err) {
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
        res.json({ success: true, metal_type, rate });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 2. MASTER ITEMS ENDPOINTS ---

router.get('/items', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM item_masters ORDER BY id DESC"); // Newest first
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// NEW: Bulk Add Items
router.post('/items/bulk', async (req, res) => {
    const { item_names, metal_type, default_wastage, mc_type, mc_value, calc_method } = req.body;
    
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
                `INSERT INTO item_masters 
                (item_name, metal_type, default_wastage, mc_type, mc_value, calc_method) 
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [
                    cleanName, 
                    metal_type, 
                    default_wastage || 0, 
                    mc_type || 'FIXED', 
                    mc_value || 0,
                    calc_method || 'STANDARD'
                ]
            );
            insertedItems.push(res.rows[0]);
        }
        
        await client.query('COMMIT');
        res.json({ success: true, count: insertedItems.length, items: insertedItems });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Failed to add items. Some names might be duplicates." });
    } finally {
        client.release();
    }
});

// NEW: Update Item (Edit)
router.put('/items/:id', async (req, res) => {
    const { id } = req.params;
    const { item_name, metal_type, default_wastage, mc_type, mc_value, calc_method } = req.body;

    try {
        const result = await pool.query(
            `UPDATE item_masters 
             SET item_name = $1, metal_type = $2, default_wastage = $3, 
                 mc_type = $4, mc_value = $5, calc_method = $6
             WHERE id = $7 RETURNING *`,
            [
                item_name, metal_type, default_wastage, mc_type, mc_value, calc_method, id
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Item not found" });
        res.json(result.rows[0]);
    } catch (err) {
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