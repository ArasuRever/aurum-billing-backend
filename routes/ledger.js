const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET DASHBOARD STATS (Merged: Assets + Pending Expenses)
router.get('/stats', async (req, res) => {
    try {
        const assetRes = await pool.query('SELECT cash_balance, bank_balance FROM shop_assets WHERE id = 1');
        
        // Get Pending (Unrecorded) Expenses Count & Total
        const pendingRes = await pool.query(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total 
            FROM general_expenses WHERE status = 'PENDING'
        `);

        res.json({
            assets: assetRes.rows[0],
            pending_expenses: pendingRes.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. GET MASTER HISTORY (Restored Full Logic + Status Filter)
router.get('/history', async (req, res) => {
    const { date, search } = req.query; 
    
    try {
        const searchTerm = search ? `%${search}%` : null;
        
        // Date Filter
        let dateFilter = '1=1';
        if (date) {
            dateFilter = `DATE(date) = '${date}'`;
        }

        const query = `
            WITH all_txns AS (
                -- 1. SALES
                SELECT id, 'SALE_INCOME' as type, note as description, amount as cash_amount, 
                       0::numeric as gold_weight, 0::numeric as silver_weight, 
                       payment_mode, payment_date as date, 'IN' as direction,
                       NULL::integer as reference_id, NULL::text as reference_type
                FROM sale_payments
                
                UNION ALL
                
                -- 2. VENDORS
                SELECT id, 'VENDOR_TXN' as type, description, repaid_cash_amount as cash_amount, 
                       CASE WHEN metal_type = 'GOLD' THEN (stock_pure_weight + repaid_metal_weight) ELSE 0 END as gold_weight, 
                       CASE WHEN metal_type = 'SILVER' THEN (stock_pure_weight + repaid_metal_weight) ELSE 0 END as silver_weight,
                       CASE WHEN repaid_cash_amount > 0 THEN 'CASH' ELSE 'STOCK' END as payment_mode, 
                       created_at as date, 
                       CASE WHEN repaid_cash_amount > 0 THEN 'OUT' ELSE 'IN' END as direction,
                       reference_id, reference_type
                FROM vendor_transactions 
                WHERE repaid_cash_amount > 0 OR stock_pure_weight > 0 OR repaid_metal_weight > 0
                
                UNION ALL
                
                -- 3. SHOP B2B
                SELECT id, 'SHOP_B2B' as type, description, cash_amount, 
                       pure_weight as gold_weight, silver_weight as silver_weight,
                       'CASH' as payment_mode, created_at as date,
                       CASE WHEN type IN ('BORROW_ADD', 'LEND_COLLECT') THEN 'IN' ELSE 'OUT' END as direction,
                       NULL::integer as reference_id, NULL::text as reference_type
                FROM shop_transactions 
                
                UNION ALL
                
                -- 4. GENERAL EXPENSES (FILTERED: Only PAID)
                SELECT id, 'EXPENSE' as type, description, amount as cash_amount, 
                       0::numeric as gold_weight, 0::numeric as silver_weight, 
                       payment_mode, created_at as date, 
                       CASE WHEN category = 'MANUAL_INCOME' THEN 'IN' ELSE 'OUT' END as direction,
                       NULL::integer as reference_id, NULL::text as reference_type
                FROM general_expenses
                WHERE status = 'PAID' -- <--- CRITICAL FIX: Hide unrecorded from main flow

                UNION ALL

                -- 5. OLD METAL (Includes Exchanges)
                SELECT p.id, 'OLD_METAL' as type, 
                       CONCAT(CASE WHEN p.payment_mode='EXCHANGE' THEN 'Exchange: ' ELSE 'Bought: ' END, COALESCE(p.customer_name, 'Guest'), ' #', COALESCE(p.voucher_no, '-')) as description, 
                       p.net_payout as cash_amount, 
                       (SELECT COALESCE(SUM(net_weight), 0) FROM old_metal_items WHERE purchase_id = p.id AND (metal_type ILIKE '%GOLD%' OR metal_type = 'Au')) as gold_weight, 
                       (SELECT COALESCE(SUM(net_weight), 0) FROM old_metal_items WHERE purchase_id = p.id AND (metal_type ILIKE '%SILVER%' OR metal_type ILIKE '%AG%')) as silver_weight,
                       p.payment_mode, p.date, 'OUT' as direction, 
                       NULL::integer as reference_id, NULL::text as reference_type
                FROM old_metal_purchases p

                UNION ALL
                
                -- 6. REFINERY
                SELECT id, 'REFINERY' as type, CONCAT('Refinery Batch ', batch_no) as description,
                       0::numeric as cash_amount,
                       CASE WHEN metal_type='GOLD' THEN gross_weight ELSE 0 END as gold_weight,
                       CASE WHEN metal_type='SILVER' THEN gross_weight ELSE 0 END as silver_weight,
                       'STOCK' as payment_mode, sent_date as date, 'OUT' as direction,
                       id as reference_id, 'REFINERY_BATCH' as reference_type
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
            if (amt > 0) {
                if(row.direction === 'IN') dayStats.income += amt;
                else dayStats.expense += amt;
            }
            // Add other metal stats logic here if needed from your previous code
        });

        res.json({ transactions: result.rows, dayStats });
    } catch (err) { 
        console.error("Ledger History Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// 3. ADD EXPENSE (With Unrecorded Logic)
router.post('/expense', async (req, res) => {
    const { description, amount, category, payment_mode, is_unrecorded } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Status: PENDING (Unrecorded) vs PAID (Recorded)
        const status = is_unrecorded ? 'PENDING' : 'PAID';
        
        await client.query(
            `INSERT INTO general_expenses (description, amount, category, payment_mode, expense_date, status)
             VALUES ($1, $2, $3, $4, NOW(), $5)`,
            [description, amount, category, payment_mode, status]
        );

        // ONLY Deduct Cash/Bank if it is RECORDED
        if (!is_unrecorded) {
            const col = payment_mode === 'ONLINE' ? 'bank_balance' : 'cash_balance';
            await client.query(`UPDATE shop_assets SET ${col} = ${col} - $1 WHERE id = 1`, [amount]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: is_unrecorded ? "Added to Pending" : "Expense Recorded" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 4. GET PENDING EXPENSES
router.get('/pending-expenses', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM general_expenses WHERE status = 'PENDING' ORDER BY expense_date DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. ALLOCATE EXPENSE TO SHOP (New Logic)
router.post('/allocate-expense', async (req, res) => {
    const { expense_id, shop_id } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        const expRes = await client.query("SELECT * FROM general_expenses WHERE id = $1 AND status = 'PENDING'", [expense_id]);
        if (expRes.rows.length === 0) throw new Error("Expense not found");
        const expense = expRes.rows[0];

        // 1. Create Shop Debt (BORROW_ADD)
        await client.query(
            `INSERT INTO shop_transactions (shop_id, type, description, cash_amount, pure_weight, silver_weight, is_settled)
             VALUES ($1, 'BORROW_ADD', $2, $3, 0, 0, FALSE)`,
            [shop_id, `Exp Alloc: ${expense.description}`, expense.amount]
        );

        // 2. Update Shop Balance
        await client.query(
            `UPDATE external_shops SET balance_cash = balance_cash + $1 WHERE id = $2`,
            [expense.amount, shop_id]
        );

        // 3. Mark Expense PAID
        await client.query(
            `UPDATE general_expenses SET status = 'PAID', shop_id = $1 WHERE id = $2`,
            [shop_id, expense_id]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 6. ADJUST BALANCE (Manual)
router.post('/adjust', async (req, res) => {
    const { type, amount, mode, note } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const col = mode === 'ONLINE' ? 'bank_balance' : 'cash_balance';
        const operator = type === 'ADD' ? '+' : '-';
        await client.query(`UPDATE shop_assets SET ${col} = ${col} ${operator} $1 WHERE id = 1`, [amount]);
        
        // Optional: Log manual adjustment as expense/income
        const cat = type === 'ADD' ? 'MANUAL_INCOME' : 'MANUAL_EXPENSE';
        await client.query("INSERT INTO general_expenses (description, amount, category, payment_mode, status) VALUES ($1, $2, $3, $4, 'PAID')", [note, amount, cat, mode]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch(err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

module.exports = router;