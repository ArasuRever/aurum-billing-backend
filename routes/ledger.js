const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET DASHBOARD STATS (Live Balances & Today's Performance)
router.get('/stats', async (req, res) => {
    try {
        // Fetch current balances
        const assets = await pool.query("SELECT * FROM shop_assets WHERE id = 1");
        
        // Calculate Today's Totals (Midnight to Now)
        const todayStart = new Date();
        todayStart.setHours(0,0,0,0);
        
        // Income: Payments received today (Sales)
        const salesToday = await pool.query("SELECT SUM(amount) as total FROM sale_payments WHERE payment_date >= $1", [todayStart]);
        
        // Expenses: General expenses today
        const expensesToday = await pool.query("SELECT SUM(amount) as total FROM general_expenses WHERE created_at >= $1", [todayStart]);

        res.json({
            assets: assets.rows[0] || { cash_balance: 0, bank_balance: 0 },
            today_income: parseFloat(salesToday.rows[0].total || 0),
            today_expense: parseFloat(expensesToday.rows[0].total || 0)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. GET MASTER HISTORY (The Unified Ledger)
router.get('/history', async (req, res) => {
    try {
        /* This UNION query merges 4 different sources into one list:
           1. Customer Sale Payments (Income)
           2. Vendor Transactions (Cash Out/In & Metal info)
           3. Shop/B2B Transactions (Borrow/Lend Cash)
           4. General Expenses (Rent, Tea, etc.)
        */
        const query = `
            -- 1. SALES PAYMENTS
            SELECT id, 'SALE_INCOME' as type, note as description, amount as cash_amount, 0 as metal_weight, payment_mode, payment_date as date, 'IN' as direction 
            FROM sale_payments
            
            UNION ALL
            
            -- 2. VENDOR PAYMENTS (Cash & Metal)
            SELECT id, 'VENDOR_TXN' as type, description, repaid_cash_amount as cash_amount, (stock_pure_weight + repaid_metal_weight) as metal_weight, 'CASH' as payment_mode, created_at as date, 
            CASE WHEN repaid_cash_amount > 0 THEN 'OUT' ELSE 'IN' END as direction
            FROM vendor_transactions 
            WHERE repaid_cash_amount > 0 OR stock_pure_weight > 0 OR repaid_metal_weight > 0
            
            UNION ALL
            
            -- 3. SHOP B2B (Cash & Metal)
            SELECT id, 'SHOP_B2B' as type, description, cash_amount, (pure_weight + silver_weight) as metal_weight, 'CASH' as payment_mode, created_at as date,
            CASE WHEN type IN ('BORROW_ADD', 'LEND_COLLECT') THEN 'IN' ELSE 'OUT' END as direction
            FROM shop_transactions 
            WHERE cash_amount > 0 OR pure_weight > 0 OR silver_weight > 0
            
            UNION ALL
            
            -- 4. GENERAL EXPENSES
            SELECT id, 'EXPENSE' as type, description, amount as cash_amount, 0 as metal_weight, payment_mode, created_at as date, 'OUT' as direction
            FROM general_expenses

            ORDER BY date DESC LIMIT 150
        `;
        
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. ADD EXPENSE (Updates Balance)
router.post('/expense', async (req, res) => {
    const { description, amount, category, payment_mode } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Log Expense
        await client.query(
            "INSERT INTO general_expenses (description, amount, category, payment_mode) VALUES ($1, $2, $3, $4)",
            [description, amount, category, payment_mode]
        );

        // Deduct from Balance
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

// 4. MANUAL ADJUSTMENT (Fix Balances)
router.post('/adjust', async (req, res) => {
    const { type, amount, mode, note } = req.body; // type: 'ADD' or 'REMOVE'
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const col = mode === 'ONLINE' ? 'bank_balance' : 'cash_balance';
        const operator = type === 'ADD' ? '+' : '-';
        
        await client.query(`UPDATE shop_assets SET ${col} = ${col} ${operator} $1 WHERE id = 1`, [amount]);
        
        // Optional: Log adjustment as a special expense/income record for audit
        if(note) {
             await client.query(
                "INSERT INTO general_expenses (description, amount, category, payment_mode) VALUES ($1, 0, 'ADJUSTMENT_LOG', $2)",
                [`Manual ${type}: ${amount} (${note})`, mode]
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