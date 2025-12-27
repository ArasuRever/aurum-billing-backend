const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. START AUDIT SESSION
router.post('/start', async (req, res) => {
    console.log("Received Start Request:", req.body); // DEBUG LOG

    const { audit_name, category_filter } = req.body;
    
    if (!audit_name) {
        return res.status(400).json({ error: "Audit Name is required" });
    }

    try {
        // 1. Calculate Expected Count
        let query = "SELECT COUNT(*) FROM inventory_items WHERE status = 'AVAILABLE'";
        const params = [];
        
        if (category_filter !== 'ALL') {
            query += " AND metal_type = $1";
            params.push(category_filter);
        }

        console.log("Running Count Query:", query, params); // DEBUG LOG
        const countRes = await pool.query(query, params);
        const expected = parseInt(countRes.rows[0].count);

        // 2. Insert Audit Record
        console.log("Creating Audit Record..."); // DEBUG LOG
        const result = await pool.query(
            `INSERT INTO inventory_audits (audit_name, category_filter, total_expected, status)
             VALUES ($1, $2, $3, 'IN_PROGRESS') RETURNING *`,
            [audit_name, category_filter, expected]
        );

        console.log("Audit Created:", result.rows[0]); // DEBUG LOG
        res.json(result.rows[0]);

    } catch (err) {
        console.error("❌ AUDIT START ERROR:", err.message); // This will show in terminal
        res.status(500).json({ error: err.message });
    }
});

// 2. SCAN ITEM
router.post('/scan', async (req, res) => {
    const { audit_id, barcode } = req.body;
    try {
        // Find Item
        const itemRes = await pool.query("SELECT * FROM inventory_items WHERE barcode = $1 AND status='AVAILABLE'", [barcode]);
        
        if (itemRes.rows.length === 0) return res.status(404).json({ error: "Item NOT FOUND or SOLD!" });
        const item = itemRes.rows[0];

        // Check Filter
        const auditRes = await pool.query("SELECT category_filter FROM inventory_audits WHERE id = $1", [audit_id]);
        if(auditRes.rows.length === 0) return res.status(404).json({ error: "Audit Session Not Found" });
        
        const filter = auditRes.rows[0].category_filter;
        
        if (filter !== 'ALL' && item.metal_type !== filter) {
            return res.status(400).json({ error: `Wrong Metal! Found ${item.metal_type}, expected ${filter}` });
        }

        // Record Scan
        await pool.query("INSERT INTO audit_scans (audit_id, item_id, barcode) VALUES ($1, $2, $3)", [audit_id, item.id, barcode]);
        await pool.query("UPDATE inventory_audits SET total_scanned = total_scanned + 1 WHERE id = $1", [audit_id]);
        
        res.json({ success: true, item });

    } catch (err) {
        // Ignore duplicate scans (already scanned)
        if (err.code === '23505') return res.json({ success: true, item: {}, warning: "Already Scanned!" });
        
        console.error("❌ SCAN ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. GET REPORT
router.get('/:id/report', async (req, res) => {
    try {
        const auditRes = await pool.query("SELECT * FROM inventory_audits WHERE id = $1", [req.params.id]);
        if (auditRes.rows.length === 0) return res.status(404).json({ error: "Audit not found" });
        const audit = auditRes.rows[0];

        let missingQuery = `
            SELECT i.id, i.item_name, i.barcode, i.gross_weight, i.item_image, i.metal_type 
            FROM inventory_items i
            WHERE i.status = 'AVAILABLE' 
            AND i.id NOT IN (SELECT item_id FROM audit_scans WHERE audit_id = $1)
        `;
        const params = [req.params.id];
        if (audit.category_filter !== 'ALL') {
            missingQuery += " AND i.metal_type = $2";
            params.push(audit.category_filter);
        }

        const missingRes = await pool.query(missingQuery, params);
        
        const missingItems = missingRes.rows.map(i => ({
            ...i,
            item_image: i.item_image ? `data:image/jpeg;base64,${i.item_image.toString('base64')}` : null
        }));

        res.json({ audit, missing_count: missingItems.length, missing_items: missingItems });
    } catch (err) {
        console.error("REPORT ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. FINISH
router.post('/:id/finish', async (req, res) => {
    try {
        await pool.query("UPDATE inventory_audits SET status='COMPLETED', end_time=NOW() WHERE id=$1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;