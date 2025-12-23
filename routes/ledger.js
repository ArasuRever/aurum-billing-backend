const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET DASHBOARD STATS (Assets Only)
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

// 2. GET MASTER HISTORY (SAFE MODE)
// This version uses NULL placeholders for columns that might be missing in your DB
router.get('/history', async (req, res) => {
    const { date, search } = req.query; 
    
    try {
        const searchTerm = search ? `%${search}%` : null;
        
        // Date Filter Logic
        let dateFilter = '1=1';
        if (date) {
            dateFilter = `DATE(date) = '${date}'`;
        }

        const query = `
            WITH all_txns AS (
                -- 1. SALES
                SELECT id, 
                       'SALE_INCOME' as type, 
                       note as description, 
                       amount as cash_amount, 
                       0::numeric as gold_weight, 
                       0::numeric as silver_weight, 
                       payment_mode, 
                       payment_date as date, 
                       'IN' as direction,
                       NULL::integer as reference_id, 
                       NULL::text as reference_type
                FROM sale_payments
                
                UNION ALL
                
                -- 2. VENDORS (SAFE MODE: Using NULL for reference columns to prevent crash)
                SELECT id, 
                       'VENDOR_TXN' as type, 
                       description, 
                       repaid_cash_amount as cash_amount, 
                       CASE WHEN metal_type = 'GOLD' THEN (stock_pure_weight + repaid_metal_weight) ELSE 0 END as gold_weight, 
                       CASE WHEN metal_type = 'SILVER' THEN (stock_pure_weight + repaid_metal_weight) ELSE 0 END as silver_weight,
                       CASE WHEN repaid_cash_amount > 0 THEN 'CASH' ELSE 'STOCK' END as payment_mode, 
                       created_at as date, 
                       CASE WHEN repaid_cash_amount > 0 THEN 'OUT' ELSE 'IN' END as direction,
                       NULL::integer as reference_id, 
                       NULL::text as reference_type
                FROM vendor_transactions 
                WHERE repaid_cash_amount > 0 OR stock_pure_weight > 0 OR repaid_metal_weight > 0
                
                UNION ALL
                
                -- 3. SHOP B2B
                SELECT id, 
                       'SHOP_B2B' as type, 
                       description, 
                       cash_amount, 
                       pure_weight as gold_weight, 
                       silver_weight as silver_weight,
                       'CASH' as payment_mode, 
                       created_at as date,
                       CASE WHEN type IN ('BORROW_ADD', 'LEND_COLLECT') THEN 'IN' ELSE 'OUT' END as direction,
                       NULL::integer as reference_id, 
                       NULL::text as reference_type
                FROM shop_transactions 
                
                UNION ALL
                
                -- 4. GENERAL EXPENSES
                SELECT id, 
                       'EXPENSE' as type, 
                       description, 
                       amount as cash_amount, 
                       0::numeric as gold_weight, 
                       0::numeric as silver_weight, 
                       payment_mode, 
                       created_at as date, 
                       CASE WHEN category = 'MANUAL_INCOME' THEN 'IN' ELSE 'OUT' END as direction,
                       NULL::integer as reference_id, 
                       NULL::text as reference_type
                FROM general_expenses

                UNION ALL

                -- 5. OLD METAL
                SELECT id, 
                       'OLD_METAL' as type, 
                       CONCAT('Bought from ', customer_name, ' (', voucher_no, ')') as description, 
                       net_payout as cash_amount, 
                       0::numeric as gold_weight, 
                       0::numeric as silver_weight,
                       payment_mode, 
                       date, 
                       'OUT' as direction,
                       NULL::integer as reference_id, 
                       NULL::text as reference_type
                FROM old_metal_purchases

                UNION ALL
                
                -- 6. REFINERY
                SELECT id, 
                       'REFINERY' as type, 
                       CONCAT('Refinery Batch ', batch_no) as description,
                       0::numeric as cash_amount,
                       CASE WHEN metal_type='GOLD' THEN gross_weight ELSE 0 END as gold_weight,
                       CASE WHEN metal_type='SILVER' THEN gross_weight ELSE 0 END as silver_weight,
                       'STOCK' as payment_mode, 
                       sent_date as date,
                       'OUT' as direction,
                       id as reference_id, 
                       'REFINERY_BATCH' as reference_type
                FROM refinery_batches
            )
            SELECT * FROM all_txns
            WHERE (${dateFilter}) 
            AND ($1::text IS NULL OR description ILIKE $1 OR type ILIKE $1)
            ORDER BY date DESC
        `;
        
        const result = await pool.query(query, [searchTerm]);
        
        // Calculate Day Stats
        let dayStats = { income: 0, expense: 0, gold_in: 0, gold_out: 0, silver_in: 0, silver_out: 0 };
        
        result.rows.forEach(row => {
            const amt = parseFloat(row.cash_amount || 0);
            const gw = parseFloat(row.gold_weight || 0);
            const sw = parseFloat(row.silver_weight || 0);

            if (amt > 0) {
                if(row.direction === 'IN') dayStats.income += amt;
                else dayStats.expense += amt;
            }
            if(row.direction === 'IN') {
                dayStats.gold_in += gw;
                dayStats.silver_in += sw;
            } else {
                dayStats.gold_out += gw;
                dayStats.silver_out += sw;
            }
        });

        res.json({ transactions: result.rows, dayStats });
    } catch (err) { 
        console.error("Ledger History Error:", err);
        res.status(500).json({ error: err.message }); 
    }
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