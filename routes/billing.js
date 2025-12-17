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

// 3. CREATE BILL (Handles Partial Payments)
router.post('/create-bill', async (req, res) => {
  const { customer, items, exchangeItems, totals, includeGST } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = `INV-${Date.now()}`;

    // Calculate Payment Status
    // If paidAmount isn't sent (old frontend), assume full payment.
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
        totals.netPayable,          // final_amount ($10)
        totals.exchangeTotal || 0,  // exchange_total ($11)
        includeGST,                 // is_gst_bill ($12)
        paid,                       // paid_amount ($13)
        balance,                    // balance_amount ($14)
        status                      // payment_status ($15)
      ]
    );
    const saleId = saleRes.rows[0].id;

    // Process Sale Items
    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items 
        (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, item.item_id || null, item.item_name, item.gross_weight, item.rate, item.making_charges || 0, item.total]
      );
      if (item.item_id) {
        await client.query(`UPDATE inventory_items SET status = 'SOLD' WHERE id = $1`, [item.item_id]);
      }
    }

    // Process Exchange Items
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

module.exports = router;