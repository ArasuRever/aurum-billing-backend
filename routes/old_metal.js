const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // Ensure this path matches your db config

// 1. GET STATS
router.get('/stats', async (req, res) => {
    try {
        // Calculate total weight and cost for Gold and Silver
        const goldStats = await pool.query(`
            SELECT COALESCE(SUM(net_weight), 0) as weight, COALESCE(SUM(amount), 0) as cost 
            FROM old_metal_items WHERE metal_type = 'GOLD'
        `);
        const silverStats = await pool.query(`
            SELECT COALESCE(SUM(net_weight), 0) as weight, COALESCE(SUM(amount), 0) as cost 
            FROM old_metal_items WHERE metal_type = 'SILVER'
        `);

        res.json({
            gold_weight: goldStats.rows[0].weight,
            gold_cost: goldStats.rows[0].cost,
            silver_weight: silverStats.rows[0].weight,
            silver_cost: silverStats.rows[0].cost
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 2. GET LIST (HISTORY)
router.get('/list', async (req, res) => {
    try {
        // Fetch Purchases joined with Items for a flattened view (or just purchases)
        const result = await pool.query(`
            SELECT p.id, p.voucher_no, p.customer_name, p.mobile, p.date, 
                   i.item_name, i.metal_type, i.net_weight, i.amount, p.net_payout
            FROM old_metal_purchases p
            JOIN old_metal_items i ON p.id = i.purchase_id
            ORDER BY p.date DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 3. ADD PURCHASE
router.post('/purchase', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { customer_name, mobile, items, total_amount, gst_deducted, net_payout, payment_mode, cash_paid, online_paid } = req.body;

        // Generate Voucher No (Simple Auto-increment logic or timestamp)
        const voucherRes = await client.query("SELECT COUNT(*) FROM old_metal_purchases");
        const count = parseInt(voucherRes.rows[0].count) + 1;
        const voucher_no = `OM-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;

        // Insert Purchase Record
        const purchaseRes = await client.query(`
            INSERT INTO old_metal_purchases 
            (voucher_no, customer_name, mobile, total_amount, gst_deducted, net_payout, payment_mode, cash_paid, online_paid, date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING id`,
            [voucher_no, customer_name, mobile, total_amount, gst_deducted, net_payout, payment_mode, cash_paid, online_paid]
        );
        const purchaseId = purchaseRes.rows[0].id;

        // Insert Items
        for (const item of items) {
            await client.query(`
                INSERT INTO old_metal_items 
                (purchase_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, amount)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [purchaseId, item.item_name, item.metal_type, item.gross_weight, item.less_percent, item.less_weight, item.net_weight, item.rate, item.amount]
            );
        }

        await client.query('COMMIT');
        res.json({ message: 'Purchase Saved', voucher_no });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Transaction Failed' });
    } finally {
        client.release();
    }
});

// 4. DELETE PURCHASE (This fixes your 404 error)
router.delete('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;

        // First delete items linked to this purchase (Foreign Key constraint)
        await client.query('DELETE FROM old_metal_items WHERE purchase_id = $1', [id]);

        // Then delete the purchase record itself
        const result = await client.query('DELETE FROM old_metal_purchases WHERE id = $1', [id]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Record not found" });
        }

        await client.query('COMMIT');
        res.json({ message: "Deleted successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Delete Error:", err);
        res.status(500).json({ message: "Server error during deletion" });
    } finally {
        client.release();
    }
});

module.exports = router;