const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

// Setup Multer for image uploads (Memory Storage -> Buffer)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// 1. ADD SINGLE ITEM (With Image)
// ==========================================
router.post('/add', upload.single('item_image'), async (req, res) => {
  const { vendor_id, metal_type, item_name, gross_weight, wastage_percent, making_charges } = req.body;
  const item_image = req.file ? req.file.buffer : null;

  try {
    // 1. Generate Unique Barcode (G-Timestamp or S-Timestamp)
    const prefix = metal_type === 'GOLD' ? 'G' : 'S';
    const barcode = `${prefix}-${Date.now()}`;

    // 2. Calculate Pure Weight (Standard Formula: Gross + Wastage)
    // Ensure inputs are numbers
    const gross = parseFloat(gross_weight);
    const wastage = parseFloat(wastage_percent);
    const pure_weight = gross + (gross * (wastage / 100));

    // 3. Insert into DB
    const result = await pool.query(
      `INSERT INTO inventory_items 
      (vendor_id, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, item_image, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE') RETURNING *`,
      [vendor_id, metal_type, item_name, barcode, gross, wastage, making_charges, pure_weight, item_image]
    );

    // 4. (Optional) Auto-Update Vendor Balance logic could go here if this stock is strictly "credit"
    
    res.json({ success: true, message: 'Item added', item: result.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. GET ITEMS (Converts Image Buffer to Base64)
// ==========================================
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, metal_type, item_name, barcode, gross_weight, pure_weight, status, item_image 
      FROM inventory_items 
      WHERE status = 'AVAILABLE' 
      ORDER BY created_at DESC
    `);

    // Transform the data to make images viewable on frontend
    const items = result.rows.map(item => {
      let imageBase64 = null;
      if (item.item_image) {
        // Convert Buffer to Base64 string
        imageBase64 = `data:image/jpeg;base64,${item.item_image.toString('base64')}`;
      }
      return { ...item, item_image: imageBase64 }; // Replace buffer with string
    });

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. EDIT ITEM (With Audit Log)
// ==========================================
router.put('/update/:id', async (req, res) => {
  const { id } = req.params;
  const { gross_weight, wastage_percent, update_comment } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch Old Data
    const oldRes = await client.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    const oldItem = oldRes.rows[0];

    if (!oldItem) throw new Error('Item not found');

    // 2. Recalculate Pure Weight
    const gross = parseFloat(gross_weight);
    const wastage = parseFloat(wastage_percent);
    const newPure = gross + (gross * (wastage / 100));

    // 3. Insert into Audit Log (item_updates)
    await client.query(
      `INSERT INTO item_updates (item_id, old_values, update_comment) VALUES ($1, $2, $3)`,
      [id, JSON.stringify(oldItem), update_comment] // Saving old row as JSON
    );

    // 4. Update Item
    await client.query(
      `UPDATE inventory_items SET gross_weight=$1, wastage_percent=$2, pure_weight=$3 WHERE id=$4`,
      [gross, wastage, newPure, id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Item updated successfully' });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 4. GET ALL ITEMS FOR A VENDOR (History)
// ==========================================
router.get('/vendor/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM inventory_items WHERE vendor_id = $1 ORDER BY created_at DESC', 
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;