const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET INVOICE DETAILS (For Returns)
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

// 3. CREATE BILL (Handles Partial Payments & Neighbour Debt)
router.post('/create-bill', async (req, res) => {
  const { customer, items, exchangeItems, totals, includeGST } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = `INV-${Date.now()}`;

    // Calculate Payment Status
    const netPayable = totals.netPayable || 0;
    const paid = totals.paidAmount !== undefined ? totals.paidAmount : netPayable;
    const balance = totals.balance !== undefined ? totals.balance : 0;
    const status = balance > 0 ? 'PARTIAL' : 'PAID';

    // 1. Create Sale Record
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
        totals.netPayable,          
        totals.exchangeTotal || 0,  
        includeGST,                 
        paid,                       
        balance,                    
        status                      
      ]
    );
    const saleId = saleRes.rows[0].id;

    // 2. Process Sale Items (AND NEIGHBOUR DEBT LOGIC)
    for (const item of items) {
      // A. Insert into sale_items table (The Bill Item)
      await client.query(
        `INSERT INTO sale_items 
        (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, item.item_id || null, item.item_name, item.gross_weight, item.rate, item.making_charges || 0, item.total]
      );

      // B. Update Inventory & Check Source
      if (item.item_id) {
        // We use RETURNING * to see the item's details (like source_type)
        const updateRes = await client.query(
            `UPDATE inventory_items 
             SET status = 'SOLD' 
             WHERE id = $1 
             RETURNING *`, 
            [item.item_id]
        );
        const dbItem = updateRes.rows[0];

        // --- NEW LOGIC: NEIGHBOUR DEBT TRACKING ---
        // If the item came from a neighbour, record the debt now.
        if (dbItem && dbItem.source_type === 'NEIGHBOUR') {
            await client.query(
                `INSERT INTO payment_transactions 
                (
                    entity_id, 
                    entity_type, 
                    transaction_type, 
                    transaction_status, 
                    weight, 
                    amount, 
                    reference_item_id, 
                    description, 
                    created_at
                ) VALUES ($1, 'NEIGHBOUR', 'PAYABLE', 'PENDING', $2, 0, $3, 'Sale - Cost Pending', NOW())`,
                [
                    dbItem.neighbour_shop_id, // ensure your inventory_items table has this column
                    dbItem.weight,            // Using the weight from the database item
                    item.item_id
                ]
            );
        }
        // ------------------------------------------
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

        // 1. Get current sale details
        const saleRes = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [sale_id]);
        if (saleRes.rows.length === 0) throw new Error("Bill not found");
        
        const sale = saleRes.rows[0];
        const payAmount = parseFloat(amount);
        
        // 2. Validate Amount
        if (payAmount > parseFloat(sale.balance_amount)) {
            throw new Error(`Amount exceeds balance! Current Balance: ${sale.balance_amount}`);
        }

        // 3. Insert Payment Record
        await client.query(
            "INSERT INTO sale_payments (sale_id, amount, payment_mode, note) VALUES ($1, $2, $3, $4)",
            [sale_id, payAmount, payment_mode || 'CASH', note]
        );

        // 4. Update Sale Totals
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

// 7. GET PAYMENTS FOR A SPECIFIC BILL
router.get('/payments/:sale_id', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY payment_date DESC", 
            [req.params.sale_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;