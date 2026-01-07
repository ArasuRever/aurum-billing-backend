const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

// Setup Multer for Agent Photos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. ADD VENDOR
router.post('/add', async (req, res) => {
  const { business_name, contact_number, address, gst_number, vendor_type } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO vendors 
       (business_name, contact_number, address, gst_number, vendor_type, balance_pure_weight, is_deleted) 
       VALUES ($1, $2, $3, $4, $5, 0, FALSE) RETURNING *`,
      [business_name, contact_number, address, gst_number, vendor_type || 'BOTH']
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. SEARCH VENDORS (Filtered for is_deleted = FALSE)
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM vendors 
       WHERE (business_name ILIKE $1 OR contact_number ILIKE $1) 
       AND is_deleted IS FALSE 
       ORDER BY id DESC`,
      [`%${q || ''}%`]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. GET ALL VENDORS (Filtered for is_deleted = FALSE)
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM vendors WHERE is_deleted IS FALSE ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. UPDATE VENDOR DETAILS
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { business_name, contact_number, address, gst_number, vendor_type } = req.body;
  try {
    await pool.query(
      `UPDATE vendors 
       SET business_name=$1, contact_number=$2, address=$3, gst_number=$4, vendor_type=$5 
       WHERE id=$6`,
      [business_name, contact_number, address, gst_number, vendor_type, id]
    );
    res.json({ success: true, message: 'Vendor updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. ADD AGENT
router.post('/add-agent', upload.single('agent_photo'), async (req, res) => {
  const { vendor_id, agent_name, agent_phone } = req.body;
  const agent_photo = req.file ? req.file.buffer : null;
  try {
    await pool.query(
      'INSERT INTO vendor_agents (vendor_id, agent_name, agent_phone, agent_photo) VALUES ($1, $2, $3, $4)',
      [vendor_id, agent_name, agent_phone, agent_photo]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. GET AGENTS
router.get('/:id/agents', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_agents WHERE vendor_id = $1 ORDER BY id DESC', [req.params.id]);
    const agents = result.rows.map(a => ({
      ...a,
      agent_photo: a.agent_photo ? `data:image/jpeg;base64,${a.agent_photo.toString('base64')}` : null
    }));
    res.json(agents);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. UPDATE AGENT
router.put('/agent/:id', upload.single('agent_photo'), async (req, res) => {
  const { id } = req.params;
  const { agent_name, agent_phone } = req.body;
  const agent_photo = req.file ? req.file.buffer : null;
  
  try {
    if (agent_photo) {
      await pool.query('UPDATE vendor_agents SET agent_name=$1, agent_phone=$2, agent_photo=$3 WHERE id=$4', [agent_name, agent_phone, agent_photo, id]);
    } else {
      await pool.query('UPDATE vendor_agents SET agent_name=$1, agent_phone=$2 WHERE id=$3', [agent_name, agent_phone, id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. DELETE AGENT
router.delete('/agent/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vendor_agents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. GET TRANSACTIONS
router.get('/:id/transactions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_transactions WHERE vendor_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 10. MANUAL LEDGER TRANSACTION
router.post('/transaction', async (req, res) => {
    const { vendor_id, type, description, metal_weight, cash_amount, conversion_rate } = req.body;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      let pureImpact = 0;
      let cashConverted = 0;

      const safeMetal = parseFloat(metal_weight) || 0;
      const safeCash = parseFloat(cash_amount) || 0;
      const safeRate = parseFloat(conversion_rate) || 0;

      if (type === 'STOCK_ADDED') {
        pureImpact = safeMetal;
      } else if (type === 'REPAYMENT') {
        pureImpact = -safeMetal; 
        if (safeCash > 0 && safeRate > 0) {
          cashConverted = safeCash / safeRate;
          pureImpact -= cashConverted;
        }

        if (safeCash > 0) {
            await client.query(
                `UPDATE shop_assets SET cash_balance = cash_balance - $1 WHERE id = 1`,
                [safeCash]
            );
        }
      }

      const vendRes = await client.query('SELECT balance_pure_weight FROM vendors WHERE id = $1 FOR UPDATE', [vendor_id]);
      const currentBal = parseFloat(vendRes.rows[0].balance_pure_weight) || 0;
      const newBal = currentBal + pureImpact;

      await client.query('UPDATE vendors SET balance_pure_weight = $1 WHERE id = $2', [newBal, vendor_id]);

      const totalRepaidPure = type === 'REPAYMENT' ? (safeMetal + cashConverted) : 0;
      
      await client.query(
        `INSERT INTO vendor_transactions 
        (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, repaid_cash_amount, conversion_rate, cash_converted_weight, total_repaid_pure, balance_after)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            vendor_id, type, description, 
            (type==='STOCK_ADDED' ? safeMetal : 0), 
            (type==='REPAYMENT' ? safeMetal : 0), 
            safeCash, safeRate, cashConverted, totalRepaidPure, newBal
        ]
      );

      await client.query('COMMIT');
      res.json({ success: true, new_balance: newBal });

    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

// 11. GET VENDOR SPECIFIC INVENTORY
router.get('/:id/inventory', async (req, res) => {
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

// 12. GET VENDOR SALES & LENT HISTORY
router.get('/:id/sales-history', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                si.id, si.sale_id, si.item_name, si.sold_weight as gross_weight, si.quantity, si.sold_rate, si.total_item_price, s.created_at, ii.barcode, ii.metal_type, ii.item_image, 'SOLD' as status
            FROM sale_items si
            JOIN inventory_items ii ON si.item_id = ii.id
            JOIN sales s ON si.sale_id = s.id
            WHERE ii.vendor_id = $1
            
            UNION ALL
            
            SELECT 
                st.id, st.shop_id as sale_id, st.description as item_name, st.gross_weight, st.quantity, 0 as sold_rate, 0 as total_item_price, st.created_at, ii.barcode, ii.metal_type, ii.item_image, 'LENT' as status
            FROM shop_transactions st
            JOIN inventory_items ii ON st.inventory_item_id = ii.id
            WHERE ii.vendor_id = $1 AND st.type = 'LEND_ADD'
            
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query, [id]);
        const history = result.rows.map(row => ({
            ...row,
            item_image: row.item_image ? `data:image/jpeg;base64,${row.item_image.toString('base64')}` : null
        }));
        res.json(history);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 13. UPDATE SOLD/LENT HISTORY ITEM
router.put('/update-sale-history/:id', async (req, res) => {
  const { id } = req.params; // sale_item.id (SOLD) or shop_transactions.id (LENT)
  const { type, item_name, gross_weight, wastage_percent, sold_rate, total_amount } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (type === 'SOLD') {
      // 1. Get the inventory item ID linked to this sale item
      const siRes = await client.query('SELECT item_id FROM sale_items WHERE id = $1', [id]);
      if (siRes.rows.length === 0) throw new Error('Sale item not found');
      const itemId = siRes.rows[0].item_id;

      // 2. Update Inventory Item (Name, Touch) for record keeping
      await client.query(
        'UPDATE inventory_items SET item_name = $1, wastage_percent = $2 WHERE id = $3',
        [item_name, wastage_percent, itemId]
      );

      // 3. Update Sale Item (Weight, Rate, Price)
      await client.query(
        'UPDATE sale_items SET sold_weight = $1, sold_rate = $2, total_item_price = $3 WHERE id = $4',
        [gross_weight, sold_rate, total_amount, id]
      );

    } else if (type === 'LENT') {
      // 1. Get inventory item ID linked to this transaction
      const stRes = await client.query('SELECT inventory_item_id FROM shop_transactions WHERE id = $1', [id]);
      if (stRes.rows.length === 0) throw new Error('Transaction not found');
      const itemId = stRes.rows[0].inventory_item_id;

      // 2. Update Inventory Item (Name, Touch)
      await client.query(
        'UPDATE inventory_items SET item_name = $1, wastage_percent = $2 WHERE id = $3',
        [item_name, wastage_percent, itemId]
      );

      // 3. Update Transaction (Weight)
      // LENT items use 'gross_weight' in shop_transactions
      await client.query(
        'UPDATE shop_transactions SET gross_weight = $1, description = $2 WHERE id = $3',
        [gross_weight, item_name, id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: "History item updated successfully" });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 14. SOFT DELETE VENDOR (WITH STOCK ACTION)
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const { stock_action } = req.query; // 'DELETE' or 'MOVE'
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Check if Vendor exists
        const check = await client.query("SELECT * FROM vendors WHERE id = $1", [id]);
        if (check.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Vendor not found" });
        }

        // 2. Soft Delete the Vendor
        await client.query("UPDATE vendors SET is_deleted = TRUE WHERE id = $1", [id]);

        let message = "Vendor deleted.";

        // 3. Handle Inventory Items
        if (stock_action === 'MOVE') {
            // Option A: Move stocks to Own Shop Inventory
            const moveResult = await client.query(
                `UPDATE inventory_items 
                 SET vendor_id = NULL, source_type = 'OWN' 
                 WHERE vendor_id = $1 AND status = 'AVAILABLE' AND (is_deleted IS FALSE OR is_deleted IS NULL)`,
                [id]
            );
            message += ` ${moveResult.rowCount} items moved to Shop Inventory.`;
        } else {
            // Option B: Delete stocks (Default)
            const deleteResult = await client.query(
                `UPDATE inventory_items 
                 SET status = 'DELETED', is_deleted = TRUE 
                 WHERE vendor_id = $1 AND status = 'AVAILABLE'`,
                [id]
            );
            message += ` ${deleteResult.rowCount} items removed from stock.`;
        }

        await client.query('COMMIT');
        res.json({ success: true, message });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;