const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');

// Setup Multer for memory storage (we save image buffer directly to DB)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// 1. ADD VENDOR
// ==========================================
router.post('/add', async (req, res) => {
  const { business_name, contact_number, address, gst_number } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO vendors (business_name, contact_number, address, gst_number) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [business_name, contact_number, address, gst_number]
    );
    res.json({ success: true, message: 'Vendor added', vendor: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. SEARCH VENDOR (By Name or Agent Name)
// ==========================================
router.get('/search', async (req, res) => {
  const { q } = req.query; // ?q=SomeName
  
  try {
    // This query joins vendors and agents to search both columns
    const query = `
      SELECT DISTINCT v.* FROM vendors v
      LEFT JOIN vendor_agents va ON v.id = va.vendor_id
      WHERE v.business_name ILIKE $1 OR va.agent_name ILIKE $1
    `;
    const result = await pool.query(query, [`%${q}%`]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. ADD AGENT (With Photo Upload)
// ==========================================
router.post('/add-agent', upload.single('agent_photo'), async (req, res) => {
  const { vendor_id, agent_name, agent_phone } = req.body;
  const agent_photo = req.file ? req.file.buffer : null; // Get image buffer

  try {
    await pool.query(
      `INSERT INTO vendor_agents (vendor_id, agent_name, agent_phone, agent_photo) 
       VALUES ($1, $2, $3, $4)`,
      [vendor_id, agent_name, agent_phone, agent_photo]
    );
    res.json({ success: true, message: 'Agent added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. REPAYMENT / STOCK TRANSACTION
// ==========================================
router.post('/transaction', async (req, res) => {
  const { vendor_id, type, description, metal_weight, cash_amount, conversion_rate } = req.body;
  // type must be 'STOCK_ADDED' or 'REPAYMENT'

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN'); // Start Transaction

    let balanceChange = 0;
    let totalRepaidPure = 0;
    let cashConverted = 0;

    // --- LOGIC: STOCK ADDED ---
    if (type === 'STOCK_ADDED') {
      balanceChange = parseFloat(metal_weight); // We OWE more gold
    } 
    
    // --- LOGIC: REPAYMENT ---
    else if (type === 'REPAYMENT') {
      // Calculate Cash to Gold conversion
      if (cash_amount > 0 && conversion_rate > 0) {
        cashConverted = parseFloat(cash_amount) / parseFloat(conversion_rate);
      }
      
      totalRepaidPure = parseFloat(metal_weight || 0) + cashConverted;
      balanceChange = -totalRepaidPure; // We OWE less gold
    }

    // 1. Get Current Balance
    const vendRes = await client.query(`SELECT balance_pure_weight FROM vendors WHERE id = $1`, [vendor_id]);
    const currentBal = parseFloat(vendRes.rows[0].balance_pure_weight);
    const newBal = currentBal + balanceChange;

    // 2. Update Vendor Balance
    await client.query(`UPDATE vendors SET balance_pure_weight = $1 WHERE id = $2`, [newBal, vendor_id]);

    // 3. Log Transaction
    await client.query(
      `INSERT INTO vendor_transactions 
      (vendor_id, type, description, stock_pure_weight, repaid_metal_weight, repaid_cash_amount, conversion_rate, cash_converted_weight, total_repaid_pure, balance_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [vendor_id, type, description, (type === 'STOCK_ADDED' ? metal_weight : 0), (type === 'REPAYMENT' ? metal_weight : 0), cash_amount, conversion_rate, cashConverted, totalRepaidPure, newBal]
    );

    await client.query('COMMIT'); // Commit Transaction
    res.json({ success: true, new_balance: newBal });

  } catch (err) {
    await client.query('ROLLBACK'); // Undo if error
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 5. GET VENDOR AGENTS
// ==========================================
router.get('/:id/agents', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_agents WHERE vendor_id = $1 ORDER BY id DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 6. GET VENDOR TRANSACTIONS (HISTORY)
// ==========================================
router.get('/:id/transactions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_transactions WHERE vendor_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. UPDATE VENDOR DETAILS
// ==========================================
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { business_name, contact_number, address, gst_number } = req.body;
  
  try {
    await pool.query(
      `UPDATE vendors SET business_name=$1, contact_number=$2, address=$3, gst_number=$4 WHERE id=$5`,
      [business_name, contact_number, address, gst_number, id]
    );
    res.json({ success: true, message: 'Vendor updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;