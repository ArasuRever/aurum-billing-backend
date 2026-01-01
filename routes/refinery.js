const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET PENDING SCRAP
router.get('/pending-scrap', async (req, res) => {
    try {
        const { metal_type } = req.query;
        let query = "SELECT * FROM old_metal_items WHERE status = 'AVAILABLE'";
        const params = [];
        if (metal_type) {
            query += " AND metal_type = $1";
            params.push(metal_type);
        }
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. CREATE BATCH (Added Net Weight handling)
router.post('/create-batch', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { metal_type, item_ids, manual_weight, net_weight } = req.body; 

        let listGross = 0;
        
        if (item_ids && item_ids.length > 0) {
            const itemsRes = await client.query("SELECT id, gross_weight FROM old_metal_items WHERE id = ANY($1::int[])", [item_ids]);
            listGross = itemsRes.rows.reduce((sum, item) => sum + parseFloat(item.gross_weight), 0);
            
            // Mark items as BATCHED (batch_id updated later)
            await client.query(`UPDATE old_metal_items SET status = 'BATCHED', batch_id = 0 WHERE id = ANY($1::int[])`, [item_ids]);
        }

        const manual = parseFloat(manual_weight) || 0;
        const totalGross = listGross + manual;
        const totalNet = parseFloat(net_weight) || 0; // Editable Net Weight from UI

        if (totalGross <= 0) throw new Error("Batch weight cannot be zero.");

        const batchCountRes = await client.query("SELECT COUNT(*) FROM refinery_batches");
        const count = parseInt(batchCountRes.rows[0].count) + 1;
        const batchNo = `RB-${metal_type.charAt(0)}-${String(count).padStart(4, '0')}`;

        // Insert Batch with Pure Weight (Net Weight) estimate
        const batchRes = await client.query(`
            INSERT INTO refinery_batches (batch_no, metal_type, gross_weight, pure_weight, status, sent_date)
            VALUES ($1, $2, $3, $4, 'SENT', NOW()) RETURNING id`,
            [batchNo, metal_type, totalGross, totalNet]
        );
        const batchId = batchRes.rows[0].id;

        // Link items
        if (item_ids && item_ids.length > 0) {
            await client.query(`UPDATE old_metal_items SET batch_id = $1 WHERE id = ANY($2::int[])`, [batchId, item_ids]);
        }

        await client.query('COMMIT');
        res.json({ success: true, batch_no: batchNo });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 3. GET BATCHES
router.get('/batches', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, COUNT(i.id) as items_count 
            FROM refinery_batches b
            LEFT JOIN old_metal_items i ON b.id = i.batch_id
            GROUP BY b.id
            ORDER BY b.sent_date DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. RECEIVE REFINED
router.post('/receive-refined', async (req, res) => {
    const { batch_id, refined_weight, touch } = req.body; 
    try {
        const batchRes = await pool.query("SELECT gross_weight FROM refinery_batches WHERE id = $1", [batch_id]);
        if (batchRes.rows.length === 0) return res.status(404).json({ error: "Batch not found" });

        const sentWeight = parseFloat(batchRes.rows[0].gross_weight);
        const refined = parseFloat(refined_weight);
        const tch = parseFloat(touch);
        const pure_weight = (refined * (tch / 100)).toFixed(3);

        if (parseFloat(pure_weight) > sentWeight + 0.5) { 
             return res.status(400).json({ error: `Security Warning: Pure weight (${pure_weight}g) exceeds Sent Weight (${sentWeight}g)!` });
        }

        await pool.query(`
            UPDATE refinery_batches 
            SET refined_weight = $1, pure_weight = $2, touch = $3, status = 'REFINED', received_date = NOW()
            WHERE id = $4`,
            [refined, pure_weight, tch, batch_id]
        );
        
        await pool.query("UPDATE old_metal_items SET status='REFINED' WHERE batch_id=$1", [batch_id]);

        res.json({ success: true, pure_weight });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. USE STOCK
router.post('/use-stock', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { batch_id, use_weight, transfer_to, recipient_id, item_name, metal_type } = req.body;
        
        const batchRes = await client.query("SELECT pure_weight, used_weight FROM refinery_batches WHERE id=$1", [batch_id]);
        const batch = batchRes.rows[0];
        const available = parseFloat(batch.pure_weight) - parseFloat(batch.used_weight || 0);
        const weightToUse = parseFloat(use_weight);

        if (weightToUse > available + 0.01) throw new Error(`Insufficient Pure Weight. Available: ${available.toFixed(3)}g`);

        if (transfer_to === 'VENDOR') {
            await client.query(
                `UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`,
                [weightToUse, recipient_id]
            );
            await client.query(
                `INSERT INTO vendor_transactions 
                (vendor_id, type, description, stock_pure_weight, balance_after, metal_type)
                 VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4)`,
                [recipient_id, `Refinery Transfer: ${weightToUse}g`, weightToUse, metal_type]
            );

        } else if (transfer_to === 'SHOP') {
            if (metal_type === 'SILVER') {
                await client.query(`UPDATE external_shops SET balance_silver = balance_silver + $1 WHERE id = $2`, [weightToUse, recipient_id]);
            } else {
                await client.query(`UPDATE external_shops SET balance_gold = balance_gold + $1 WHERE id = $2`, [weightToUse, recipient_id]);
            }
        } else {
            // INVENTORY
            const seqRes = await client.query("SELECT nextval('item_barcode_seq') as num");
            const barcode = `${metal_type.charAt(0)}R-${seqRes.rows[0].num}`;

            await client.query(`
                INSERT INTO inventory_items (
                    metal_type, item_name, gross_weight, pure_weight, wastage_percent, 
                    source_type, status, barcode, quantity
                ) VALUES ($1, $2, $3, $3, 0, 'REFINERY', 'AVAILABLE', $4, 1)
            `, [metal_type, item_name || 'Refined Bar', weightToUse, barcode]);
        }

        await client.query(`
            UPDATE refinery_batches 
            SET used_weight = COALESCE(used_weight, 0) + $1,
                status = CASE WHEN (COALESCE(used_weight, 0) + $1) >= pure_weight - 0.01 THEN 'COMPLETED' ELSE 'REFINED' END
            WHERE id = $2
        `, [weightToUse, batch_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 6. GET BATCH ITEMS
router.get('/batch/:id/items', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT i.id, i.item_name, i.gross_weight, i.net_weight, i.metal_type,
                   p.voucher_no, p.customer_name, p.date as purchase_date
            FROM old_metal_items i
            LEFT JOIN old_metal_purchases p ON i.purchase_id = p.id
            WHERE i.batch_id = $1
            ORDER BY i.id ASC
        `, [id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;