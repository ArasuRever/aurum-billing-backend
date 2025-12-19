const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET INVOICE DETAILS (Updated to support searching by ID or Invoice Number)
router.get('/invoice/:id', async (req, res) => {
    const { id } = req.params;
    try {
        let query = "SELECT * FROM sales WHERE invoice_number = $1";
        let params = [id];
        
        // If id is numeric, search by ID as well
        if (!isNaN(id)) {
             query = "SELECT * FROM sales WHERE id = $1 OR invoice_number = $2";
             params = [id, id];
        }

        const sale = await pool.query(query, params);
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

// 3. CREATE BILL (Integrated with Shop Ledger)
router.post('/create-bill', async (req, res) => {
  const { customer, items, exchangeItems, totals, includeGST } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = `INV-${Date.now()}`;

    // A. Create Sale Record
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

    // B. Process Sale Items
    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items 
        (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, item.item_id || null, item.item_name, item.gross_weight, item.rate, item.making_charges || 0, item.total]
      );

      // Handle Inventory & Neighbor Debt
      let neighbourIdToUpdate = null;
      let weightForDebt = 0;
      let description = '';
      let metalType = item.metal_type || 'GOLD';

      if (item.item_id) {
        // Update Inventory to SOLD
        const updateRes = await client.query(
            `UPDATE inventory_items SET status = 'SOLD' WHERE id = $1 RETURNING *`, 
            [item.item_id]
        );
        const dbItem = updateRes.rows[0];

        // Check if Neighbor Item
        if (dbItem && dbItem.source_type === 'NEIGHBOUR' && dbItem.neighbour_shop_id) {
            neighbourIdToUpdate = dbItem.neighbour_shop_id;
            weightForDebt = parseFloat(dbItem.gross_weight) || 0; 
            metalType = dbItem.metal_type;
            description = `Sold Item: ${item.item_name} (${dbItem.barcode})`;
        }
      } 
      else if (item.neighbour_id) {
          // Manual Neighbor Item
          neighbourIdToUpdate = item.neighbour_id;
          weightForDebt = parseFloat(item.gross_weight) || 0;
          description = `Sold Manual Item: ${item.item_name}`;
      }

      // Add to Debt if Neighbor
      if (neighbourIdToUpdate && weightForDebt > 0) {
          if (metalType === 'SILVER') {
              await client.query(`UPDATE external_shops SET balance_silver = balance_silver + $1 WHERE id = $2`, [weightForDebt, neighbourIdToUpdate]);
              await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) VALUES ($1, 'BORROW_ADD', $2, $3, 0, $4, 0)`, [neighbourIdToUpdate, description, item.gross_weight, weightForDebt]);
          } else {
              await client.query(`UPDATE external_shops SET balance_gold = balance_gold + $1 WHERE id = $2`, [weightForDebt, neighbourIdToUpdate]);
              await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) VALUES ($1, 'BORROW_ADD', $2, $3, $4, 0, 0)`, [neighbourIdToUpdate, description, item.gross_weight, weightForDebt]);
          }
      }
    }

    // C. Exchange Items (Old Gold Received)
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

// 4. PROCESS RETURN & EXCHANGE (This REPLACES the old 'return-item' logic)
router.post('/process-return', async (req, res) => {
    const { sale_id, returned_items, exchange_items, financial_summary } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // A. Create Return Record
        const returnRes = await client.query(
            `INSERT INTO sales_returns 
            (sale_id, total_refund_amount, total_exchange_amount, net_payable_by_customer, net_refundable_to_customer)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
                sale_id, 
                financial_summary.totalRefund, 
                financial_summary.totalNewPurchase, 
                financial_summary.netPayable, 
                financial_summary.netRefundable
            ]
        );
        const returnId = returnRes.rows[0].id;

        // B. Handle Returned Items (Move to In-House Inventory)
        for (const item of returned_items) {
            // 1. Log the item in return table
            await client.query(
                `INSERT INTO sales_return_items (return_id, sale_item_id, item_name, return_weight, refund_amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [returnId, item.sale_item_id, item.item_name, item.gross_weight, item.refund_amount]
            );

            // 2. Identify the original inventory item
            if (item.original_inventory_id) {
                // UPDATE existing item to be AVAILABLE again
                // KEY LOGIC: Disconnect from Neighbor (vendor_id=NULL, neighbour_id=NULL)
                // Set source_type = 'RETURN' so it appears as In-House Stock
                await client.query(
                    `UPDATE inventory_items 
                     SET status = 'AVAILABLE', 
                         source_type = 'RETURN', 
                         vendor_id = NULL, 
                         neighbour_shop_id = NULL,
                         item_name = $2 
                     WHERE id = $1`,
                    [item.original_inventory_id, `${item.item_name} (Returned)`]
                );
            } else {
                // If it was a manual item (no inventory ID), we INSERT it as new stock
                await client.query(
                    `INSERT INTO inventory_items 
                    (item_name, metal_type, gross_weight, status, source_type, vendor_id, date_added)
                     VALUES ($1, $2, $3, 'AVAILABLE', 'RETURN', NULL, NOW())`,
                    [item.item_name, 'GOLD', item.gross_weight] 
                );
            }
        }

        // C. Process New Items (Exchange/Swap)
        if (exchange_items && exchange_items.length > 0) {
            for (const newItem of exchange_items) {
                if (newItem.id) {
                     await client.query(
                        `UPDATE inventory_items SET status = 'SOLD' WHERE id = $1`, 
                        [newItem.id]
                    );
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Return processed successfully" });

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

// 8. GET BILL HISTORY
router.get('/history', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM sales ORDER BY id DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;