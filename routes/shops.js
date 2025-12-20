//
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// ... existing endpoints (add, list, get, transaction...) ...

// 1. ADD NEW SHOP
router.post('/add', async (req, res) => {
  const { shop_name, nick_id, person_name, mobile, address } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO external_shops (shop_name, nick_id, person_name, mobile, address) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [shop_name, nick_id, person_name, mobile, address]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. LIST ALL SHOPS
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM external_shops ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ... [Keep existing get/:id, transaction, etc. unchanged] ...

// [INSERT THIS NEW DELETE ENDPOINT]
// DELETE SHOP (Only if clean ledger)
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // A. Check Existence
        const check = await client.query("SELECT * FROM external_shops WHERE id = $1", [id]);
        if(check.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({error: "Shop not found"});
        }
        const shop = check.rows[0];

        // B. Check Balance (Must be Zero)
        const g = parseFloat(shop.balance_gold) || 0;
        const s = parseFloat(shop.balance_silver) || 0;
        const c = parseFloat(shop.balance_cash) || 0;
        
        if (Math.abs(g) > 0.001 || Math.abs(s) > 0.001 || Math.abs(c) > 0.01) {
             await client.query('ROLLBACK');
             return res.status(400).json({ error: `Cannot delete: Shop has outstanding balance (G: ${g}, S: ${s}, C: ${c})` });
        }
        
        // C. Check Data History (Transactions)
        const txnCheck = await client.query("SELECT id FROM shop_transactions WHERE shop_id = $1 LIMIT 1", [id]);
        if (txnCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "Cannot delete: Shop has transaction history." });
        }

        // D. Delete
        await client.query("DELETE FROM external_shops WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true, message: "Shop deleted" });

    } catch(err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Update Shop Details
router.put('/:id', async (req, res) => {
  const { id } = req.params; const { shop_name, nick_id, person_name, mobile, address } = req.body;
  try { await pool.query(`UPDATE external_shops SET shop_name=$1, nick_id=$2, person_name=$3, mobile=$4, address=$5 WHERE id=$6`, [shop_name, nick_id, person_name, mobile, address, id]); res.json({ success: true, message: 'Shop updated' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ... [Keep transaction endpoints] ...
// 4. ADD TRANSACTION (Universal Auto-Settlement)
router.post('/transaction', async (req, res) => {
  const { shop_id, action, description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Values always positive for storage & logic
    let g_val = Math.abs(parseFloat(pure_weight) || 0);
    let s_val = Math.abs(parseFloat(silver_weight) || 0);
    let c_val = Math.abs(parseFloat(cash_amount) || 0);

    // --- A. BALANCE UPDATE ---
    // Rule: 'Balance' represents WE OWE THEM (Debt).
    // INCOMING (We Take): Increases Debt (+).
    // OUTGOING (We Give): Decreases Debt (-).
    
    let multiplier = 1;
    // Actions that represent GIVING (Outgoing): Repaying Debt OR Lending (Adding Credit)
    if (action === 'BORROW_REPAY' || action === 'LEND_ADD') {
        multiplier = -1;
    }
    // Actions that represent TAKING (Incoming): Borrowing (Adding Debt) OR Collecting Credit
    // (Default multiplier = 1)

    await client.query(
      `UPDATE external_shops 
       SET balance_gold = balance_gold + $1, 
           balance_silver = balance_silver + $2, 
           balance_cash = balance_cash + $3 
       WHERE id = $4`,
      [g_val * multiplier, s_val * multiplier, c_val * multiplier, shop_id]
    );

    // --- B. CREATE TRANSACTION RECORD ---
    // We always record the event, even if it settles others.
    const txnRes = await client.query(
      `INSERT INTO shop_transactions (shop_id, type, description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount, is_settled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE) RETURNING id`,
      [shop_id, action, description, gross_weight||0, wastage_percent||0, making_charges||0, g_val, s_val, c_val]
    );
    const parentTxnId = txnRes.rows[0].id;

    // --- C. UNIVERSAL FIFO AUTO-ALLOCATION ---
    // Determine if this transaction acts as a "Payment" for the opposite list.
    
    let targetType = null;

    // If OUTGOING (We Give), we try to settle existing DEBT (BORROW_ADD).
    if (action === 'BORROW_REPAY' || action === 'LEND_ADD') {
        targetType = 'BORROW_ADD';
    }
    // If INCOMING (We Take), we try to settle existing CREDIT (LEND_ADD).
    else if (action === 'BORROW_ADD' || action === 'LEND_COLLECT') {
        targetType = 'LEND_ADD';
    }

    if (targetType) {
        // Fetch Unsettled Targets (FIFO: Oldest First)
        const itemsQuery = `
            SELECT t.id, t.pure_weight, t.silver_weight, t.cash_amount,
                   SUM(COALESCE(p.gold_paid, 0) + COALESCE(p.converted_metal_weight, 0)) as paid_gold,
                   SUM(COALESCE(p.silver_paid, 0)) as paid_silver,
                   SUM(COALESCE(p.cash_paid, 0)) as paid_cash
            FROM shop_transactions t
            LEFT JOIN shop_transaction_payments p ON t.id = p.transaction_id
            WHERE t.shop_id = $1 AND t.type = $2 AND t.is_settled = FALSE
            GROUP BY t.id
            ORDER BY t.created_at ASC
        `;
        const items = await client.query(itemsQuery, [shop_id, targetType]);

        let availG = g_val, availS = s_val, availC = c_val;

        for (let item of items.rows) {
            // Stop if we ran out of funds to allocate
            if (availG <= 0.001 && availS <= 0.001 && availC <= 0.01) break;

            const dueG = parseFloat(item.pure_weight) - parseFloat(item.paid_gold || 0);
            const dueS = parseFloat(item.silver_weight) - parseFloat(item.paid_silver || 0);
            const dueC = parseFloat(item.cash_amount) - parseFloat(item.paid_cash || 0);

            let payG = 0, payS = 0, payC = 0;

            if (availG > 0 && dueG > 0.001) { 
                payG = Math.min(availG, dueG); 
                availG -= payG; 
            }
            if (availS > 0 && dueS > 0.001) { 
                payS = Math.min(availS, dueS); 
                availS -= payS; 
            }
            if (availC > 0 && dueC > 0.01) { 
                payC = Math.min(availC, dueC); 
                availC -= payC; 
            }

            if (payG > 0 || payS > 0 || payC > 0) {
                // Link payment to the Current Transaction (parent_txn_id)
                await client.query(
                    `INSERT INTO shop_transaction_payments (transaction_id, parent_txn_id, payment_mode, gold_paid, silver_paid, cash_paid)
                     VALUES ($1, $2, 'AUTO_ALLOC', $3, $4, $5)`,
                    [item.id, parentTxnId, payG, payS, payC]
                );

                // Check Settlement
                const finalG = parseFloat(item.paid_gold || 0) + payG;
                const finalS = parseFloat(item.paid_silver || 0) + payS;
                const finalC = parseFloat(item.paid_cash || 0) + payC;

                const settled = (finalG >= parseFloat(item.pure_weight) - 0.005) &&
                                (finalS >= parseFloat(item.silver_weight) - 0.005) &&
                                (finalC >= parseFloat(item.cash_amount) - 0.01);

                if (settled) {
                    await client.query('UPDATE shop_transactions SET is_settled = TRUE WHERE id = $1', [item.id]);
                }
            }
        }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 5. DELETE TRANSACTION (Undo/Revert with Un-Settlement)
router.delete('/transaction/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txnRes = await client.query('SELECT * FROM shop_transactions WHERE id = $1', [id]);
    if (txnRes.rows.length === 0) throw new Error('Transaction not found');
    const txn = txnRes.rows[0];

    // --- A. REVERSE BALANCE ---
    let g = parseFloat(txn.pure_weight) || 0;
    let s = parseFloat(txn.silver_weight) || 0;
    let c = parseFloat(txn.cash_amount) || 0;

    // Reverse logic:
    // If it was Outgoing (Repay/LendAdd), it decreased debt. To revert, we Increase (+).
    // If it was Incoming (Borrow/Collect), it increased debt. To revert, we Decrease (-).
    
    let multiplier = 1;
    if (txn.type === 'BORROW_REPAY' || txn.type === 'LEND_ADD') {
        multiplier = 1; // Add back
    } else {
        multiplier = -1; // Subtract
    }

    await client.query(
      `UPDATE external_shops 
       SET balance_gold = balance_gold + $1, 
           balance_silver = balance_silver + $2, 
           balance_cash = balance_cash + $3 
       WHERE id = $4`,
      [g * multiplier, s * multiplier, c * multiplier, txn.shop_id]
    );

    // --- B. UN-SETTLE ITEMS ---
    // Any items that were paid/settled by THIS transaction ID must be reverted.
    const pRes = await client.query(`SELECT transaction_id FROM shop_transaction_payments WHERE parent_txn_id = $1`, [id]);
    if (pRes.rows.length > 0) {
        const ids = pRes.rows.map(r => r.transaction_id);
        // Delete payments
        await client.query(`DELETE FROM shop_transaction_payments WHERE parent_txn_id = $1`, [id]);
        // Un-settle items
        await client.query(`UPDATE shop_transactions SET is_settled = FALSE WHERE id = ANY($1::int[])`, [ids]);
    }

    await client.query('DELETE FROM shop_transactions WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 6. UPDATE TRANSACTION (Edit)
router.put('/transaction/:id', async (req, res) => {
  const { id } = req.params;
  const { description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldRes = await client.query('SELECT * FROM shop_transactions WHERE id = $1', [id]);
    const oldTxn = oldRes.rows[0];

    // Revert Old Balance
    let om = (oldTxn.type === 'BORROW_REPAY' || oldTxn.type === 'LEND_ADD') ? 1 : -1;
    await client.query(
        `UPDATE external_shops SET balance_gold=balance_gold+$1, balance_silver=balance_silver+$2, balance_cash=balance_cash+$3 WHERE id=$4`, 
        [parseFloat(oldTxn.pure_weight)*om, parseFloat(oldTxn.silver_weight)*om, parseFloat(oldTxn.cash_amount)*om, oldTxn.shop_id]
    );

    await client.query(`UPDATE shop_transactions SET description=$1, gross_weight=$2, wastage_percent=$3, making_charges=$4, pure_weight=$5, silver_weight=$6, cash_amount=$7 WHERE id=$8`,
      [description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount, id]);

    // Apply New Balance
    let nm = (oldTxn.type === 'BORROW_REPAY' || oldTxn.type === 'LEND_ADD') ? -1 : 1;
    await client.query(
        `UPDATE external_shops SET balance_gold=balance_gold+$1, balance_silver=balance_silver+$2, balance_cash=balance_cash+$3 WHERE id=$4`, 
        [parseFloat(pure_weight)*nm, parseFloat(silver_weight)*nm, parseFloat(cash_amount)*nm, oldTxn.shop_id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 7. SETTLE ITEM (Manual)
router.post('/settle-item', async (req, res) => {
    const { transaction_id, shop_id, payment_mode, gold_val, silver_val, cash_val, metal_rate, converted_weight } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO shop_transaction_payments (transaction_id, payment_mode, gold_paid, silver_paid, cash_paid, metal_rate, converted_metal_weight) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [transaction_id, payment_mode, gold_val||0, silver_val||0, cash_val||0, metal_rate||0, converted_weight||0]
        );
        
        const tRes = await client.query('SELECT type FROM shop_transactions WHERE id=$1', [transaction_id]);
        const type = tRes.rows[0].type;
        
        let g = (parseFloat(gold_val)||0) + (parseFloat(converted_weight)||0);
        let s = parseFloat(silver_val)||0;
        let c = parseFloat(cash_val)||0;

        // Manual Settle Logic:
        // If settling BORROW_ADD (Paying debt), balance reduces (-).
        // If settling LEND_ADD (Collecting credit), balance increases (+).
        let mult = (type === 'BORROW_ADD') ? -1 : 1;

        await client.query(`UPDATE external_shops SET balance_gold=balance_gold+$1, balance_silver=balance_silver+$2, balance_cash=balance_cash+$3 WHERE id=$4`, 
            [g*mult, s*mult, c*mult, shop_id]);
        
        // Settlement Check
        const sumRes = await client.query(`
            SELECT t.pure_weight, t.silver_weight, t.cash_amount,
                   SUM(COALESCE(p.gold_paid,0) + COALESCE(p.converted_metal_weight,0)) as paid_gold,
                   SUM(COALESCE(p.silver_paid,0)) as paid_silver,
                   SUM(COALESCE(p.cash_paid,0)) as paid_cash
            FROM shop_transactions t 
            LEFT JOIN shop_transaction_payments p ON t.id = p.transaction_id
            WHERE t.id = $1 GROUP BY t.id`, [transaction_id]);
            
        const r = sumRes.rows[0];
        if (parseFloat(r.paid_gold) >= parseFloat(r.pure_weight)-0.005 && 
            parseFloat(r.paid_silver) >= parseFloat(r.silver_weight)-0.005 && 
            parseFloat(r.paid_cash) >= parseFloat(r.cash_amount)-0.01) {
            await client.query('UPDATE shop_transactions SET is_settled=TRUE WHERE id=$1', [transaction_id]);
        }
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(err) { await client.query('ROLLBACK'); res.status(500).json({error:err.message}); } finally { client.release(); }
});

// 8. & 9. Standard Routes
router.get('/payment-history/:txnId', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM shop_transaction_payments WHERE transaction_id = $1 ORDER BY created_at DESC', [req.params.txnId]); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. GET SHOP DETAILS
router.get('/:id', async (req, res) => {
  try {
    const shopRes = await pool.query('SELECT * FROM external_shops WHERE id = $1', [req.params.id]);
    const transRes = await pool.query('SELECT * FROM shop_transactions WHERE shop_id = $1 ORDER BY created_at DESC', [req.params.id]);
    
    // Fetch aggregated payments per item
    const paymentRes = await pool.query(`
        SELECT transaction_id, 
               SUM(COALESCE(gold_paid, 0) + COALESCE(converted_metal_weight, 0)) as total_gold_paid,
               SUM(COALESCE(silver_paid, 0)) as total_silver_paid,
               SUM(COALESCE(cash_paid, 0)) as total_cash_paid
        FROM shop_transaction_payments
        GROUP BY transaction_id
    `);

    const paymentsMap = {};
    paymentRes.rows.forEach(p => { paymentsMap[p.transaction_id] = p; });

    const transactions = transRes.rows.map(t => ({
        ...t,
        total_gold_paid: parseFloat(paymentsMap[t.id]?.total_gold_paid || 0),
        total_silver_paid: parseFloat(paymentsMap[t.id]?.total_silver_paid || 0),
        total_cash_paid: parseFloat(paymentsMap[t.id]?.total_cash_paid || 0)
    }));

    res.json({ shop: shopRes.rows[0], transactions: transactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;