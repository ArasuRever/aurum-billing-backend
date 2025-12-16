const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. ADD NEW SHOP
router.post('/add', async (req, res) => {
  const { shop_name, nick_id, person_name, mobile, address } = req.body; // Added nick_id
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
    res.json({ shop: shopRes.rows[0], transactions: transRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. ADD TRANSACTION
router.post('/transaction', async (req, res) => {
  const { shop_id, action, description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Determine Balance Impact
    let g_impact = parseFloat(pure_weight) || 0;
    let s_impact = parseFloat(silver_weight) || 0;
    let c_impact = parseFloat(cash_amount) || 0;

    // REVERSAL LOGIC:
    // BORROW_ADD (+): Increases Debt
    // BORROW_REPAY (-): Reduces Debt
    // LEND_ADD (-): Increases Credit (Negative Balance)
    // LEND_COLLECT (+): Reduces Credit (Moves back to 0)
    
    if (action === 'BORROW_REPAY' || action === 'LEND_ADD') {
        g_impact *= -1;
        s_impact *= -1;
        c_impact *= -1;
    }

    await client.query(
      `UPDATE external_shops 
       SET balance_gold = balance_gold + $1, 
           balance_silver = balance_silver + $2, 
           balance_cash = balance_cash + $3 
       WHERE id = $4`,
      [g_impact, s_impact, c_impact, shop_id]
    );

    await client.query(
      `INSERT INTO shop_transactions (shop_id, type, description, gross_weight, wastage_percent, making_charges, pure_weight, silver_weight, cash_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [shop_id, action, description, gross_weight||0, wastage_percent||0, making_charges||0, Math.abs(g_impact), Math.abs(s_impact), Math.abs(c_impact)]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 5. DELETE TRANSACTION (UNDO)
router.delete('/transaction/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get Transaction Details
    const txnRes = await client.query('SELECT * FROM shop_transactions WHERE id = $1', [id]);
    if (txnRes.rows.length === 0) throw new Error('Transaction not found');
    const txn = txnRes.rows[0];

    // Determine Reversal Amount
    // We must DO THE OPPOSITE of what the transaction did.
    let g_impact = parseFloat(txn.pure_weight) || 0;
    let s_impact = parseFloat(txn.silver_weight) || 0;
    let c_impact = parseFloat(txn.cash_amount) || 0;

    // Original Logic:
    // BORROW_ADD was (+), so Reverse is (-)
    // BORROW_REPAY was (-), so Reverse is (+)
    // LEND_ADD was (-), so Reverse is (+)
    // LEND_COLLECT was (+), so Reverse is (-)

    if (txn.type === 'BORROW_ADD' || txn.type === 'LEND_COLLECT') {
       g_impact *= -1; s_impact *= -1; c_impact *= -1;
    } 
    // For BORROW_REPAY and LEND_ADD, we Add (+) to reverse the subtraction.

    // Update Balance
    await client.query(
      `UPDATE external_shops 
       SET balance_gold = balance_gold + $1, 
           balance_silver = balance_silver + $2, 
           balance_cash = balance_cash + $3 
       WHERE id = $4`,
      [g_impact, s_impact, c_impact, txn.shop_id]
    );

    // Delete Record
    await client.query('DELETE FROM shop_transactions WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 6. UPDATE SHOP DETAILS
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { shop_name, nick_id, person_name, mobile, address } = req.body;
  try {
    await pool.query(
      `UPDATE external_shops 
       SET shop_name=$1, nick_id=$2, person_name=$3, mobile=$4, address=$5 
       WHERE id=$6`,
      [shop_name, nick_id, person_name, mobile, address, id]
    );
    res.json({ success: true, message: 'Shop updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;