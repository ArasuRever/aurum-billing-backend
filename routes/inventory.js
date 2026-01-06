const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const getInitials = (str) => {
    if (!str) return 'XX';
    return str.replace(/[^a-zA-Z ]/g, "").split(' ')
        .map(word => word[0])
        .join('')
        .toUpperCase()
        .substring(0, 3); 
};

// 1. ADD ITEM (Single)
router.post('/add', upload.single('item_image'), async (req, res) => {
  const { 
    vendor_id, neighbour_shop_id, source_type, 
    metal_type, item_name, gross_weight, wastage_percent, making_charges, stock_type, huid, quantity
  } = req.body;
  
  const item_image = req.file ? req.file.buffer : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const seqRes = await client.query("SELECT nextval('item_barcode_seq') as num");
    const seqNum = seqRes.rows[0].num;
    
    const mPrefix = metal_type === 'SILVER' ? 'S' : 'G';
    const nameInit = getInitials(item_name);
    const barcode = `${mPrefix}-${nameInit}-${seqNum}`; 

    const finalSource = source_type || 'VENDOR'; 
    const gross = parseFloat(gross_weight) || 0;
    const purityVal = parseFloat(wastage_percent) || 0;
    const mc = parseFloat(making_charges) || 0; // Prevent crash on empty string
    
    let pure_weight = 0;
    if (req.body.pure_weight) {
        pure_weight = parseFloat(req.body.pure_weight);
    } else {
        pure_weight = gross * (purityVal / 100);
    }

    const qty = parseInt(quantity) || 1;

    const itemRes = await client.query(
      `INSERT INTO inventory_items 
      (vendor_id, neighbour_shop_id, source_type, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, item_image, status, stock_type, huid, quantity, total_quantity_added, total_weight_added)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'AVAILABLE', $12, $13, $14, $14, $7) RETURNING *`,
      [vendor_id || null, neighbour_shop_id || null, finalSource, metal_type, item_name, barcode, gross, purityVal, mc, pure_weight, item_image, stock_type || 'SINGLE', huid || null, qty]
    );
    const newItem = itemRes.rows[0];

    // LOG HISTORY
    await client.query(
        `INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description)
         VALUES ($1, 'OPENING', $2, $3, 'Initial Stock Added')`,
        [newItem.id, qty, gross]
    );

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

    // --- FIX START: Handle 'OWN' vendor_id ---
    let finalVendorId = vendor_id;
    if (finalVendorId === 'OWN' || finalVendorId === '') {
        finalVendorId = null;
    }
    // --- FIX END ---

    let totalGross = 0;
    let totalPure = 0;
    
    const processedItems = items.map(i => {
        const g = parseFloat(i.gross_weight) || 0;
        const p = parseFloat(i.wastage_percent) || 0;
        const mc = parseFloat(i.making_charges) || 0; 
        const pure = i.pure_weight ? parseFloat(i.pure_weight) : (g * (p/100));
        const qty = parseInt(i.quantity) || 1; 
        
        totalGross += g;
        totalPure += pure;
        
        return { ...i, g, p, mc, pure, qty };
    });

    // Use finalVendorId instead of vendor_id
    const batchRes = await client.query(
        `INSERT INTO stock_batches (vendor_id, invoice_no, metal_type, total_gross_weight, total_pure_weight, item_count)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [finalVendorId, invoice_no || 'MANUAL', metal_type, totalGross, totalPure, items.length]
    );
    const batchId = batchRes.rows[0].id;

    // Determine Source Type based on corrected ID
    const sourceType = finalVendorId ? 'VENDOR' : 'OWN';

    for (const item of processedItems) {
        const prefix = metal_type ? metal_type.charAt(0).toUpperCase() : 'X';
        const barcode = `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random()*1000)}`;
        const imgBuffer = item.item_image_base64 ? Buffer.from(item.item_image_base64, 'base64') : null;

        const iRes = await client.query(
            `INSERT INTO inventory_items 
            (vendor_id, batch_id, source_type, metal_type, item_name, barcode, gross_weight, wastage_percent, making_charges, pure_weight, status, stock_type, huid, item_image, quantity, total_quantity_added, total_weight_added)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'AVAILABLE', $11, $12, $13, $14, $14, $7) RETURNING id`,
            [finalVendorId, batchId, sourceType, metal_type, item.item_name, barcode, item.g, item.p, item.mc, item.pure, item.stock_type || 'SINGLE', item.huid || null, imgBuffer, item.qty]
        );
        
        await client.query(
            `INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description, related_bill_no)
             VALUES ($1, 'OPENING', $2, $3, 'Batch Import', $4)`,
            [iRes.rows[0].id, item.qty, item.g, invoice_no]
        );
    }

    // Only update vendor balance if it's a real vendor (not null)
    if (finalVendorId) {
        await client.query(
            `UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`,
            [totalPure, finalVendorId]
        );

        const ledgerDesc = items.length === 1 
            ? `Added Stock: ${items[0].item_name} (Inv#${invoice_no || 'NA'})`
            : `Inv #${invoice_no || 'NA'}: Added ${items.length} Items`;

        await client.query(
            `INSERT INTO vendor_transactions 
            (vendor_id, type, description, stock_pure_weight, balance_after, metal_type, reference_id, reference_type)
             VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4, $5, 'BATCH')`,
            [finalVendorId, ledgerDesc, totalPure, metal_type, batchId]
        );
    }

    await client.query('COMMIT');
    res.json({ success: true, batchId });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// SEARCH ROUTE
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_items 
       WHERE (barcode = $1 OR item_name ILIKE $2) 
       AND status = 'AVAILABLE' 
       AND (is_deleted IS FALSE OR is_deleted IS NULL)`,
      [q, `%${q}%`]
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. LIST ALL ITEMS
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT i.*, v.business_name as vendor_name, n.shop_name as neighbour_name
        FROM inventory_items i
        LEFT JOIN vendors v ON i.vendor_id = v.id
        LEFT JOIN external_shops n ON i.neighbour_shop_id = n.id
        WHERE i.status = 'AVAILABLE' AND (i.is_deleted IS FALSE OR i.is_deleted IS NULL)
        ORDER BY i.created_at DESC`
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. VENDOR SPECIFIC INVENTORY
router.get('/vendor/:id', async (req, res) => {
  try {
    const result = await pool.query(
        `SELECT * FROM inventory_items 
         WHERE vendor_id = $1 AND (is_deleted IS FALSE OR is_deleted IS NULL)
         ORDER BY created_at DESC`, 
         [req.params.id]
    );
    const items = result.rows.map(item => ({...item, item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null}));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. UPDATE ITEM (With Name & Image Support)
router.put('/update/:id', upload.single('item_image'), async (req, res) => {
  const { id } = req.params;
  const { item_name, gross_weight, wastage_percent, update_comment } = req.body;
  const item_image = req.file ? req.file.buffer : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const oldRes = await client.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    const oldItem = oldRes.rows[0];
    
    if (!oldItem) throw new Error("Item not found");
    if (oldItem.status !== 'AVAILABLE') {
        throw new Error(`Cannot edit item. Current status is ${oldItem.status}`);
    }

    const newGross = parseFloat(gross_weight);
    const newPurity = parseFloat(wastage_percent);
    const newPure = newGross * (newPurity / 100); 
    const diffPure = newPure - parseFloat(oldItem.pure_weight);

    // Track Changes
    await client.query(`INSERT INTO item_updates (item_id, old_values, update_comment) VALUES ($1, $2, $3)`, [id, JSON.stringify(oldItem), update_comment]);
    
    // Update Fields
    if (item_image) {
        await client.query(
            `UPDATE inventory_items SET item_name=$1, gross_weight=$2, wastage_percent=$3, pure_weight=$4, item_image=$5 WHERE id=$6`, 
            [item_name, newGross, newPurity, newPure, item_image, id]
        );
    } else {
        await client.query(
            `UPDATE inventory_items SET item_name=$1, gross_weight=$2, wastage_percent=$3, pure_weight=$4 WHERE id=$5`, 
            [item_name, newGross, newPurity, newPure, id]
        );
    }
    
    // Update Ledger if needed
    if (oldItem.vendor_id && Math.abs(diffPure) > 0.001) {
        await client.query(`UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`, [diffPure, oldItem.vendor_id]);
        await client.query(
            `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, balance_after, metal_type)
             VALUES ($1, 'STOCK_UPDATE', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4)`,
            [oldItem.vendor_id, `Updated: ${oldItem.item_name} (Wt Change)`, diffPure, oldItem.metal_type]
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
        if (item.status === 'SOLD') {
            throw new Error("Cannot delete a SOLD item directly. Please delete the Bill instead.");
        }

        await client.query("UPDATE inventory_items SET status='DELETED', is_deleted=TRUE WHERE id = $1", [id]);
        
        if (item.source_type === 'VENDOR' && item.vendor_id) {
            const reduction = parseFloat(item.pure_weight) || 0;
            await client.query('UPDATE vendors SET balance_pure_weight = balance_pure_weight - $1 WHERE id = $2', [reduction, item.vendor_id]);
            
            // Insert Repayment with Reference to allow Restore
            await client.query(
              `INSERT INTO vendor_transactions (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, balance_after, metal_type, reference_id, reference_type)
               VALUES ($1, 'REPAYMENT', $2, 0, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4, $5, 'ITEM_DELETE')`,
              [item.vendor_id, `Deleted: ${item.item_name}`, reduction, item.metal_type, id]
            );
        }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 7. RESTOCK BULK ITEM
router.post('/restock/:id', async (req, res) => {
    const { id } = req.params;
    const { added_gross_weight, added_quantity, wastage_percent, invoice_no, description } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const itemRes = await client.query("SELECT * FROM inventory_items WHERE id = $1", [id]);
        if (itemRes.rows.length === 0) throw new Error("Item not found");
        const item = itemRes.rows[0];

        if (item.stock_type !== 'BULK') throw new Error("Restock is only allowed for BULK items.");

        const addedWt = parseFloat(added_gross_weight);
        const addedQty = parseInt(added_quantity);
        const newWastage = wastage_percent ? parseFloat(wastage_percent) : parseFloat(item.wastage_percent);
        
        const addedPure = addedWt * (newWastage / 100);

        await client.query(
            `UPDATE inventory_items 
             SET gross_weight = gross_weight + $1, 
                 quantity = quantity + $2,
                 pure_weight = pure_weight + $3,
                 total_weight_added = total_weight_added + $1,
                 total_quantity_added = total_quantity_added + $2,
                 status = 'AVAILABLE',
                 wastage_percent = $4
             WHERE id = $5`,
            [addedWt, addedQty, addedPure, newWastage, id]
        );

        await client.query(
            `INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, related_bill_no, description)
             VALUES ($1, 'RESTOCK', $2, $3, $4, $5)`,
            [id, addedQty, addedWt, invoice_no, description || 'Restock Added']
        );

        if (item.vendor_id) {
            await client.query(`UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`, [addedPure, item.vendor_id]);
            await client.query(
                `INSERT INTO vendor_transactions 
                (vendor_id, type, description, stock_pure_weight, balance_after, metal_type)
                 VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4)`,
                [item.vendor_id, `Restock: ${item.item_name} (+${addedWt}g)`, addedPure, item.metal_type]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 8. GET ITEM HISTORY
router.get('/history/:id', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM item_stock_logs WHERE inventory_item_id = $1 ORDER BY created_at DESC", 
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. RESTORE DELETED ITEM
router.post('/restore/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Find the Item
        const itemRes = await client.query("SELECT * FROM inventory_items WHERE id = $1", [id]);
        if (itemRes.rows.length === 0) throw new Error("Item not found in database.");
        const item = itemRes.rows[0];

        // 2. Check if already active
        if (!item.is_deleted) throw new Error("Item is already active (not deleted).");

        // 3. Restore status
        await client.query(
            "UPDATE inventory_items SET status='AVAILABLE', is_deleted=FALSE WHERE id = $1", 
            [id]
        );

        // 4. Restore Vendor Balance
        if (item.source_type === 'VENDOR' && item.vendor_id) {
            const pureVal = parseFloat(item.pure_weight) || 0;
            await client.query(
                `UPDATE vendors SET balance_pure_weight = balance_pure_weight + $1 WHERE id = $2`,
                [pureVal, item.vendor_id]
            );

            // 5. Log Transaction
            await client.query(
                `INSERT INTO vendor_transactions 
                (vendor_id, type, description, stock_pure_weight, balance_after, metal_type, reference_id, reference_type)
                 VALUES ($1, 'STOCK_ADDED', $2, $3, (SELECT balance_pure_weight FROM vendors WHERE id=$1), $4, $5, 'ITEM_RESTORE')`,
                [item.vendor_id, `Restored: ${item.item_name}`, pureVal, item.metal_type, id]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Item Restored Successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 10. GET OWN AVAILABLE ITEMS
router.get('/own/list', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_items 
       WHERE source_type = 'OWN' 
       AND status = 'AVAILABLE' 
       AND (is_deleted IS FALSE OR is_deleted IS NULL)
       ORDER BY created_at DESC`
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 11. GET OWN SALES & LENT HISTORY
router.get('/own/history', async (req, res) => {
    try {
        const query = `
            SELECT 
                si.id, si.sale_id, si.item_name, si.sold_weight as gross_weight, 
                si.quantity, si.sold_rate, si.total_item_price, s.created_at, 
                ii.barcode, ii.metal_type, ii.item_image, 'SOLD' as status
            FROM sale_items si
            JOIN inventory_items ii ON si.item_id = ii.id
            JOIN sales s ON si.sale_id = s.id
            WHERE ii.source_type = 'OWN'
            
            UNION ALL
            
            SELECT 
                st.id, st.shop_id as sale_id, st.description as item_name, st.gross_weight, 
                st.quantity, 0 as sold_rate, 0 as total_item_price, st.created_at, 
                ii.barcode, ii.metal_type, ii.item_image, 'LENT' as status
            FROM shop_transactions st
            JOIN inventory_items ii ON st.inventory_item_id = ii.id
            WHERE ii.source_type = 'OWN' AND st.type = 'LEND_ADD'
            
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query);
        const history = result.rows.map(row => ({
            ...row,
            item_image: row.item_image ? `data:image/jpeg;base64,${row.item_image.toString('base64')}` : null
        }));
        res.json(history);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;