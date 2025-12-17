const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET INVOICE DETAILS
router.get('/invoice/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const sale = await pool.query("SELECT * FROM sales WHERE invoice_number = $1", [id]);
        if(sale.rows.length === 0) return res.status(404).json({error: "Invoice not found"});
        
        const items = await pool.query("SELECT * FROM sale_items WHERE sale_id = $1", [sale.rows[0].id]);
        res.json({ sale: sale.rows[0], items: items.rows });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// 2. SEARCH ITEMS
router.get('/search-item', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_items 
       WHERE (barcode = $1 OR item_name ILIKE $2) 
       AND status = 'AVAILABLE'`,
      [q, `%${q}%`]
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. CREATE BILL (ADJUSTED: GROSS WEIGHT DEBT ONLY)
router.post('/create-bill', async (req, res) => {
  const { customer, items, exchangeItems, totals, includeGST } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = `INV-${Date.now()}`;

    // 1. Create Sale Record
    const netPayable = totals.netPayable || 0;
    const paid = totals.paidAmount !== undefined ? totals.paidAmount : netPayable;
    const balance = totals.balance !== undefined ? totals.balance : 0;
    const status = balance > 0 ? 'PARTIAL' : 'PAID';

    const saleRes = await client.query(
      `INSERT INTO sales 
      (invoice_number, customer_name, customer_phone, gross_total, discount, taxable_amount, 
       sgst_amount, cgst_amount, round_off_amount, final_amount, total_amount, exchange_total, is_gst_bill,
       paid_amount, balance_amount, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        invoiceNumber, customer.name, customer.phone, 
        totals.grossTotal || 0, totals.totalDiscount || 0, totals.taxableAmount || 0, 
        totals.sgst || 0, totals.cgst || 0, totals.roundOff || 0, 
        totals.netPayable, totals.exchangeTotal || 0, includeGST, paid, balance, status
      ]
    );
    const saleId = saleRes.rows[0].id;

    // 2. Process Sale Items & Handle Neighbour Debt
    for (const item of items) {
      // A. Insert into sale_items
      await client.query(
        `INSERT INTO sale_items 
        (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, item.item_id || null, item.item_name, item.gross_weight, item.rate, item.making_charges || 0, item.total]
      );

      // --- NEIGHBOUR DEBT LOGIC ---
      let neighbourIdToUpdate = null;
      let weightForDebt = 0;
      let description = '';

      // CASE 1: EXISTING INVENTORY ITEM
      if (item.item_id) {
        // Mark as SOLD and get details
        const updateRes = await client.query(
            `UPDATE inventory_items SET status = 'SOLD' WHERE id = $1 RETURNING *`, 
            [item.item_id]
        );
        const dbItem = updateRes.rows[0];

        // Check if this item belongs to a Neighbour Shop
        if (dbItem && dbItem.source_type === 'NEIGHBOUR' && dbItem.neighbour_shop_id) {
            neighbourIdToUpdate = dbItem.neighbour_shop_id;
            
            // ADJUSTMENT: Use GROSS WEIGHT only (Ignore Wastage/Purity)
            weightForDebt = parseFloat(dbItem.gross_weight) || 0; 
            
            description = `Sold Item: ${item.item_name} (${dbItem.barcode})`;
        }
      } 
      // CASE 2: MANUAL ITEM (Using Nick ID)
      else if (item.neighbour_id) {
         neighbourIdToUpdate = item.neighbour_id;
         
         const gross = parseFloat(item.gross_weight) || 0;
         
         // ADJUSTMENT: Use GROSS WEIGHT only (Ignore Wastage)
         weightForDebt = gross;
         
         description = `Sold Manual Item: ${item.item_name}`;
      }

      // --- EXECUTE DEBT UPDATE (If valid neighbour found) ---
      if (neighbourIdToUpdate && weightForDebt > 0) {
          // 1. Update Shop Balance (Increase Debt by Gross Weight)
          await client.query(
             `UPDATE external_shops 
              SET balance_gold = balance_gold + $1 
              WHERE id = $2`,
             [weightForDebt, neighbourIdToUpdate]
          );

          // 2. Add to Shop Ledger
          await client.query(
             `INSERT INTO shop_transactions 
              (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount)
              VALUES ($1, 'BORROW_ADD', $2, $3, $4, 0, 0)`,
             [
                 neighbourIdToUpdate, 
                 description, 
                 item.gross_weight, 
                 weightForDebt // Storing Gross Weight in the 'pure_weight' column as the value owed
             ]
          );
      }
    }

    // 3. Process Exchange Items
    if (exchangeItems && exchangeItems.length > 0) {
      for (const ex of exchangeItems) {
        await client.query(
          `INSERT INTO sale_exchange_items 
          (sale_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, total_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [saleId, ex.name, ex.metal_type, ex.gross_weight, ex.less_percent, ex.less_weight, ex.net_weight, ex.rate, ex.total]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Bill created', invoice_id: invoiceNumber });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 4. RETURN ITEM
router.post('/return-item', async (req, res) => {
    const { sale_item_id, item_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("UPDATE sale_items SET item_name = item_name || ' (RETURNED)', total_item_price = 0 WHERE id = $1", [sale_item_id]);
        if (item_id) {
            await client.query("UPDATE inventory_items SET status = 'AVAILABLE' WHERE id = $1", [item_id]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: "Item Returned & Added to Inventory" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 5. DELETE BILL
router.delete('/delete/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemsRes = await client.query("SELECT item_id FROM sale_items WHERE sale_id = $1 AND item_id IS NOT NULL", [id]);
      for (const row of itemsRes.rows) {
          await client.query("UPDATE inventory_items SET status = 'AVAILABLE' WHERE id = $1", [row.item_id]);
      }
      await client.query("DELETE FROM sale_items WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sale_exchange_items WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sales WHERE id = $1", [id]);
      await client.query('COMMIT');
      res.json({ success: true, message: "Bill Voided & Stock Restored" });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

// 6. RECORD BALANCE PAYMENT
router.post('/add-payment', async (req, res) => {
    const { sale_id, amount, payment_mode, note } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const saleRes = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [sale_id]);
        if (saleRes.rows.length === 0) throw new Error("Bill not found");
        
        const sale = saleRes.rows[0];
        const payAmount = parseFloat(amount);
        
        if (payAmount > parseFloat(sale.balance_amount)) throw new Error(`Amount exceeds balance!`);

        await client.query(
            "INSERT INTO sale_payments (sale_id, amount, payment_mode, note) VALUES ($1, $2, $3, $4)",
            [sale_id, payAmount, payment_mode || 'CASH', note]
        );

        const newPaid = parseFloat(sale.paid_amount) + payAmount;
        const newBalance = parseFloat(sale.balance_amount) - payAmount;
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIAL';

        await client.query(
            "UPDATE sales SET paid_amount = $1, balance_amount = $2, payment_status = $3, last_payment_date = NOW() WHERE id = $4",
            [newPaid, newBalance, newStatus, sale_id]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Payment Recorded", new_balance: newBalance });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 7. GET PAYMENTS
router.get('/payments/:sale_id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY payment_date DESC", [req.params.sale_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;