const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. CREATE NEW CHIT PLAN
router.post('/create', async (req, res) => {
    const { customer_id, plan_type, plan_name, monthly_amount } = req.body;
    if (!['AMOUNT', 'GOLD'].includes(plan_type)) {
        return res.status(400).json({ error: "Invalid Plan Type. Use 'AMOUNT' or 'GOLD'." });
    }
    try {
        const result = await pool.query(
            `INSERT INTO chits (customer_id, plan_type, plan_name, monthly_amount) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [customer_id, plan_type, plan_name, monthly_amount]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- NEW ROUTE: GET ALL CUSTOMERS WITH ACTIVE CHITS ---
router.get('/active-customers', async (req, res) => {
    try {
        // Fetch customers who have at least one ACTIVE chit
        const result = await pool.query(`
            SELECT DISTINCT c.id, c.name, c.phone, c.profile_image, 
                   (SELECT COUNT(*) FROM chits WHERE customer_id = c.id AND status = 'ACTIVE') as active_count
            FROM customers c
            JOIN chits ch ON c.id = ch.customer_id
            WHERE ch.status = 'ACTIVE'
            ORDER BY c.name ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// -------------------------------------------------------

// 2. LIST CUSTOMER CHITS (With Progress)
router.get('/customer/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `SELECT c.*, 
                    COALESCE(SUM(p.amount), 0) as total_paid, 
                    COALESCE(SUM(p.gold_weight), 0) as total_gold_weight,
                    COUNT(p.id) as installments_paid
             FROM chits c
             LEFT JOIN chit_payments p ON c.id = p.chit_id
             WHERE c.customer_id = $1
             GROUP BY c.id
             ORDER BY c.created_at DESC`,
            [id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. GET CHIT DETAILS & HISTORY
router.get('/details/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const chitRes = await pool.query("SELECT * FROM chits WHERE id = $1", [id]);
        if (chitRes.rows.length === 0) return res.status(404).json({ error: "Chit not found" });

        const historyRes = await pool.query(
            "SELECT * FROM chit_payments WHERE chit_id = $1 ORDER BY payment_date DESC",
            [id]
        );

        res.json({ plan: chitRes.rows[0], history: historyRes.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. MAKE PAYMENT
router.post('/pay', async (req, res) => {
    const { chit_id, amount, payment_date } = req.body; 
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const chitQuery = await client.query("SELECT * FROM chits WHERE id = $1", [chit_id]);
        if (chitQuery.rows.length === 0) throw new Error("Chit Plan not found");
        const chit = chitQuery.rows[0];

        let gold_rate = 0;
        let gold_weight = 0;

        if (chit.plan_type === 'GOLD') {
            const rateRes = await client.query("SELECT rate FROM daily_rates WHERE metal_type = 'GOLD 999'");
            if (rateRes.rows.length === 0) throw new Error("GOLD 999 Rate not set.");
            gold_rate = parseFloat(rateRes.rows[0].rate);
            if (gold_rate <= 0) throw new Error("Invalid Gold Rate.");
            gold_weight = parseFloat(amount) / gold_rate;
        }

        await client.query(
            `INSERT INTO chit_payments (chit_id, amount, gold_rate, gold_weight, payment_date) 
             VALUES ($1, $2, $3, $4, $5)`,
            [chit_id, amount, gold_rate, gold_weight, payment_date || new Date()]
        );

        await client.query("UPDATE shop_assets SET cash_balance = cash_balance + $1 WHERE id = 1", [amount]);

        await client.query('COMMIT');
        res.json({ success: true, gold_weight: gold_weight });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 5. ADD BONUS (For 12th Month)
router.post('/add-bonus/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const chitQuery = await client.query("SELECT * FROM chits WHERE id = $1", [id]);
        const chit = chitQuery.rows[0];

        if (chit.plan_type !== 'AMOUNT') throw new Error("Bonus is only for AMOUNT plans.");

        await client.query(
            `INSERT INTO chit_payments (chit_id, amount, is_bonus, notes) 
             VALUES ($1, $2, TRUE, '12th Month Bonus')`,
            [id, chit.monthly_amount]
        );

        await client.query("UPDATE chits SET status = 'MATURED' WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 6. CLOSE / REDEEM PLAN
router.post('/close/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE chits SET status = 'CLOSED', closed_at = NOW() WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;