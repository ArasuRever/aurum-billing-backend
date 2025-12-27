const express = require('express');
const router = express.Router();
const pool = require('../config/db'); 

// 1. GET STATS (Aggregated: Direct Purchase + Bill Exchange)
router.get('/stats', async (req, res) => {
    try {
        // A. Direct Purchases
        const goldPurchase = await pool.query(`
            SELECT COALESCE(SUM(net_weight), 0) as weight, COALESCE(SUM(amount), 0) as cost 
            FROM old_metal_items WHERE metal_type = 'GOLD'
        `);
        const silverPurchase = await pool.query(`
            SELECT COALESCE(SUM(net_weight), 0) as weight, COALESCE(SUM(amount), 0) as cost 
            FROM old_metal_items WHERE metal_type = 'SILVER'
        `);

        // B. Bill Exchanges
        const goldExchange = await pool.query(`
            SELECT COALESCE(SUM(net_weight), 0) as weight, COALESCE(SUM(total_amount), 0) as cost 
            FROM sale_exchange_items WHERE metal_type = 'GOLD'
        `);
        const silverExchange = await pool.query(`
            SELECT COALESCE(SUM(net_weight), 0) as weight, COALESCE(SUM(total_amount), 0) as cost 
            FROM sale_exchange_items WHERE metal_type = 'SILVER'
        `);

        // C. Combine
        res.json({
            gold_weight: parseFloat(goldPurchase.rows[0].weight) + parseFloat(goldExchange.rows[0].weight),
            gold_cost: parseFloat(goldPurchase.rows[0].cost) + parseFloat(goldExchange.rows[0].cost),
            silver_weight: parseFloat(silverPurchase.rows[0].weight) + parseFloat(silverExchange.rows[0].weight),
            silver_cost: parseFloat(silverPurchase.rows[0].cost) + parseFloat(silverExchange.rows[0].cost)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 2. GET LIST (HISTORY) - UPDATED TO FETCH STATUS
router.get('/list', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.id, p.voucher_no, p.customer_name, p.mobile, p.date, 
                   i.item_name, i.metal_type, i.net_weight, i.amount, 
                   p.net_payout, p.calculated_payout,
                   i.status -- <--- ADDED STATUS CHECK
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

// 4. DELETE PURCHASE - UPDATED WITH SAFETY LOCK
router.delete('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;

        // A. CHECK IF LOCKED (Refinery)
        const statusCheck = await client.query("SELECT status FROM old_metal_items WHERE purchase_id = $1", [id]);
        const isLocked = statusCheck.rows.some(row => row.status !== 'AVAILABLE');

        if (isLocked) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Cannot delete! Items are already sent to Refinery." });
        }

        // B. Fetch details for Refund logic
        const purchaseRes = await client.query("SELECT cash_paid, online_paid FROM old_metal_purchases WHERE id = $1", [id]);
        
        if (purchaseRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Record not found" });
        }

        const { cash_paid, online_paid } = purchaseRes.rows[0];

        // C. Delete Data
        await client.query('DELETE FROM old_metal_items WHERE purchase_id = $1', [id]);
        await client.query('DELETE FROM old_metal_purchases WHERE id = $1', [id]);

        // D. Revert Assets
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