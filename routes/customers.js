const express = require('express');
const router = express.Router();
const pool = require('../config/db');

console.log("✅ Customer Routes Loaded");

// 1. SEARCH (Active Only)
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM customers WHERE (phone LIKE $1 OR name ILIKE $2) AND is_deleted = FALSE LIMIT 5",
      [`%${q}%`, `%${q}%`]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. LIST ACTIVE CUSTOMERS
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM customers WHERE is_deleted = FALSE ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. RECYCLE BIN (List Deleted Customers)
router.get('/recycle-bin', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM customers WHERE is_deleted = TRUE ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. SOFT DELETE (Move to Recycle Bin)
router.delete('/soft-delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE customers SET is_deleted = TRUE WHERE id = $1", [id]);
        res.json({ success: true, message: "Moved to Recycle Bin" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. RESTORE (Recover from Recycle Bin)
router.put('/restore/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE customers SET is_deleted = FALSE WHERE id = $1", [id]);
        res.json({ success: true, message: "Customer Restored" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. PERMANENT DELETE (Dangerous)
router.delete('/permanent/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Optional: Check if they have sales before deleting?
        await pool.query("DELETE FROM customers WHERE id = $1", [id]);
        res.json({ success: true, message: "Permanently Deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. CUSTOMER DETAILS (Includes Payment History)
router.get('/details/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const custRes = await pool.query("SELECT * FROM customers WHERE phone = $1", [phone]);
    if (custRes.rows.length === 0) return res.status(404).json({ error: "Customer not found" });

    // Fetch Sales History
    const salesRes = await pool.query(`
        SELECT * FROM sales 
        WHERE customer_phone = $1 
        ORDER BY created_at DESC`, 
        [phone]
    );

    // Fetch Payment History (Across all bills) for this customer
    // We join sale_payments with sales to filter by customer phone
    const paymentsRes = await pool.query(`
        SELECT sp.*, s.invoice_number 
        FROM sale_payments sp
        JOIN sales s ON sp.sale_id = s.id
        WHERE s.customer_phone = $1
        ORDER BY sp.payment_date DESC`,
        [phone]
    );

    res.json({ 
        customer: custRes.rows[0], 
        history: salesRes.rows, 
        payments: paymentsRes.rows 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. ADD & UPDATE (Standard)
router.post('/add', async (req, res) => {
  const { name, phone, address, profile_image } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO customers (name, phone, address, profile_image, is_deleted) VALUES ($1, $2, $3, $4, FALSE) RETURNING *",
      [name, phone, address, profile_image]
    );
    res.json(result.rows[0]);
  } catch (err) { 
    if (err.code === '23505') return res.status(400).json({ error: 'Phone number already exists' });
    res.status(500).json({ error: err.message }); 
  }
});

router.put('/update/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, address, profile_image } = req.body;
  try {
    await pool.query(
      "UPDATE customers SET name=$1, phone=$2, address=$3, profile_image=$4 WHERE id=$5",
      [name, phone, address, profile_image, id]
    );
    res.json({ success: true, message: "Customer Updated" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;