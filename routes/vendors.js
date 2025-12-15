const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

// Setup Multer for Agent Photos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. ADD VENDOR
router.post('/add', async (req, res) => {
  const { business_name, contact_number, address, gst_number } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO vendors (business_name, contact_number, address, gst_number, balance_pure_weight) VALUES ($1, $2, $3, $4, 0) RETURNING *',
      [business_name, contact_number, address, gst_number]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. SEARCH VENDORS
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM vendors WHERE business_name ILIKE $1 OR contact_number ILIKE $1",
      [`%${q || ''}%`]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. UPDATE VENDOR DETAILS
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { business_name, contact_number, address, gst_number } = req.body;
  try {
    await pool.query(
      `UPDATE vendors SET business_name=$1, contact_number=$2, address=$3, gst_number=$4 WHERE id=$5`,
      [business_name, contact_number, address, gst_number, id]
    );
    res.json({ success: true, message: 'Vendor updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. ADD AGENT
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

// 5. GET AGENTS
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

// 6. UPDATE AGENT (NEW)
router.put('/agent/:id', upload.single('agent_photo'), async (req, res) => {
  const { id } = req.params;
  const { agent_name, agent_phone } = req.body;
  const agent_photo = req.file ? req.file.buffer : null; // Optional
  
  try {
    if (agent_photo) {
      await pool.query('UPDATE vendor_agents SET agent_name=$1, agent_phone=$2, agent_photo=$3 WHERE id=$4', [agent_name, agent_phone, agent_photo, id]);
    } else {
      await pool.query('UPDATE vendor_agents SET agent_name=$1, agent_phone=$2 WHERE id=$3', [agent_name, agent_phone, id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. DELETE AGENT (NEW)
router.delete('/agent/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vendor_agents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. GET TRANSACTIONS
router.get('/:id/transactions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_transactions WHERE vendor_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. ADD TRANSACTION
router.post('/transaction', async (req, res) => {
  const { vendor_id, type, description, metal_weight, cash_amount, conversion_rate } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Calculate Pure Weight Impact
    let pureImpact = 0;
    let cashConverted = 0;

    if (type === 'STOCK_ADDED') {
      pureImpact = parseFloat(metal_weight); // Adds to debt
    } else if (type === 'REPAYMENT') {
      // Metal Repayment
      pureImpact = -parseFloat(metal_weight || 0); 
      // Cash Repayment (Converted to Gold)
      if (cash_amount > 0 && conversion_rate > 0) {
        cashConverted = parseFloat(cash_amount) / parseFloat(conversion_rate);
        pureImpact -= cashConverted;
      }
    }

    // Update Vendor Balance
    const vendRes = await client.query('SELECT balance_pure_weight FROM vendors WHERE id = $1 FOR UPDATE', [vendor_id]);
    const currentBal = parseFloat(vendRes.rows[0].balance_pure_weight);
    const newBal = currentBal + pureImpact;

    await client.query('UPDATE vendors SET balance_pure_weight = $1 WHERE id = $2', [newBal, vendor_id]);

    // Log Transaction
    const totalRepaidPure = type === 'REPAYMENT' ? (parseFloat(metal_weight||0) + cashConverted) : 0;
    
    await client.query(
      `INSERT INTO vendor_transactions 
      (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, repaid_cash_amount, conversion_rate, cash_converted_weight, total_repaid_pure, balance_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [vendor_id, type, description, (type==='STOCK_ADDED'?metal_weight:0), (type==='REPAYMENT'?metal_weight:0), cash_amount, conversion_rate, cashConverted, totalRepaidPure, newBal]
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

module.exports = router;