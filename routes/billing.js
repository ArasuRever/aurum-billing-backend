const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. SEARCH ITEMS
router.get('/search-item', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_items 
       WHERE (barcode = $1 OR item_name ILIKE $2) 
       AND status = 'AVAILABLE'`,
      [q, `%${q}%`]
    );
    // Convert Buffer images to Base64 for frontend display
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. CREATE BILL
router.post('/create-bill', async (req, res) => {
  const { customer, items, totals, includeGST } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = `INV-${Date.now()}`;

    // 1. Create Sale Record
    const saleRes = await client.query(
      `INSERT INTO sales 
      (invoice_number, customer_name, customer_phone, gross_total, discount, taxable_amount, sgst_amount, cgst_amount, round_off_amount, final_amount, is_gst_bill)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        invoiceNumber, customer.name, customer.phone, 
        totals.grossTotal || 0, totals.totalDiscount || 0, totals.taxableAmount || 0, 
        totals.sgst || 0, totals.cgst || 0, totals.roundOff || 0, totals.netPayable, includeGST
      ]
    );
    const saleId = saleRes.rows[0].id;

    // 2. Process Items
    for (const item of items) {
      // Insert into sale_items (item.item_id can be NULL for manual items)
      await client.query(
        `INSERT INTO sale_items 
        (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          saleId, item.item_id || null, item.item_name, 
          item.gross_weight, item.rate, item.making_charges || 0, item.total
        ]
      );

      // ONLY update inventory if it was a scanned item (has ID)
      if (item.item_id) {
        await client.query(`UPDATE inventory_items SET status = 'SOLD' WHERE id = $1`, [item.item_id]);
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

module.exports = router;