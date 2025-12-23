const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET COMBINED STATISTICS
router.get('/stats', async (req, res) => {
    try {
        const direct = await pool.query(`SELECT metal_type, SUM(net_weight) as weight, SUM(amount_paid) as cost FROM old_metal_purchases GROUP BY metal_type`);
        const exchange = await pool.query(`SELECT metal_type, SUM(net_weight) as weight, SUM(total_amount) as cost FROM sale_exchange_items GROUP BY metal_type`);

        const totals = { gold_weight: 0, gold_cost: 0, silver_weight: 0, silver_cost: 0 };
        
        [...direct.rows, ...exchange.rows].forEach(row => {
            if(row.metal_type === 'GOLD') {
                totals.gold_weight += parseFloat(row.weight || 0);
                totals.gold_cost += parseFloat(row.cost || 0);
            } else if(row.metal_type === 'SILVER') {
                totals.silver_weight += parseFloat(row.weight || 0);
                totals.silver_cost += parseFloat(row.cost || 0);
            }
        });
        res.json(totals);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. GET HISTORY
router.get('/list', async (req, res) => {
    try {
        const query = `
            SELECT id, 'DIRECT_PURCHASE' as source, customer_name, mobile, item_name, metal_type, net_weight, amount_paid as amount, created_at as date, voucher_no 
            FROM old_metal_purchases
            UNION ALL
            SELECT e.id, 'BILL_EXCHANGE' as source, s.customer_name, s.customer_phone as mobile, e.item_name, e.metal_type, e.net_weight, e.total_amount as amount, s.created_at as date, s.invoice_number as voucher_no
            FROM sale_exchange_items e JOIN sales s ON e.sale_id = s.id
            ORDER BY date DESC LIMIT 200
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. ADD MULTI-ITEM PURCHASE
router.post('/purchase', async (req, res) => {
    const { customer_name, mobile, items, total_amount, gst_deducted, net_payout } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const voucherNo = `PUR-${Date.now()}`;
        
        // A. Insert Each Item
        for (const item of items) {
             await client.query(
                `INSERT INTO old_metal_purchases 
                (voucher_no, customer_name, mobile, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, amount_paid)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    voucherNo, customer_name, mobile, 
                    item.item_name, item.metal_type, 
                    item.gross_weight, item.less_percent, item.less_weight, item.net_weight, 
                    item.rate, item.amount // This is the ITEM value (before global GST split)
                ]
            );
        }

        // B. Update Ledger (Money Out)
        if (parseFloat(net_payout) > 0) {
            await client.query(`UPDATE shop_assets SET cash_balance = cash_balance - $1 WHERE id = 1`, [net_payout]);
            
            // Log Expense
            await client.query(
                `INSERT INTO general_expenses (description, amount, category, payment_mode) 
                 VALUES ($1, $2, 'OLD_METAL_PURCHASE', 'CASH')`,
                [`Bought Old Metal (${items.length} items) - Voucher ${voucherNo}`, net_payout]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, voucher_no: voucherNo });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;