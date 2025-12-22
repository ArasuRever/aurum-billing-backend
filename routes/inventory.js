//
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. ADD ITEM (Now correctly updates Vendor Balance)
router.post('/add', upload.single('item_image'), async (req, res) => {
  const { 
    vendor_id, neighbour_shop_id, source_type, 
    metal_type, item_name, gross_weight, wastage_percent, making_charges, stock_type,
    huid // <--- NEW FIELD
  } = req.body;
  
  const item_image = req.file ? req.file.buffer : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Default Source if missing
    const finalSource = source_type || 'VENDOR'; 
    
    const prefix = metal_type === 'GOLD' ? 'G' : 'S';
    const barcode = `${prefix}-${Date.now()}`;
    const gross = parseFloat(gross_weight) || 0;
    const purityVal = parseFloat(wastage_percent) || 0; 
    
    // CALCULATION LOGIC:
    // If frontend sends 'pure_weight', use it (it handles the Touch vs Wastage logic).
    // Otherwise fallback to standard Touch logic: Gross * (Purity / 100).
    let pure_weight = 0;
    if (req.body.pure_weight) {
        pure_weight = parseFloat(req.body.pure_weight);
    } else {
        pure_weight = gross * (purityVal / 100);
    }

    // 2. Insert into Inventory
    const itemRes = await client.query(
      `INSERT INTO inventory_items 
      (vendor_id, neighbour_shop_id, source_type, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, item_image, status, stock_type, huid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'AVAILABLE', $12, $13) RETURNING *`,
      [
        vendor_id || null, 
        neighbour_shop_id || null, 
        finalSource, 
        metal_type, item_name, barcode, gross, purityVal, making_charges, pure_weight, item_image, 
        stock_type || 'SINGLE',
        huid || null // <--- Insert HUID
      ]
    );
    const newItem = itemRes.rows[0];

    // 3. IF VENDOR -> Update Vendor Ledger
    if (finalSource === 'VENDOR' && vendor_id) {
        // A. Increase Vendor Balance
        await client.query(
            `UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`,
            [pure_weight, vendor_id]
        );
        
        // B. Add Transaction Entry
        await client.query(
            `INSERT INTO vendor_transactions 
            (vendor_id, type, description, stock_pure_weight, balance_after)
             VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1))`,
            [vendor_id, `Added Stock: ${item_name}`, pure_weight]
        );
    }
    
    await client.query('COMMIT');
    res.json({ success: true, item: newItem });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 2. LIST ALL ITEMS
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT i.*, 
               v.business_name as vendor_name, 
               n.shop_name as neighbour_name
        FROM inventory_items i
        LEFT JOIN vendors v ON i.vendor_id = v.id
        LEFT JOIN external_shops n ON i.neighbour_shop_id = n.id
        WHERE i.status = 'AVAILABLE' 
        ORDER BY i.created_at DESC`
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. VENDOR SPECIFIC INVENTORY
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
    
    const newGross = parseFloat(gross_weight);
    const newPurity = parseFloat(wastage_percent);
    
    // Note: Update usually assumes Touch logic for simplicity unless we store calculation mode.
    // Defaulting to Touch logic here for consistency with legacy, or calculated pure should be passed.
    // For now, retaining standard formula: Gross * (Percent / 100)
    const newPure = newGross * (newPurity / 100); 
    const oldPure = parseFloat(oldItem.pure_weight);
    
    const diffPure = newPure - oldPure;

    await client.query(`INSERT INTO item_updates (item_id, old_values, update_comment) VALUES ($1, $2, $3)`, [id, JSON.stringify(oldItem), update_comment]);
    await client.query(`UPDATE inventory_items SET gross_weight=$1, wastage_percent=$2, pure_weight=$3 WHERE id=$4`, [newGross, newPurity, newPure, id]);
    
    if (oldItem.vendor_id && diffPure !== 0) {
        await client.query(`UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`, [diffPure, oldItem.vendor_id]);
        await client.query(
            `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, balance_after)
             VALUES ($1, 'STOCK_UPDATE', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1))`,
            [oldItem.vendor_id, `Updated Item: ${oldItem.item_name}`, diffPure]
        );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 5. DELETE ITEM
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    const item = itemRes.rows[0];
    
    if (item) {
        await client.query('DELETE FROM inventory_items WHERE id = $1', [id]);

        if (item.source_type === 'VENDOR' && item.vendor_id) {
            const reduction = parseFloat(item.pure_weight) || 0;
            await client.query('UPDATE vendors SET balance_pure_weight = balance_pure_weight - $1 WHERE id = $2', [reduction, item.vendor_id]);
            await client.query(
              `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, balance_after)
               VALUES ($1, 'REPAYMENT', $2, 0, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1))`,
              [item.vendor_id, `Deleted: ${item.item_name}`, reduction]
            );
        }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

module.exports = router;