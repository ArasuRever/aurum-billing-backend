const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET PENDING SCRAP (Items Available for Refinery)
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. CREATE BATCH
router.post('/create-batch', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { metal_type, item_ids } = req.body;

        // Calculate total weight
        const itemsRes = await client.query("SELECT id, net_weight FROM old_metal_items WHERE id = ANY($1::int[])", [item_ids]);
        const totalWeight = itemsRes.rows.reduce((sum, item) => sum + parseFloat(item.net_weight), 0);

        // Generate Batch No
        const batchCountRes = await client.query("SELECT COUNT(*) FROM refinery_batches");
        const count = parseInt(batchCountRes.rows[0].count) + 1;
        const batchNo = `RB-${metal_type.charAt(0)}-${String(count).padStart(4, '0')}`;

        // Insert Batch
        const batchRes = await client.query(`
            INSERT INTO refinery_batches (batch_no, metal_type, gross_weight, status, sent_date)
            VALUES ($1, $2, $3, 'SENT', NOW()) RETURNING id`,
            [batchNo, metal_type, totalWeight]
        );
        const batchId = batchRes.rows[0].id;

        // Update Items status
        await client.query(`
            UPDATE old_metal_items 
            SET status = 'BATCHED', batch_id = $1 
            WHERE id = ANY($2::int[])`,
            [batchId, item_ids]
        );

        await client.query('COMMIT');
        res.json({ success: true, batch_no: batchNo });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 3. GET BATCHES
router.get('/batches', async (req, res) => {
    try {
        // We also count items in the batch for display
        const result = await pool.query(`
            SELECT b.*, COUNT(i.id) as items_count 
            FROM refinery_batches b
            LEFT JOIN old_metal_items i ON b.id = i.batch_id
            GROUP BY b.id
            ORDER BY b.sent_date DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. RECEIVE REFINED GOLD (WITH SECURITY CHECK)
router.post('/receive-refined', async (req, res) => {
    const { batch_id, refined_weight, pure_weight } = req.body;
    try {
        // --- SECURITY VALIDATION ---
        const batchRes = await pool.query("SELECT gross_weight FROM refinery_batches WHERE id = $1", [batch_id]);
        if (batchRes.rows.length === 0) return res.status(404).json({ error: "Batch not found" });

        const sentWeight = parseFloat(batchRes.rows[0].gross_weight);
        const receivedPure = parseFloat(pure_weight);

        // Allow a tiny margin of error (0.01g) for scale differences, but generally pure cannot exceed gross sent.
        if (receivedPure > sentWeight + 0.01) {
            return res.status(400).json({ 
                error: `Security Alert: Received pure weight (${receivedPure}g) cannot exceed sent gross weight (${sentWeight}g)!` 
            });
        }
        // ---------------------------

        await pool.query(`
            UPDATE refinery_batches 
            SET refined_weight = $1, pure_weight = $2, status = 'REFINED', received_date = NOW()
            WHERE id = $3`,
            [refined_weight, pure_weight, batch_id]
        );
        
        // Mark items as REFINED (Archived basically)
        await pool.query("UPDATE old_metal_items SET status='REFINED' WHERE batch_id=$1", [batch_id]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. USE REFINED STOCK (Convert to Inventory)
router.post('/use-stock', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { batch_id, use_weight, item_name, metal_type } = req.body;

        // 1. Check available balance in batch
        const batchRes = await client.query("SELECT pure_weight, used_weight FROM refinery_batches WHERE id=$1", [batch_id]);
        const batch = batchRes.rows[0];
        const available = parseFloat(batch.pure_weight) - parseFloat(batch.used_weight || 0);

        if (use_weight > available) {
            throw new Error(`Insufficient Pure Weight. Available: ${available.toFixed(3)}g`);
        }

        // 2. Add to Inventory as new item (Source: REFINERY)
        const seqRes = await client.query("SELECT nextval('item_barcode_seq') as num");
        const barcode = `${metal_type.charAt(0)}R-${seqRes.rows[0].num}`;

        await client.query(`
            INSERT INTO inventory_items (
                metal_type, item_name, gross_weight, pure_weight, wastage_percent, 
                source_type, status, barcode, quantity, is_deleted
            ) VALUES ($1, $2, $3, $3, 0, 'REFINERY', 'AVAILABLE', $4, 1, FALSE)
        `, [metal_type, item_name || 'Refined Bar', use_weight, barcode]);

        // 3. Update Batch Used Weight
        await client.query(`
            UPDATE refinery_batches 
            SET used_weight = COALESCE(used_weight, 0) + $1,
                status = CASE WHEN (COALESCE(used_weight, 0) + $1) >= pure_weight THEN 'COMPLETED' ELSE 'REFINED' END
            WHERE id = $2
        `, [use_weight, batch_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 6. GET BATCH ITEMS HISTORY
router.get('/batch/:id/items', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT i.id, i.item_name, i.net_weight, i.metal_type,
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