const express = require('express');
const router = express.Router();
const pool = require('../config/db'); 

// 1. GET STATS (Calculates "Purchase" vs "Exchange" dynamically)
router.get('/stats', async (req, res) => {
    try {
        const goldStats = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN p.payment_mode != 'EXCHANGE' THEN i.net_weight ELSE 0 END), 0) as purchase_weight,
                COALESCE(SUM(CASE WHEN p.payment_mode = 'EXCHANGE' THEN i.net_weight ELSE 0 END), 0) as exchange_weight,
                COALESCE(SUM(i.net_weight), 0) as total_weight,
                COALESCE(SUM(CASE WHEN p.payment_mode != 'EXCHANGE' THEN i.amount ELSE 0 END), 0) as cost
            FROM old_metal_items i
            JOIN old_metal_purchases p ON i.purchase_id = p.id
            WHERE i.metal_type = 'GOLD' AND i.status = 'AVAILABLE'
        `);

        const silverStats = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN p.payment_mode != 'EXCHANGE' THEN i.net_weight ELSE 0 END), 0) as purchase_weight,
                COALESCE(SUM(CASE WHEN p.payment_mode = 'EXCHANGE' THEN i.net_weight ELSE 0 END), 0) as exchange_weight,
                COALESCE(SUM(i.net_weight), 0) as total_weight,
                COALESCE(SUM(CASE WHEN p.payment_mode != 'EXCHANGE' THEN i.amount ELSE 0 END), 0) as cost
            FROM old_metal_items i
            JOIN old_metal_purchases p ON i.purchase_id = p.id
            WHERE i.metal_type = 'SILVER' AND i.status = 'AVAILABLE'
        `);

        const g = goldStats.rows[0];
        const s = silverStats.rows[0];

        res.json({
            // Gold
            gold_purchase_weight: parseFloat(g.purchase_weight),
            gold_exchange_weight: parseFloat(g.exchange_weight),
            gold_total_weight: parseFloat(g.total_weight),
            gold_cost: parseFloat(g.cost),
            
            // Silver
            silver_purchase_weight: parseFloat(s.purchase_weight),
            silver_exchange_weight: parseFloat(s.exchange_weight),
            silver_total_weight: parseFloat(s.total_weight),
            silver_cost: parseFloat(s.cost)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 2. GET LIST (HISTORY)
router.get('/list', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.id, p.voucher_no, p.customer_name, p.mobile, p.date, 
                   i.item_name, i.metal_type, i.gross_weight, i.net_weight, i.amount, 
                   p.net_payout, p.calculated_payout, p.payment_mode,
                   i.status
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

// 3. ADD PURCHASE (Unchanged)
router.post('/purchase', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { 
            customer_name, mobile, items, total_amount, gst_deducted, 
            calculated_payout, net_payout, payment_mode, cash_paid, online_paid 
        } = req.body;

        const voucherRes = await client.query("SELECT COUNT(*) FROM old_metal_purchases");
        const count = parseInt(voucherRes.rows[0].count) + 1;
        const voucher_no = `OM-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;

        const purchaseRes = await client.query(`
            INSERT INTO old_metal_purchases 
            (voucher_no, customer_name, mobile, total_amount, gst_deducted, calculated_payout, net_payout, payment_mode, cash_paid, online_paid, date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            RETURNING id`,
            [voucher_no, customer_name, mobile, total_amount, gst_deducted, calculated_payout, net_payout, payment_mode, cash_paid, online_paid]
        );
        const purchaseId = purchaseRes.rows[0].id;

        for (const item of items) {
            await client.query(`
                INSERT INTO old_metal_items 
                (purchase_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, amount, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE')`,
                [purchaseId, item.item_name, item.metal_type, item.gross_weight, item.less_percent, item.less_weight, item.net_weight, item.rate, item.amount]
            );
        }

        if (cash_paid > 0) {
            await client.query("UPDATE shop_assets SET cash_balance = cash_balance - $1 WHERE id = 1", [cash_paid]);
        }
        if (online_paid > 0) {
            await client.query("UPDATE shop_assets SET bank_balance = bank_balance - $1 WHERE id = 1", [online_paid]);
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

// 4. DELETE PURCHASE (Unchanged)
router.delete('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;

        const statusCheck = await client.query("SELECT status FROM old_metal_items WHERE purchase_id = $1", [id]);
        const isLocked = statusCheck.rows.some(row => row.status !== 'AVAILABLE');

        if (isLocked) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Cannot delete! Items are already sent to Refinery." });
        }

        const purchaseRes = await client.query("SELECT cash_paid, online_paid FROM old_metal_purchases WHERE id = $1", [id]);
        
        if (purchaseRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Record not found" });
        }

        const { cash_paid, online_paid } = purchaseRes.rows[0];

        await client.query('DELETE FROM old_metal_items WHERE purchase_id = $1', [id]);
        await client.query('DELETE FROM old_metal_purchases WHERE id = $1', [id]);

        if (cash_paid > 0) {
            await client.query("UPDATE shop_assets SET cash_balance = cash_balance + $1 WHERE id = 1", [cash_paid]);
        }
        if (online_paid > 0) {
            await client.query("UPDATE shop_assets SET bank_balance = bank_balance + $1 WHERE id = 1", [online_paid]);
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