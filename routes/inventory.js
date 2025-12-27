const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. ADD ITEM (Single - Legacy Support)
router.post('/add', upload.single('item_image'), async (req, res) => {
  const { 
    vendor_id, neighbour_shop_id, source_type, 
    metal_type, item_name, gross_weight, wastage_percent, making_charges, stock_type, huid, quantity
  } = req.body;
  
  const item_image = req.file ? req.file.buffer : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const finalSource = source_type || 'VENDOR'; 
    const prefix = metal_type ? metal_type.charAt(0).toUpperCase() : 'X';
    const barcode = `${prefix}-${Date.now().toString(36).toUpperCase()}`;
    
    const gross = parseFloat(gross_weight) || 0;
    const purityVal = parseFloat(wastage_percent) || 0; 
    
    let pure_weight = 0;
    if (req.body.pure_weight) {
        pure_weight = parseFloat(req.body.pure_weight);
    } else {
        pure_weight = gross * (purityVal / 100);
    }

    const qty = parseInt(quantity) || 1;

    // Insert Item
    const itemRes = await client.query(
      `INSERT INTO inventory_items 
      (vendor_id, neighbour_shop_id, source_type, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, item_image, status, stock_type, huid, quantity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'AVAILABLE', $12, $13, $14) RETURNING *`,
      [vendor_id || null, neighbour_shop_id || null, finalSource, metal_type, item_name, barcode, gross, purityVal, making_charges, pure_weight, item_image, stock_type || 'SINGLE', huid || null, qty]
    );
    const newItem = itemRes.rows[0];

    // Update Vendor Ledger
    if (finalSource === 'VENDOR' && vendor_id) {
        await client.query(
            `UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`,
            [pure_weight, vendor_id]
        );
        
        await client.query(
            `INSERT INTO vendor_transactions 
            (vendor_id, type, description, stock_pure_weight, balance_after, metal_type)
             VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4)`,
            [vendor_id, `Added Stock: ${item_name}`, pure_weight, metal_type]
        );
    }
    
    await client.query('COMMIT');
    res.json({ success: true, item: newItem });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error in /add:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 2. BATCH ADD STOCK
router.post('/batch-add', async (req, res) => {
  const { vendor_id, metal_type, invoice_no, items } = req.body; 
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let totalGross = 0;
    let totalPure = 0;
    
    const processedItems = items.map(i => {
        const g = parseFloat(i.gross_weight) || 0;
        const p = parseFloat(i.wastage_percent) || 0;
        const pure = i.pure_weight ? parseFloat(i.pure_weight) : (g * (p/100));
        const qty = parseInt(i.quantity) || 1; 
        
        totalGross += g;
        totalPure += pure;
        
        return { ...i, g, p, pure, qty };
    });

    const batchRes = await client.query(
        `INSERT INTO stock_batches (vendor_id, invoice_no, metal_type, total_gross_weight, total_pure_weight, item_count)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [vendor_id || null, invoice_no || 'MANUAL', metal_type, totalGross, totalPure, items.length]
    );
    const batchId = batchRes.rows[0].id;

    const sourceType = vendor_id ? 'VENDOR' : 'OWN';

    for (const item of processedItems) {
        const prefix = metal_type ? metal_type.charAt(0).toUpperCase() : 'X';
        const barcode = `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random()*100)}`;
        const imgBuffer = item.item_image_base64 ? Buffer.from(item.item_image_base64, 'base64') : null;

        await client.query(
            `INSERT INTO inventory_items 
            (vendor_id, batch_id, source_type, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, status, stock_type, huid, item_image, quantity)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'AVAILABLE', $11, $12, $13, $14)`,
            [vendor_id || null, batchId, sourceType, metal_type, item.item_name, barcode, item.g, item.p, item.making_charges, item.pure, item.stock_type || 'SINGLE', item.huid || null, imgBuffer, item.qty]
        );
    }

    if (vendor_id) {
        await client.query(
            `UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`,
            [totalPure, vendor_id]
        );

        const ledgerDesc = items.length === 1 
            ? `Added Stock: ${items[0].item_name} (Inv#${invoice_no || 'NA'})`
            : `Inv #${invoice_no || 'NA'}: Added ${items.length} Items`;

        await client.query(
            `INSERT INTO vendor_transactions 
            (vendor_id, type, description, stock_pure_weight, balance_after, metal_type, reference_id, reference_type)
             VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4, $5, 'BATCH')`,
            [vendor_id, ledgerDesc, totalPure, metal_type, batchId]
        );
    }

    await client.query('COMMIT');
    res.json({ success: true, batchId });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error in /batch-add:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. LIST ALL ITEMS
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT i.*, v.business_name as vendor_name, n.shop_name as neighbour_name
        FROM inventory_items i
        LEFT JOIN vendors v ON i.vendor_id = v.id
        LEFT JOIN external_shops n ON i.neighbour_shop_id = n.id
        WHERE i.status = 'AVAILABLE' ORDER BY i.created_at DESC`
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. VENDOR SPECIFIC INVENTORY (Current Stock)
router.get('/vendor/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory_items WHERE vendor_id = $1 ORDER BY created_at DESC', [req.params.id]);
    const items = result.rows.map(item => ({...item, item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null}));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. UPDATE ITEM
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
    const newPure = newGross * (newPurity / 100); 
    const diffPure = newPure - parseFloat(oldItem.pure_weight);

    await client.query(`INSERT INTO item_updates (item_id, old_values, update_comment) VALUES ($1, $2, $3)`, [id, JSON.stringify(oldItem), update_comment]);
    await client.query(`UPDATE inventory_items SET gross_weight=$1, wastage_percent=$2, pure_weight=$3 WHERE id=$4`, [newGross, newPurity, newPure, id]);
    
    if (oldItem.vendor_id && diffPure !== 0) {
        await client.query(`UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`, [diffPure, oldItem.vendor_id]);
        await client.query(
            `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, balance_after, metal_type)
             VALUES ($1, 'STOCK_UPDATE', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4)`,
            [oldItem.vendor_id, `Updated Item: ${oldItem.item_name}`, diffPure, oldItem.metal_type]
        );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 6. DELETE ITEM
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
              `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, balance_after, metal_type)
               VALUES ($1, 'REPAYMENT', $2, 0, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4)`,
              [item.vendor_id, `Deleted: ${item.item_name}`, reduction, item.metal_type]
            );
        }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// --- 7. NEW: VENDOR SALES HISTORY (For Sold Items List) ---
router.get('/vendor-history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                si.id,
                si.sale_id,
                si.item_name,
                si.sold_weight as gross_weight,
                si.sold_rate,
                si.total_item_price,
                s.created_at,
                ii.barcode,
                ii.metal_type,
                ii.item_image,
                'SOLD' as status
            FROM sale_items si
            JOIN inventory_items ii ON si.item_id = ii.id
            JOIN sales s ON si.sale_id = s.id
            WHERE ii.vendor_id = $1
            ORDER BY s.created_at DESC
        `;
        const result = await pool.query(query, [id]);
        
        const history = result.rows.map(row => ({
            ...row,
            item_image: row.item_image ? `data:image/jpeg;base64,${row.item_image.toString('base64')}` : null
        }));
        
        res.json(history);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;