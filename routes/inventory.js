const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. ADD ITEM (Fixed Formula: Pure = Gross * Purity%)
router.post('/add', upload.single('item_image'), async (req, res) => {
  const { vendor_id, metal_type, item_name, gross_weight, wastage_percent, making_charges, stock_type } = req.body;
  const item_image = req.file ? req.file.buffer : null;

  try {
    const prefix = metal_type === 'GOLD' ? 'G' : 'S';
    const barcode = `${prefix}-${Date.now()}`;
    const gross = parseFloat(gross_weight);
    const purity = parseFloat(wastage_percent); 
    const pure_weight = gross * (purity / 100); 

    const result = await pool.query(
      `INSERT INTO inventory_items 
      (vendor_id, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, item_image, status, stock_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE', $10) RETURNING *`,
      [vendor_id, metal_type, item_name, barcode, gross, purity, making_charges, pure_weight, item_image, stock_type || 'SINGLE']
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. LIST ITEMS
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, vendor_id, metal_type, item_name, barcode, gross_weight, wastage_percent, pure_weight, status, item_image FROM inventory_items WHERE status = 'AVAILABLE' ORDER BY created_at DESC`);
    const items = result.rows.map(item => ({...item, item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null}));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. VENDOR INVENTORY
router.get('/vendor/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory_items WHERE vendor_id = $1 ORDER BY created_at DESC', [req.params.id]);
    const items = result.rows.map(item => ({...item, item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null}));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. UPDATE ITEM
router.put('/update/:id', async (req, res) => {
  const { id } = req.params;
  const { gross_weight, wastage_percent, update_comment } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldRes = await client.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    const oldItem = oldRes.rows[0];
    
    const gross = parseFloat(gross_weight);
    const purity = parseFloat(wastage_percent);
    const newPure = gross * (purity / 100);

    await client.query(`INSERT INTO item_updates (item_id, old_values, update_comment) VALUES ($1, $2, $3)`, [id, JSON.stringify(oldItem), update_comment]);
    await client.query(`UPDATE inventory_items SET gross_weight=$1, wastage_percent=$2, pure_weight=$3 WHERE id=$4`, [gross, purity, newPure, id]);
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 5. DELETE ITEM (Updates Ledger)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    const item = itemRes.rows[0];
    if (!item) throw new Error('Item not found');

    await client.query('DELETE FROM inventory_items WHERE id = $1', [id]);

    const vendRes = await client.query('SELECT balance_pure_weight FROM vendors WHERE id = $1 FOR UPDATE', [item.vendor_id]);
    const currentBal = parseFloat(vendRes.rows[0].balance_pure_weight);
    const reduction = parseFloat(item.pure_weight) || 0;
    const newBal = currentBal - reduction;

    await client.query('UPDATE vendors SET balance_pure_weight = $1 WHERE id = $2', [newBal, item.vendor_id]);
    await client.query(
      `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, repaid_cash_amount, conversion_rate, cash_converted_weight, total_repaid_pure, balance_after)
       VALUES ($1, 'REPAYMENT', $2, 0, $3, 0, 0, 0, $3, $4)`,
      [item.vendor_id, `Deleted: ${item.item_name} (ID:${id})`, reduction, newBal]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

module.exports = router;