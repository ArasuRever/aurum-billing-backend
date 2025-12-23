const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET DASHBOARD STATS
router.get('/stats', async (req, res) => {
    try {
        const assets = await pool.query("SELECT * FROM shop_assets WHERE id = 1");
        
        const todayStart = new Date();
        todayStart.setHours(0,0,0,0);
        
        const salesToday = await pool.query("SELECT SUM(amount) as total FROM sale_payments WHERE payment_date >= $1", [todayStart]);
        
        const expensesToday = await pool.query("SELECT SUM(amount) as total FROM general_expenses WHERE created_at >= $1 AND category != 'MANUAL_INCOME'", [todayStart]);

        res.json({
            assets: assets.rows[0] || { cash_balance: 0, bank_balance: 0 },
            today_income: parseFloat(salesToday.rows[0].total || 0),
            today_expense: parseFloat(expensesToday.rows[0].total || 0)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. GET MASTER HISTORY (Updated with Old Metal)
router.get('/history', async (req, res) => {
    const { search } = req.query;
    try {
        const searchTerm = search ? `%${search}%` : null;

        const query = `
            WITH all_txns AS (
                -- 1. SALES
                SELECT id, 'SALE_INCOME' as type, note as description, amount as cash_amount, 
                       0 as gold_weight, 0 as silver_weight, 
                       payment_mode, payment_date as date, 'IN' as direction 
                FROM sale_payments
                
                UNION ALL
                
                -- 2. VENDORS
                SELECT id, 'VENDOR_TXN' as type, description, repaid_cash_amount as cash_amount, 
                       (stock_pure_weight + repaid_metal_weight) as gold_weight, 0 as silver_weight,
                       'CASH' as payment_mode, created_at as date, 
                       CASE WHEN repaid_cash_amount > 0 THEN 'OUT' ELSE 'IN' END as direction
                FROM vendor_transactions 
                WHERE repaid_cash_amount > 0 OR stock_pure_weight > 0 OR repaid_metal_weight > 0
                
                UNION ALL
                
                -- 3. SHOP B2B
                SELECT id, 'SHOP_B2B' as type, description, cash_amount, 
                       pure_weight as gold_weight, silver_weight as silver_weight,
                       'CASH' as payment_mode, created_at as date,
                       CASE WHEN type IN ('BORROW_ADD', 'LEND_COLLECT') THEN 'IN' ELSE 'OUT' END as direction
                FROM shop_transactions 
                WHERE cash_amount > 0 OR pure_weight > 0 OR silver_weight > 0
                
                UNION ALL
                
                -- 4. GENERAL EXPENSES
                SELECT id, 'EXPENSE' as type, description, amount as cash_amount, 
                       0 as gold_weight, 0 as silver_weight, 
                       payment_mode, created_at as date, 
                       CASE WHEN category = 'MANUAL_INCOME' THEN 'IN' ELSE 'OUT' END as direction
                FROM general_expenses

                UNION ALL

                -- 5. OLD METAL PURCHASES (New Section)
                SELECT id, 'OLD_METAL' as type, CONCAT('Bought from ', customer_name, ' (', voucher_no, ')') as description, 
                       net_payout as cash_amount, 
                       0 as gold_weight, 0 as silver_weight,
                       payment_mode, date, 
                       'OUT' as direction
                FROM old_metal_purchases
            )
            SELECT * FROM all_txns
            WHERE ($1::text IS NULL OR description ILIKE $1 OR type ILIKE $1)
            ORDER BY date DESC LIMIT 300
        `;
        
        const result = await pool.query(query, [searchTerm]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. ADD EXPENSE
router.post('/expense', async (req, res) => {
    const { description, amount, category, payment_mode } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        await client.query(
            "INSERT INTO general_expenses (description, amount, category, payment_mode) VALUES ($1, $2, $3, $4)",
            [description, amount, category, payment_mode]
        );

        const col = payment_mode === 'ONLINE' ? 'bank_balance' : 'cash_balance';
        await client.query(`UPDATE shop_assets SET ${col} = ${col} - $1 WHERE id = 1`, [amount]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 4. MANUAL ADJUSTMENT
router.post('/adjust', async (req, res) => {
    const { type, amount, mode, note } = req.body; 
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const col = mode === 'ONLINE' ? 'bank_balance' : 'cash_balance';
        const operator = type === 'ADD' ? '+' : '-';
        
        await client.query(`UPDATE shop_assets SET ${col} = ${col} ${operator} $1 WHERE id = 1`, [amount]);
        
        if(note) {
             const cat = type === 'ADD' ? 'MANUAL_INCOME' : 'MANUAL_EXPENSE';
             await client.query(
                "INSERT INTO general_expenses (description, amount, category, payment_mode) VALUES ($1, $2, $3, $4)",
                [note, amount, cat, mode]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch(err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;