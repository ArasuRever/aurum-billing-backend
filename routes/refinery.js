const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// 1. GET PENDING
router.get('/pending-scrap', async (req, res) => {
    const { metal_type } = req.query; 
    try {
        const result = await pool.query(
            `SELECT i.id, i.item_name, i.net_weight, i.purchase_id, p.voucher_no, p.date 
             FROM old_metal_items i
             JOIN old_metal_purchases p ON i.purchase_id = p.id
             WHERE i.status = 'AVAILABLE' AND i.metal_type = $1
             ORDER BY p.date ASC`,
            [metal_type || 'GOLD']
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. CREATE BATCH
router.post('/create-batch', async (req, res) => {
    const { metal_type, selected_item_ids, manual_weight } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let systemWeight = 0;
        let itemCount = 0;
        if (selected_item_ids && selected_item_ids.length > 0) {
            const itemsRes = await client.query(`SELECT SUM(net_weight) as total FROM old_metal_items WHERE id = ANY($1::int[])`, [selected_item_ids]);
            systemWeight = parseFloat(itemsRes.rows[0].total) || 0;
            itemCount = selected_item_ids.length;
        }
        const finalGrossWeight = systemWeight + (parseFloat(manual_weight) || 0);
        const batchNo = `REF-${metal_type.charAt(0)}-${Date.now()}`;

        const batchRes = await client.query(
            `INSERT INTO refinery_batches (batch_no, metal_type, status, gross_weight, items_count, sent_date)
            VALUES ($1, $2, 'SENT', $3, $4, NOW()) RETURNING id`,
            [batchNo, metal_type, finalGrossWeight, itemCount]
        );
        const batchId = batchRes.rows[0].id;

        if (selected_item_ids && selected_item_ids.length > 0) {
            await client.query(`UPDATE old_metal_items SET status = 'BATCHED', batch_id = $1 WHERE id = ANY($2::int[])`, [batchId, selected_item_ids]);
        }

        await client.query('COMMIT');
        res.json({ success: true, batchId, batchNo });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } 
    finally { client.release(); }
});

// 3. GET BATCHES
router.get('/batches', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM refinery_batches ORDER BY created_at DESC`);
        const batches = result.rows.map(b => ({
            ...b,
            touch_report_image: b.touch_report_image ? `data:image/jpeg;base64,${b.touch_report_image.toString('base64')}` : null
        }));
        res.json(batches);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. RECEIVE
router.post('/receive-refined', upload.single('report_image'), async (req, res) => {
    const { batch_id, refined_weight, touch_percent, report_no } = req.body;
    const report_image = req.file ? req.file.buffer : null;
    try {
        const rWeight = parseFloat(refined_weight);
        const touch = parseFloat(touch_percent);
        const pure = rWeight * (touch / 100);
        await pool.query(
            `UPDATE refinery_batches 
             SET status='REFINED', received_date=NOW(), refined_weight=$1, touch_percent=$2, pure_weight=$3, 
                 touch_report_no=$4, touch_report_image=COALESCE($5, touch_report_image)
             WHERE id=$6`,
            [rWeight, touch, pure, report_no, report_image, batch_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. USE STOCK
router.post('/use-stock', async (req, res) => {
    const { batch_id, usage_type, vendor_id, weight_to_use } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const batchRes = await client.query("SELECT * FROM refinery_batches WHERE id=$1", [batch_id]);
        const batch = batchRes.rows[0];
        const currentUsed = parseFloat(batch.used_weight || 0);
        const available = parseFloat(batch.pure_weight) - currentUsed;
        const useWeight = parseFloat(weight_to_use);

        if (useWeight > available + 0.001) throw new Error("Insufficient Weight");

        if (usage_type === 'PAY_VENDOR') {
            await client.query(`UPDATE vendors SET balance_pure_weight = balance_pure_weight - $1 WHERE id = $2`, [useWeight, vendor_id]);
            await client.query(`INSERT INTO vendor_transactions (vendor_id, type, description, repaid_metal_weight, balance_after, metal_type, reference_id, reference_type) VALUES ($1, 'REFINERY_PAYMENT', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4, $5, 'REFINERY_BATCH')`, [vendor_id, `Batch ${batch.batch_no}`, useWeight, batch.metal_type, batch_id]);
        } else if (usage_type === 'ADD_TO_INVENTORY') {
             await client.query(`INSERT INTO inventory_items (item_name, barcode, metal_type, gross_weight, pure_weight, wastage_percent, source_type, status, stock_type) VALUES ($1, $2, $3, $4, $4, 100, 'REFINERY', 'AVAILABLE', 'RAW')`, [`Refined ${batch.metal_type}`, `REF-${Date.now()}`, batch.metal_type, useWeight]);
        }

        const newUsed = currentUsed + useWeight;
        const newStatus = Math.abs(parseFloat(batch.pure_weight) - newUsed) < 0.01 ? 'COMPLETED' : 'REFINED';
        await client.query("UPDATE refinery_batches SET used_weight = $1, status = $2 WHERE id = $3", [newUsed, newStatus, batch_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } 
    finally { client.release(); }
});

module.exports = router;