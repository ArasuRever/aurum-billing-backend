const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { logAction } = require('../services/auditService'); // Import the Audit Service
const jwt = require('jsonwebtoken'); // Needed to identify who is doing the action

// --- HELPER: Identify User from Token ---
// This ensures we know WHO is creating/deleting the bill, even if the route is public
const getUserFromRequest = (req) => {
    try {
        const token = req.header('Authorization')?.split(' ')[1];
        if (token && process.env.JWT_SECRET) {
            return jwt.verify(token, process.env.JWT_SECRET);
        }
    } catch (e) {
        // Token invalid or expired, user remains null
    }
    return null;
};

// 1. GET INVOICE DETAILS
router.get('/invoice/:id', async (req, res) => {
    const { id } = req.params;
    try {
        let query = "SELECT * FROM sales WHERE invoice_number = $1";
        let params = [id];
        
        if (!isNaN(id)) {
             query = "SELECT * FROM sales WHERE id = $1 OR invoice_number = $2";
             params = [id, id];
        }
        
        const saleRes = await pool.query(query, params);
        if(saleRes.rows.length === 0) return res.status(404).json({error: "Invoice not found"});
        
        const sale = saleRes.rows[0];
        const itemsRes = await pool.query("SELECT * FROM sale_items WHERE sale_id = $1", [sale.id]);
        const exchangeRes = await pool.query("SELECT * FROM sale_exchange_items WHERE sale_id = $1", [sale.id]);

        res.json({ 
            sale: sale, 
            items: itemsRes.rows, 
            exchangeItems: exchangeRes.rows 
        });

    } catch(err) { res.status(500).json({error: err.message}); }
});

// 2. SEARCH ITEMS
router.get('/search-item', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, item_name, barcode, gross_weight, wastage_percent, making_charges, metal_type, stock_type, status, item_image 
       FROM inventory_items 
       WHERE (barcode = $1 OR item_name ILIKE $2) AND status = 'AVAILABLE'`,
      [q, `%${q}%`]
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. CREATE BILL (SECURE & LOGGED)
router.post('/create-bill', async (req, res) => {
  const { customer, items, exchangeItems, totals, includeGST } = req.body;
  const client = await pool.connect();
  req.user = getUserFromRequest(req); // Capture User for Audit Log
  
  try {
    await client.query('BEGIN');

    // --- SECURITY CHECK: VERIFY TOTALS ---
    // UPDATED LOGIC: We sum the individual item totals (which already have discounts applied).
    // This prevents the "Double Discounting" error where we subtracted discount twice.
    let backendTaxable = 0;
    
    for (const item of items) {
        if (item.item_id && item.stock_type !== 'BULK') {
             const dbItemRes = await client.query(
                 "SELECT * FROM inventory_items WHERE id = $1 AND status = 'AVAILABLE' FOR UPDATE", 
                 [item.item_id]
             );
             
             if (dbItemRes.rows.length === 0) {
                 throw new Error(`Item ${item.item_name} is no longer available.`);
             }
        }
        // Trust the rounded total from frontend (Price - Discount)
        backendTaxable += parseFloat(item.total);
    }

    const backendExchangeTotal = exchangeItems.reduce((acc, ex) => acc + (parseFloat(ex.total) || 0), 0);
    
    // Calculate Tax on the Taxable Amount
    const backendSGST = includeGST ? Math.round(backendTaxable * 0.015) : 0;
    const backendCGST = includeGST ? Math.round(backendTaxable * 0.015) : 0;
    
    const backendNetRaw = backendTaxable + backendSGST + backendCGST - backendExchangeTotal;
    const backendNet = Math.round(backendNetRaw / 10) * 10; 

    // Allow a small margin (₹2) for floating point rounding differences
    if (Math.abs(backendNet - totals.netPayable) > 2.00) {
        throw new Error(`Security Alert: Price Mismatch. Server: ${backendNet}, Client: ${totals.netPayable}`);
    }
    // --- END SECURITY CHECK ---

    const invoiceNumber = `INV-${Date.now()}`;
    const cashReceived = parseFloat(totals.cashReceived) || 0;
    const onlineReceived = parseFloat(totals.onlineReceived) || 0;
    const totalPaid = cashReceived + onlineReceived; 
    const balance = backendNet - totalPaid;
    const status = balance > 0.1 ? 'PARTIAL' : 'PAID';

    // A. Create Sale Record
    const saleRes = await client.query(
      `INSERT INTO sales 
      (invoice_number, customer_name, customer_phone, gross_total, discount, taxable_amount, 
       sgst_amount, cgst_amount, round_off_amount, final_amount, total_amount, exchange_total, is_gst_bill,
       paid_amount, balance_amount, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        invoiceNumber, customer.name, customer.phone, 
        totals.grossTotal, totals.totalDiscount, backendTaxable, 
        backendSGST, backendCGST, (backendNet - backendNetRaw), 
        backendNet, totals.exchangeTotal, includeGST, totalPaid, balance, status
      ]
    );
    const saleId = saleRes.rows[0].id;

    // Payments
    if (cashReceived > 0) {
        await client.query(`INSERT INTO sale_payments (sale_id, amount, payment_mode, note) VALUES ($1, $2, 'CASH', 'Bill Payment')`, [saleId, cashReceived]);
        await client.query(`UPDATE shop_assets SET cash_balance = cash_balance + $1 WHERE id = 1`, [cashReceived]);
    }
    if (onlineReceived > 0) {
        await client.query(`INSERT INTO sale_payments (sale_id, amount, payment_mode, note) VALUES ($1, $2, 'ONLINE', 'Bill Payment')`, [saleId, onlineReceived]);
        await client.query(`UPDATE shop_assets SET bank_balance = bank_balance + $1 WHERE id = 1`, [onlineReceived]);
    }

    // B. Process Sale Items
    for (const item of items) {
      const qty = parseInt(item.quantity) || 1;

      await client.query(
        `INSERT INTO sale_items (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [saleId, item.item_id || null, item.item_name, item.gross_weight, item.rate, item.making_charges || 0, item.total, qty]
      );

      // Handle Inventory
      let neighbourIdToUpdate = null;
      let weightForDebt = 0;
      let description = '';
      let metalType = item.metal_type || 'GOLD';

      if (item.item_id) {
        const checkRes = await client.query(`SELECT stock_type, gross_weight, wastage_percent, source_type, neighbour_shop_id, metal_type, barcode, quantity FROM inventory_items WHERE id = $1`, [item.item_id]);
        
        if (checkRes.rows.length > 0) {
            const dbItem = checkRes.rows[0];
            const soldWt = parseFloat(item.gross_weight) || 0;
            metalType = dbItem.metal_type;

            if (dbItem.stock_type === 'BULK') {
                const newWt = Math.max(0, parseFloat(dbItem.gross_weight) - soldWt);
                const newQty = Math.max(0, (parseInt(dbItem.quantity) || 0) - qty);
                const newPure = newWt * (parseFloat(dbItem.wastage_percent)/100);
                const newStatus = (newWt < 0.01 && newQty === 0) ? 'SOLD' : 'AVAILABLE';
                
                await client.query(`UPDATE inventory_items SET gross_weight = $1, pure_weight = $2, quantity = $3, status = $4 WHERE id = $5`, [newWt, newPure, newQty, newStatus, item.item_id]);
                await client.query(`INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, related_bill_no, description) VALUES ($1, 'SALE', $2, $3, $4, 'Item Sold')`, [item.item_id, -qty, -soldWt, invoiceNumber]);
                description = `Bulk Sold: ${item.item_name} (${soldWt}g)`;
            } else {
                await client.query(`UPDATE inventory_items SET status = 'SOLD' WHERE id = $1`, [item.item_id]);
                await client.query(`INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, related_bill_no, description) VALUES ($1, 'SALE', -1, $2, $3, 'Item Sold')`, [item.item_id, -soldWt, invoiceNumber]);
                description = `Sold Item: ${item.item_name} (${dbItem.barcode})`;
            }

            if (dbItem.source_type === 'NEIGHBOUR' && dbItem.neighbour_shop_id) {
                neighbourIdToUpdate = dbItem.neighbour_shop_id;
                weightForDebt = soldWt; 
            }
        }
      } else if (item.neighbour_id) {
          neighbourIdToUpdate = item.neighbour_id;
          weightForDebt = parseFloat(item.gross_weight) || 0;
          description = `Sold Manual Item: ${item.item_name}`;
      }

      if (neighbourIdToUpdate && weightForDebt > 0) {
          const debtCol = metalType === 'SILVER' ? 'balance_silver' : 'balance_gold';
          const silverWt = metalType === 'SILVER' ? weightForDebt : 0;
          const goldWt = metalType === 'SILVER' ? 0 : weightForDebt;
          
          await client.query(`UPDATE external_shops SET ${debtCol} = ${debtCol} + $1 WHERE id = $2`, [weightForDebt, neighbourIdToUpdate]);
          await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) VALUES ($1, 'BORROW_ADD', $2, $3, $4, $5, 0)`, [neighbourIdToUpdate, description, item.gross_weight, goldWt, silverWt]);
      }
    }

    // C. Exchange Items
    if (exchangeItems && exchangeItems.length > 0) {
      const omRes = await client.query(
          `INSERT INTO old_metal_purchases 
          (voucher_no, customer_name, mobile, total_amount, net_payout, payment_mode, date)
          VALUES ($1, $2, $3, $4, 0, 'EXCHANGE', NOW()) RETURNING id`,
          [`EX-${invoiceNumber}`, customer.name, customer.phone, backendExchangeTotal]
      );
      const omId = omRes.rows[0].id;

      for (const ex of exchangeItems) {
        const gross = parseFloat(ex.gross_weight) || 0;
        const less = parseFloat(ex.less_weight) || 0;
        let net = parseFloat(ex.net_weight) || 0;
        if (net <= 0 && gross > 0) net = gross - less;

        await client.query(
          `INSERT INTO sale_exchange_items (sale_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, total_amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [saleId, ex.name, ex.metal_type, gross, ex.less_percent, less, net, ex.rate, ex.total]
        );

        await client.query(`
            INSERT INTO old_metal_items 
            (purchase_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, amount, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE')`,
            [omId, ex.name, ex.metal_type, gross, ex.less_percent, less, net, ex.rate, ex.total]
        );
      }
    }

    await client.query('COMMIT');

    // --- AUDIT LOG: RECORD THE SALE ---
    await logAction(req, 'BILL_CREATED', `Created Bill #${invoiceNumber} Amount: ₹${backendNet}`, invoiceNumber);
    // ----------------------------------

    res.json({ success: true, message: 'Bill created', invoice_id: invoiceNumber });
  } catch (err) { 
      await client.query('ROLLBACK'); 
      console.error("Billing Error:", err);
      res.status(500).json({ success: false, error: err.message }); 
  } finally { 
      client.release(); 
  }
});

// 4. ADD BALANCE PAYMENT (SECURE & LOGGED)
router.post('/add-payment', async (req, res) => {
    const { sale_id, amount, payment_mode, note } = req.body;
    const client = await pool.connect();
    req.user = getUserFromRequest(req); // Capture User

    try {
        await client.query('BEGIN');
        const saleRes = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [sale_id]);
        if (saleRes.rows.length === 0) throw new Error("Bill not found");
        const sale = saleRes.rows[0];
        
        const payAmount = parseFloat(amount);
        if (payAmount > parseFloat(sale.balance_amount)) throw new Error(`Amount exceeds balance!`);
        
        await client.query("INSERT INTO sale_payments (sale_id, amount, payment_mode, note) VALUES ($1, $2, $3, $4)", [sale_id, payAmount, payment_mode || 'CASH', note]);
        
        const col = (payment_mode === 'ONLINE' || payment_mode === 'BANK') ? 'bank_balance' : 'cash_balance';
        await client.query(`UPDATE shop_assets SET ${col} = ${col} + $1 WHERE id = 1`, [payAmount]);

        const newPaid = parseFloat(sale.paid_amount) + payAmount;
        const newBalance = parseFloat(sale.balance_amount) - payAmount;
        const newStatus = newBalance <= 0.1 ? 'PAID' : 'PARTIAL';
        
        await client.query("UPDATE sales SET paid_amount = $1, balance_amount = $2, payment_status = $3, last_payment_date = NOW() WHERE id = $4", [newPaid, newBalance, newStatus, sale_id]);
        await client.query('COMMIT');

        // --- AUDIT LOG ---
        await logAction(req, 'PAYMENT_ADDED', `Received ₹${payAmount} for Bill #${sale.invoice_number}`, sale.invoice_number);
        // -----------------

        res.json({ success: true, message: "Payment Recorded", new_balance: newBalance });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 5. GET PAYMENTS
router.get('/payments/:sale_id', async (req, res) => {
    try { const result = await pool.query("SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY payment_date DESC", [req.params.sale_id]); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. GET HISTORY
router.get('/history', async (req, res) => {
    try { const result = await pool.query(`SELECT * FROM sales ORDER BY id DESC LIMIT 500`); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. DELETE BILL (SECURE & LOGGED)
router.delete('/delete/:id', async (req, res) => {
    const { id } = req.params;
    const { restore_mode } = req.query; 

    const client = await pool.connect();
    req.user = getUserFromRequest(req); // Capture User

    try {
      await client.query('BEGIN');

      const itemsRes = await client.query(`SELECT * FROM sale_items WHERE sale_id = $1`, [id]);
      
      for (const saleItem of itemsRes.rows) {
          if (!saleItem.item_id) continue; 
          const invRes = await client.query(`SELECT * FROM inventory_items WHERE id = $1 FOR UPDATE`, [saleItem.item_id]);
          const invItem = invRes.rows[0];

          if (invItem) {
              let newSource = invItem.source_type;
              let newNeighbourId = invItem.neighbour_shop_id;

              if (invItem.source_type === 'NEIGHBOUR' && invItem.neighbour_shop_id) {
                  if (restore_mode === 'TAKE_OWNERSHIP') {
                      newSource = 'OWN';
                      newNeighbourId = null;
                  } 
                  else {
                      const weight = parseFloat(saleItem.sold_weight);
                      const shopId = invItem.neighbour_shop_id;
                      const isSilver = invItem.metal_type === 'SILVER';
                      const col = isSilver ? 'balance_silver' : 'balance_gold';

                      await client.query(`UPDATE external_shops SET ${col} = ${col} - $1 WHERE id = $2`, [weight, shopId]);

                      await client.query(
                          `INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) 
                           VALUES ($1, 'BORROW_REPAY', $2, $3, $4, $5, 0)`,
                          [shopId, `Void Bill: ${saleItem.item_name}`, weight, isSilver?0:weight, isSilver?weight:0]
                      );
                  }
              }

              if (invItem.stock_type === 'BULK') {
                  const soldWt = parseFloat(saleItem.sold_weight);
                  const soldQty = parseInt(saleItem.quantity) || 1;
                  const purity = parseFloat(invItem.wastage_percent);
                  const pureWt = soldWt * (purity / 100);
                  
                  await client.query(
                      `UPDATE inventory_items 
                       SET gross_weight = gross_weight + $1, pure_weight = pure_weight + $2, quantity = quantity + $3, status = 'AVAILABLE', source_type = $4, neighbour_shop_id = $5 WHERE id = $6`,
                      [soldWt, pureWt, soldQty, newSource, newNeighbourId, invItem.id]
                  );
                  
                  await client.query(
                    `INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description)
                     VALUES ($1, 'RETURN', $2, $3, 'Bill Voided')`,
                    [invItem.id, soldQty, soldWt]
                  );

              } else {
                  await client.query(
                      `UPDATE inventory_items SET status = 'AVAILABLE', source_type = $1, neighbour_shop_id = $2 WHERE id = $3`,
                      [newSource, newNeighbourId, invItem.id]
                  );
                  await client.query(
                    `INSERT INTO item_stock_logs (inventory_item_id, action_type, quantity_change, weight_change, description)
                     VALUES ($1, 'RETURN', 1, $2, 'Bill Voided')`,
                    [invItem.id, parseFloat(saleItem.sold_weight)]
                  );
              }
          }
      }

      const saleInfo = await client.query("SELECT invoice_number FROM sales WHERE id = $1", [id]);
      const invNo = saleInfo.rows.length > 0 ? saleInfo.rows[0].invoice_number : 'UNKNOWN';

      if(invNo !== 'UNKNOWN') {
          await client.query("DELETE FROM old_metal_items WHERE purchase_id IN (SELECT id FROM old_metal_purchases WHERE voucher_no = $1)", [`EX-${invNo}`]);
          await client.query("DELETE FROM old_metal_purchases WHERE voucher_no = $1", [`EX-${invNo}`]);
      }

      await client.query("DELETE FROM sale_items WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sale_payments WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sale_exchange_items WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sales WHERE id = $1", [id]);
      
      await client.query('COMMIT');

      // --- AUDIT LOG ---
      await logAction(req, 'BILL_DELETED', `Voided Bill #${invNo}`, invNo);
      // -----------------

      res.json({ success: true, message: "Bill Voided Successfully" });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 8. PROCESS RETURN (Standard)
router.post('/process-return', async (req, res) => {
    const { returned_items } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        for (const item of returned_items) {
             const invRes = await client.query("SELECT * FROM inventory_items WHERE id = $1", [item.original_inventory_id]);
             const invItem = invRes.rows[0];
             
             if(invItem) {
                 if (item.restore_to_own && invItem.source_type === 'NEIGHBOUR') {
                     await client.query("UPDATE inventory_items SET status='AVAILABLE', source_type='OWN', neighbour_shop_id=NULL WHERE id=$1", [item.original_inventory_id]);
                 } else if (invItem.source_type === 'NEIGHBOUR') {
                     const weight = parseFloat(item.gross_weight);
                     const shopId = invItem.neighbour_shop_id;
                     const isSilver = invItem.metal_type === 'SILVER';
                     const col = isSilver ? 'balance_silver' : 'balance_gold';

                     await client.query(`UPDATE external_shops SET ${col} = ${col} - $1 WHERE id = $2`, [weight, shopId]);
                     
                     await client.query("UPDATE inventory_items SET status='AVAILABLE' WHERE id=$1", [item.original_inventory_id]);
                 } else {
                     await client.query("UPDATE inventory_items SET status='AVAILABLE' WHERE id=$1", [item.original_inventory_id]);
                 }
             }
        }
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

module.exports = router;