const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 1. GET ALL BILLS (History)
router.get('/history', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM gst_bills ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. GET SINGLE BILL (With Items & Exchange)
router.get('/:id', async (req, res) => {
    try {
        const billRes = await pool.query("SELECT * FROM gst_bills WHERE id = $1", [req.params.id]);
        if (billRes.rows.length === 0) return res.status(404).json({ error: "Bill not found" });
        
        const itemsRes = await pool.query("SELECT * FROM gst_bill_items WHERE bill_id = $1", [req.params.id]);
        const exchangeRes = await pool.query("SELECT * FROM gst_bill_exchange_items WHERE bill_id = $1", [req.params.id]);
        
        res.json({ 
            bill: billRes.rows[0], 
            items: itemsRes.rows,
            exchange_items: exchangeRes.rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. CREATE BILL
router.post('/create', async (req, res) => {
    const { customer, items, exchangeItems, totals, date, invoice_no } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Insert Bill Header
        const billRes = await client.query(
            `INSERT INTO gst_bills 
            (invoice_number, bill_date, customer_name, customer_phone, customer_address, customer_gstin, 
             gross_total, cgst_amount, sgst_amount, exchange_total, total_amount)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [invoice_no, date, customer.name, customer.phone, customer.address, customer.gstin, 
             totals.taxable, totals.cgst, totals.sgst, totals.exchange, totals.final]
        );
        const billId = billRes.rows[0].id;

        // Insert Sale Items
        if (items && items.length > 0) {
            for (const item of items) {
                await client.query(
                    `INSERT INTO gst_bill_items 
                    (bill_id, item_name, hsn_code, gross_weight, wastage_percent, wastage_weight, purity, rate, making_charges, discount_amount, taxable_value)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [billId, item.item_name, item.hsn_code, item.gross_weight, item.wastage_percent, item.wastage_weight, item.purity, item.rate, item.making_charges, item.discount, item.total]
                );
            }
        }

        // Insert Exchange Items
        if (exchangeItems && exchangeItems.length > 0) {
            for (const ex of exchangeItems) {
                await client.query(
                    `INSERT INTO gst_bill_exchange_items 
                    (bill_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, total_amount)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [billId, ex.item_name, ex.metal_type, ex.gross_weight, ex.less_percent, ex.less_weight, ex.net_weight, ex.rate, ex.total]
                );
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, billId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 4. UPDATE BILL
router.put('/update/:id', async (req, res) => {
    const { id } = req.params;
    const { customer, items, exchangeItems, totals, date } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Update Header
        await client.query(
            `UPDATE gst_bills SET 
             bill_date=$1, customer_name=$2, customer_phone=$3, customer_address=$4, customer_gstin=$5, 
             gross_total=$6, cgst_amount=$7, sgst_amount=$8, exchange_total=$9, total_amount=$10 
             WHERE id=$11`,
            [date, customer.name, customer.phone, customer.address, customer.gstin, 
             totals.taxable, totals.cgst, totals.sgst, totals.exchange, totals.final, id]
        );

        // Replace Sale Items
        await client.query("DELETE FROM gst_bill_items WHERE bill_id = $1", [id]);
        if (items && items.length > 0) {
            for (const item of items) {
                await client.query(
                    `INSERT INTO gst_bill_items 
                    (bill_id, item_name, hsn_code, gross_weight, wastage_percent, wastage_weight, purity, rate, making_charges, discount_amount, taxable_value)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [id, item.item_name, item.hsn_code, item.gross_weight, item.wastage_percent, item.wastage_weight, item.purity, item.rate, item.making_charges, item.discount, item.total]
                );
            }
        }

        // Replace Exchange Items
        await client.query("DELETE FROM gst_bill_exchange_items WHERE bill_id = $1", [id]);
        if (exchangeItems && exchangeItems.length > 0) {
            for (const ex of exchangeItems) {
                await client.query(
                    `INSERT INTO gst_bill_exchange_items 
                    (bill_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, total_amount)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [id, ex.item_name, ex.metal_type, ex.gross_weight, ex.less_percent, ex.less_weight, ex.net_weight, ex.rate, ex.total]
                );
            }
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

// 5. DELETE BILL
router.delete('/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM gst_bills WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;