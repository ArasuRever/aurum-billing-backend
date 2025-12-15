const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// ==========================================
// 1. SEARCH ITEMS FOR BILLING
// ==========================================
router.get('/search-item', async (req, res) => {
  const { q } = req.query; // Barcode or Item Name
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_items 
       WHERE (barcode = $1 OR item_name ILIKE $2) 
       AND status = 'AVAILABLE'`,
      [q, `%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. CREATE BILL (Transaction)
// ==========================================
router.post('/create-bill', async (req, res) => {
  const { customer_name, customer_phone, items, discount, payment_mode } = req.body;
  // items is an array of objects: { item_id, sold_weight, sold_rate, making_charges }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Calculate Totals
    let totalAmount = 0;
    const invoiceNumber = `INV-${Date.now()}`;

    // 2. Create Invoice Record
    // We insert a placeholder total first, update it later or calculate upfront
    // Let's calculate upfront based on items array
    items.forEach(item => {
      const itemTotal = (item.sold_weight * item.sold_rate) + (parseFloat(item.making_charges) || 0);
      totalAmount += itemTotal;
    });

    const finalAmount = totalAmount - (parseFloat(discount) || 0);

    const saleRes = await client.query(
      `INSERT INTO sales (invoice_number, customer_name, customer_phone, total_amount, discount, final_amount, payment_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [invoiceNumber, customer_name, customer_phone, totalAmount, discount, finalAmount, payment_mode]
    );
    const saleId = saleRes.rows[0].id;

    // 3. Process Sale Items & Update Inventory
    for (const item of items) {
      const itemTotal = (item.sold_weight * item.sold_rate) + (parseFloat(item.making_charges) || 0);

      // Add to sale_items table
      await client.query(
        `INSERT INTO sale_items (sale_id, item_id, sold_weight, sold_rate, making_charges_collected, total_item_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, item.item_id, item.sold_weight, item.sold_rate, item.making_charges, itemTotal]
      );

      // Mark inventory item as SOLD
      await client.query(
        `UPDATE inventory_items SET status = 'SOLD' WHERE id = $1`,
        [item.item_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Bill created successfully', invoice: invoiceNumber });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;