const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

// Setup Multer for Agent Photos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. ADD VENDOR (Updated to save vendor_type)
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

// 3. UPDATE VENDOR DETAILS (Updated to save vendor_type)
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

// 4. ADD AGENT (Restored)
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

// 5. GET AGENTS (Restored - Fixes missing agents)
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

// 6. UPDATE AGENT (Restored)
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

// 7. DELETE AGENT (Restored)
router.delete('/agent/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vendor_agents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. GET TRANSACTIONS (Restored - Fixes missing Ledger)
router.get('/:id/transactions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_transactions WHERE vendor_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. MANUAL LEDGER TRANSACTION (For Settlements)
router.post('/transaction', async (req, res) => {
    const { vendor_id, type, description, metal_weight, cash_amount, conversion_rate } = req.body;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      let pureImpact = 0;
      let cashConverted = 0;

      // REPAYMENT LOGIC: Reduces the debt (Balance goes DOWN)
      if (type === 'REPAYMENT') {
          // 1. Metal Repayment
          if (metal_weight) pureImpact += parseFloat(metal_weight);
          
          // 2. Cash Repayment (Converted to Metal)
          if (cash_amount && conversion_rate) {
              cashConverted = parseFloat(cash_amount) / parseFloat(conversion_rate);
              pureImpact += cashConverted;
          }
      }

      // Update Vendor Balance (Decrease by pureImpact)
      await client.query(
          `UPDATE vendors SET balance_pure_weight = balance_pure_weight - $1 WHERE id = $2`,
          [pureImpact, vendor_id]
      );

      // Log Transaction
      await client.query(
          `INSERT INTO vendor_transactions 
          (vendor_id, type, description, repaid_metal_weight, cash_amount, conversion_rate, cash_converted_weight, balance_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT balance_pure_weight FROM vendors WHERE id=$1))`,
          [
              vendor_id, type, description, 
              parseFloat(metal_weight)||0, parseFloat(cash_amount)||0, parseFloat(conversion_rate)||0, cashConverted
          ]
      );

      await client.query('COMMIT');
      res.json({ success: true });
    } catch(err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

module.exports = router;