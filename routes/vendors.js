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
       (business_name, contact_number, address, gst_number, vendor_type, balance_pure_weight) 
       VALUES ($1, $2, $3, $4, $5, 0) RETURNING *`,
      [business_name, contact_number, address, gst_number, vendor_type || 'BOTH']
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. SEARCH VENDORS
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM vendors WHERE business_name ILIKE $1 OR contact_number ILIKE $1 ORDER BY id DESC",
      [`%${q || ''}%`]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. GET ALL VENDORS (WAS MISSING)
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM vendors ORDER BY id DESC");
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

// 12. GET VENDOR SALES HISTORY
router.get('/:id/sales-history', async (req, res) => {
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