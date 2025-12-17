const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// LOG WHEN LOADED
console.log("✅ Customer Routes Fully Loaded");

// 1. SEARCH (For Billing)
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM customers WHERE phone LIKE $1 OR name ILIKE $2 LIMIT 5",
      [`%${q}%`, `%${q}%`]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. LIST ALL (For Manager)
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM customers ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. GET DETAILS & HISTORY
router.get('/details/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const custRes = await pool.query("SELECT * FROM customers WHERE phone = $1", [phone]);
    const salesRes = await pool.query("SELECT * FROM sales WHERE customer_phone = $1 ORDER BY created_at DESC", [phone]);

    if (custRes.rows.length === 0) return res.status(404).json({ error: "Customer not found" });

    res.json({ customer: custRes.rows[0], history: salesRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. ADD NEW CUSTOMER
router.post('/add', async (req, res) => {
  const { name, phone, address, profile_image } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO customers (name, phone, address, profile_image) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, phone, address, profile_image]
    );
    res.json(result.rows[0]);
  } catch (err) { 
    if (err.code === '23505') return res.status(400).json({ error: 'Phone number already exists' });
    res.status(500).json({ error: err.message }); 
  }
});

// 5. UPDATE CUSTOMER
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