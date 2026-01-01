// ... (Imports and Routes 1-3 remain same) ...
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

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

// 4. ADD TRANSACTION (UPDATED METAL CHECK)
router.post('/transaction', async (req, res) => {
  const { shop_id, action, description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount, transfer_cash, inventory_item_id, quantity } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inputG = Math.abs(parseFloat(pure_weight) || 0);
    let inputS = Math.abs(parseFloat(silver_weight) || 0);
    let c_val = Math.abs(parseFloat(cash_amount) || 0);
    const lendQty = parseInt(quantity) || 1;

    // === BROADER METAL CHECK ===
    if (inventory_item_id) {
        const itemCheck = await client.query("SELECT metal_type FROM inventory_items WHERE id = $1", [inventory_item_id]);
        if (itemCheck.rows.length > 0) {
            const dbMetal = (itemCheck.rows[0].metal_type || '').toUpperCase();
            const totalPure = inputG + inputS; 

            // Matches "SILVER", "AG", "925", "STERLING", "STG"
            if (dbMetal.includes('SILVER') || dbMetal.includes('AG') || dbMetal.includes('925') || dbMetal.includes('STERLING') || dbMetal.includes('STG')) {
                inputS = totalPure; // Force into Silver
                inputG = 0;         // Clear Gold
            } else {
                inputG = totalPure; // Force into Gold
                inputS = 0;         // Clear Silver
            }
        }
    }

    // ... (Ledger and Balance Updates remain same) ...
    const shouldUpdateLedger = (transfer_cash !== false); 
    if (c_val > 0.01 && shouldUpdateLedger) {
        let assetChange = 0;
        if (action === 'BORROW_ADD' || action === 'LEND_COLLECT') assetChange = c_val;
        else if (action === 'LEND_ADD' || action === 'BORROW_REPAY') assetChange = -c_val;
        if (assetChange !== 0) await client.query(`UPDATE shop_assets SET cash_balance = cash_balance + $1 WHERE id = 1`, [assetChange]);
    }

    let multiplier = 1;
    if (action === 'BORROW_REPAY' || action === 'LEND_ADD') multiplier = -1;

    await client.query(
      `UPDATE external_shops 
       SET balance_gold = balance_gold + $1, 
           balance_silver = balance_silver + $2, 
           balance_cash = balance_cash + $3 
       WHERE id = $4`,
      [inputG * multiplier, inputS * multiplier, c_val * multiplier, shop_id]
    );

    // ... (Inventory Status Update remains same) ...
    if (action === 'LEND_ADD' && inventory_item_id) {
        const itemRes = await client.query("SELECT * FROM inventory_items WHERE id = $1", [inventory_item_id]);
        if(itemRes.rows.length > 0) {
            const item = itemRes.rows[0];
            const lentWt = parseFloat(gross_weight) || 0;

            if (item.stock_type === 'BULK') {
                const newWt = parseFloat(item.gross_weight) - lentWt;
                const newQty = Math.max(0, parseInt(item.quantity) - lendQty);
                const newStatus = (newWt < 0.01 && newQty === 0) ? 'LENT' : 'AVAILABLE'; 
                await client.query(`UPDATE inventory_items SET gross_weight = $1, quantity = $2, status = $3 WHERE id = $4`, [newWt, newQty, newStatus, inventory_item_id]);
                await client.query(`INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description) VALUES ($1, 'LEND', $2, $3, 'Lent to Shop')`, [inventory_item_id, -lendQty, -lentWt]);
            } else {
                await client.query("UPDATE inventory_items SET status = 'LENT' WHERE id = $1", [inventory_item_id]);
                await client.query(`INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description) VALUES ($1, 'LEND', -1, $2, 'Lent to Shop')`, [inventory_item_id, -(parseFloat(gross_weight)||0)]);
            }
        }
    }

    // ... (Transaction Insert remains same) ...
    const txnRes = await client.query(
      `INSERT INTO shop_transactions (shop_id, type, description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount, is_settled, inventory_item_id, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11) RETURNING id`,
      [shop_id, action, description, gross_weight||0, wastage_percent||0, making_charges||0, inputG, inputS, c_val, inventory_item_id || null, lendQty]
    );
    const parentTxnId = txnRes.rows[0].id;

    // ... (FIFO Allocation Logic remains same) ...
    let targetType = null;
    if (action === 'BORROW_REPAY' || action === 'LEND_ADD') targetType = 'BORROW_ADD';
    else if (action === 'BORROW_ADD' || action === 'LEND_COLLECT') targetType = 'LEND_ADD';

    if (targetType) {
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

        let availG = inputG, availS = inputS, availC = c_val;

        for (let item of items.rows) {
            if (availG <= 0.001 && availS <= 0.001 && availC <= 0.01) break;

            const dueG = parseFloat(item.pure_weight) - parseFloat(item.paid_gold || 0);
            const dueS = parseFloat(item.silver_weight) - parseFloat(item.paid_silver || 0);
            const dueC = parseFloat(item.cash_amount) - parseFloat(item.paid_cash || 0);

            let payG = 0, payS = 0, payC = 0;

            if (availG > 0 && dueG > 0.001) { payG = Math.min(availG, dueG); availG -= payG; }
            if (availS > 0 && dueS > 0.001) { payS = Math.min(availS, dueS); availS -= payS; }
            if (availC > 0 && dueC > 0.01) { payC = Math.min(availC, dueC); availC -= payC; }

            if (payG > 0 || payS > 0 || payC > 0) {
                await client.query(
                    `INSERT INTO shop_transaction_payments (transaction_id, parent_txn_id, payment_mode, gold_paid, silver_paid, cash_paid)
                     VALUES ($1, $2, 'AUTO_ALLOC', $3, $4, $5)`,
                    [item.id, parentTxnId, payG, payS, payC]
                );

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
        
        // Mark NEW Transaction as settled if fully used up
        if (availG <= 0.005 && availS <= 0.005 && availC <= 0.01) {
            await client.query('UPDATE shop_transactions SET is_settled = TRUE WHERE id = $1', [parentTxnId]);
        }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// ... (Delete/Update/Settle logic remains same as previous turns) ...
// 5. DELETE TRANSACTION
router.delete('/transaction/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txnRes = await client.query('SELECT * FROM shop_transactions WHERE id = $1', [id]);
    if (txnRes.rows.length === 0) throw new Error('Transaction not found');
    const txn = txnRes.rows[0];

    if (txn.inventory_item_id && txn.type === 'LEND_ADD') {
        const itemRes = await client.query("SELECT * FROM inventory_items WHERE id = $1", [txn.inventory_item_id]);
        if (itemRes.rows.length > 0) {
            const item = itemRes.rows[0];
            const restoreWt = parseFloat(txn.gross_weight) || 0;
            const restoreQty = parseInt(txn.quantity) || 1;

            if (item.stock_type === 'BULK') {
                await client.query(
                    `UPDATE inventory_items 
                     SET gross_weight = gross_weight + $1, quantity = quantity + $2, status = 'AVAILABLE' 
                     WHERE id = $3`,
                    [restoreWt, restoreQty, txn.inventory_item_id]
                );
            } else {
                await client.query(
                    "UPDATE inventory_items SET status = 'AVAILABLE' WHERE id = $1",
                    [txn.inventory_item_id]
                );
            }
            await client.query(
                `INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description)
                 VALUES ($1, 'RETURN', $2, $3, 'Lend Reverted')`,
                [txn.inventory_item_id, restoreQty, restoreWt]
            );
        }
    }

    const c_val = parseFloat(txn.cash_amount) || 0;
    const desc = (txn.description || '').toLowerCase();
    const isLikelyMC = desc.includes('item') || desc.includes('sold') || desc.includes('mc');
    
    if (c_val > 0.01 && !isLikelyMC) {
        let assetReversal = 0;
        if (txn.type === 'BORROW_ADD' || txn.type === 'LEND_COLLECT') assetReversal = -c_val;
        else if (txn.type === 'LEND_ADD' || txn.type === 'BORROW_REPAY') assetReversal = c_val;

        if (assetReversal !== 0) {
            await client.query(`UPDATE shop_assets SET cash_balance = cash_balance + $1 WHERE id = 1`, [assetReversal]);
        }
    }

    let g = parseFloat(txn.pure_weight) || 0;
    let s = parseFloat(txn.silver_weight) || 0;
    let c = parseFloat(txn.cash_amount) || 0;
    
    let multiplier = 1;
    if (txn.type === 'BORROW_REPAY' || txn.type === 'LEND_ADD') {
        multiplier = 1; 
    } else {
        multiplier = -1;
    }

    await client.query(
      `UPDATE external_shops 
       SET balance_gold = balance_gold + $1, 
           balance_silver = balance_silver + $2, 
           balance_cash = balance_cash + $3 
       WHERE id = $4`,
      [g * multiplier, s * multiplier, c * multiplier, txn.shop_id]
    );

    const pRes = await client.query(`SELECT transaction_id FROM shop_transaction_payments WHERE parent_txn_id = $1`, [id]);
    if (pRes.rows.length > 0) {
        const ids = pRes.rows.map(r => r.transaction_id);
        await client.query(`DELETE FROM shop_transaction_payments WHERE parent_txn_id = $1`, [id]);
        await client.query(`UPDATE shop_transactions SET is_settled = FALSE WHERE id = ANY($1::int[])`, [ids]);
    }

    await client.query('DELETE FROM shop_transactions WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 6. UPDATE TRANSACTION
router.put('/transaction/:id', async (req, res) => {
  const { id } = req.params;
  const { description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldRes = await client.query('SELECT * FROM shop_transactions WHERE id = $1', [id]);
    const oldTxn = oldRes.rows[0];

    let om = (oldTxn.type === 'BORROW_REPAY' || oldTxn.type === 'LEND_ADD') ? 1 : -1;
    await client.query(
        `UPDATE external_shops SET balance_gold=balance_gold+$1, balance_silver=balance_silver+$2, balance_cash=balance_cash+$3 WHERE id=$4`, 
        [parseFloat(oldTxn.pure_weight)*om, parseFloat(oldTxn.silver_weight)*om, parseFloat(oldTxn.cash_amount)*om, oldTxn.shop_id]
    );

    await client.query(`UPDATE shop_transactions SET description=$1, gross_weight=$2, wastage_percent=$3, making_charges=$4, pure_weight=$5, silver_weight=$6, cash_amount=$7 WHERE id=$8`,
      [description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount, id]);

    let nm = (oldTxn.type === 'BORROW_REPAY' || oldTxn.type === 'LEND_ADD') ? -1 : 1;
    await client.query(
        `UPDATE external_shops SET balance_gold=balance_gold+$1, balance_silver=balance_silver+$2, balance_cash=balance_cash+$3 WHERE id=$4`, 
        [parseFloat(pure_weight)*nm, parseFloat(silver_weight)*nm, parseFloat(cash_amount)*nm, oldTxn.shop_id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 7. SETTLE ITEM
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
        
        const safeCash = parseFloat(cash_val) || 0;
        if (safeCash > 0.01) {
            let assetChange = 0;
            if (type === 'BORROW_ADD') assetChange = -safeCash;
            else if (type === 'LEND_ADD') assetChange = safeCash;

            if (assetChange !== 0) {
                await client.query(`UPDATE shop_assets SET cash_balance = cash_balance + $1 WHERE id = 1`, [assetChange]);
            }
        }

        let g = (parseFloat(gold_val)||0) + (parseFloat(converted_weight)||0);
        let s = parseFloat(silver_val)||0;
        let c = parseFloat(cash_val)||0;

        let mult = (type === 'BORROW_ADD') ? -1 : 1;

        await client.query(`UPDATE external_shops SET balance_gold=balance_gold+$1, balance_silver=balance_silver+$2, balance_cash=balance_cash+$3 WHERE id=$4`, 
            [g*mult, s*mult, c*mult, shop_id]);
        
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

// 8. DELETE SHOP
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const check = await client.query("SELECT * FROM external_shops WHERE id = $1", [id]);
        if(check.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({error: "Shop not found"}); }
        const shop = check.rows[0];

        const g = parseFloat(shop.balance_gold)||0; const s = parseFloat(shop.balance_silver)||0; const c = parseFloat(shop.balance_cash)||0;
        if (Math.abs(g)>0.001 || Math.abs(s)>0.001 || Math.abs(c)>0.01) {
             await client.query('ROLLBACK'); return res.status(400).json({ error: `Cannot delete: Shop has balance (G: ${g}, S: ${s}, C: ${c})` });
        }
        
        const txnCheck = await client.query("SELECT id FROM shop_transactions WHERE shop_id = $1 LIMIT 1", [id]);
        if (txnCheck.rows.length > 0) {
            await client.query('ROLLBACK'); return res.status(400).json({ error: "Cannot delete: Shop has history." });
        }

        await client.query("DELETE FROM external_shops WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true, message: "Shop deleted" });
    } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 9. PAYMENT HISTORY
router.get('/payment-history/:txnId', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM shop_transaction_payments WHERE transaction_id = $1 ORDER BY created_at DESC', [req.params.txnId]); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;