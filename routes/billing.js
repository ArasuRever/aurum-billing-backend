const express = require('express');
const router = express.Router();
const pool = require('../config/db');

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
        const sale = await pool.query(query, params);
        if(sale.rows.length === 0) return res.status(404).json({error: "Invoice not found"});
        const items = await pool.query("SELECT * FROM sale_items WHERE sale_id = $1", [sale.rows[0].id]);
        res.json({ sale: sale.rows[0], items: items.rows });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// 2. SEARCH ITEMS
router.get('/search-item', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_items WHERE (barcode = $1 OR item_name ILIKE $2) AND status = 'AVAILABLE'`,
      [q, `%${q}%`]
    );
    const items = result.rows.map(item => ({
      ...item,
      item_image: item.item_image ? `data:image/jpeg;base64,${item.item_image.toString('base64')}` : null
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. CREATE BILL
router.post('/create-bill', async (req, res) => {
  const { customer, items, exchangeItems, totals, includeGST } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = `INV-${Date.now()}`;

    const cashReceived = parseFloat(totals.cashReceived) || 0;
    const onlineReceived = parseFloat(totals.onlineReceived) || 0;
    const totalPaid = parseFloat(totals.paidAmount) || 0;
    const balance = parseFloat(totals.balance) || 0;
    const status = balance > 0 ? 'PARTIAL' : 'PAID';

    // A. Create Sale Record
    const saleRes = await client.query(
      `INSERT INTO sales 
      (invoice_number, customer_name, customer_phone, gross_total, discount, taxable_amount, 
       sgst_amount, cgst_amount, round_off_amount, final_amount, total_amount, exchange_total, is_gst_bill,
       paid_amount, balance_amount, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        invoiceNumber, customer.name, customer.phone, 
        totals.grossTotal || 0, totals.totalDiscount || 0, totals.taxableAmount || 0, 
        totals.sgst || 0, totals.cgst || 0, totals.roundOff || 0, 
        totals.netPayable, totals.exchangeTotal || 0, includeGST, totalPaid, balance, status
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
      // 1. Insert into sale_items
      await client.query(
        `INSERT INTO sale_items (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, item.item_id || null, item.item_name, item.gross_weight, item.rate, item.making_charges || 0, item.total]
      );

      // 2. Handle Inventory & Neighbor Debt
      let neighbourIdToUpdate = null;
      let weightForDebt = 0;
      let description = '';
      let metalType = item.metal_type || 'GOLD';

      if (item.item_id) {
        // Fetch current item state to check type
        const checkRes = await client.query(`SELECT stock_type, gross_weight, wastage_percent, source_type, neighbour_shop_id, metal_type, barcode FROM inventory_items WHERE id = $1`, [item.item_id]);
        
        if (checkRes.rows.length > 0) {
            const dbItem = checkRes.rows[0];
            const soldWt = parseFloat(item.gross_weight) || 0;
            metalType = dbItem.metal_type;

            if (dbItem.stock_type === 'BULK') {
                // BULK LOGIC: Reduce weight, don't mark sold unless empty
                const currentWt = parseFloat(dbItem.gross_weight);
                const newWt = currentWt - soldWt;
                const newPure = newWt * (parseFloat(dbItem.wastage_percent)/100);
                
                // If practically empty (< 0.01g), mark as SOLD, else just update weight
                const newStatus = newWt < 0.01 ? 'SOLD' : 'AVAILABLE';
                
                await client.query(
                    `UPDATE inventory_items 
                     SET gross_weight = $1, pure_weight = $2, status = $3 
                     WHERE id = $4`,
                    [newWt, newPure, newStatus, item.item_id]
                );
                
                description = `Bulk Sold: ${item.item_name} (${soldWt}g)`;
            } else {
                // SINGLE LOGIC: Mark SOLD
                await client.query(`UPDATE inventory_items SET status = 'SOLD' WHERE id = $1`, [item.item_id]);
                description = `Sold Item: ${item.item_name} (${dbItem.barcode})`;
            }

            // Neighbor Debt Logic
            if (dbItem.source_type === 'NEIGHBOUR' && dbItem.neighbour_shop_id) {
                neighbourIdToUpdate = dbItem.neighbour_shop_id;
                weightForDebt = soldWt; // For Bulk, debt increases by amount sold
            }
        }
      } else if (item.neighbour_id) {
          neighbourIdToUpdate = item.neighbour_id;
          weightForDebt = parseFloat(item.gross_weight) || 0;
          description = `Sold Manual Item: ${item.item_name}`;
      }

      if (neighbourIdToUpdate && weightForDebt > 0) {
          if (metalType === 'SILVER') {
              await client.query(`UPDATE external_shops SET balance_silver = balance_silver + $1 WHERE id = $2`, [weightForDebt, neighbourIdToUpdate]);
              await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) VALUES ($1, 'BORROW_ADD', $2, $3, 0, $4, 0)`, [neighbourIdToUpdate, description, item.gross_weight, weightForDebt]);
          } else {
              await client.query(`UPDATE external_shops SET balance_gold = balance_gold + $1 WHERE id = $2`, [weightForDebt, neighbourIdToUpdate]);
              await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) VALUES ($1, 'BORROW_ADD', $2, $3, $4, 0, 0)`, [neighbourIdToUpdate, description, item.gross_weight, weightForDebt]);
          }
      }
    }

    // C. Exchange Items (Auto Add to Inventory as OLD_METAL)
    if (exchangeItems && exchangeItems.length > 0) {
      for (const ex of exchangeItems) {
        await client.query(
          `INSERT INTO sale_exchange_items (sale_id, item_name, metal_type, gross_weight, less_percent, less_weight, net_weight, rate, total_amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [saleId, ex.name, ex.metal_type, ex.gross_weight, ex.less_percent, ex.less_weight, ex.net_weight, ex.rate, ex.total]
        );

        const barcode = `EX-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        const gross = parseFloat(ex.gross_weight) || 0;
        const net = parseFloat(ex.net_weight) || 0;
        
        await client.query(
           `INSERT INTO inventory_items 
           (source_type, metal_type, item_name, barcode, gross_weight, wastage_percent, pure_weight, status, stock_type)
           VALUES ($1, $2, $3, $4, $5, 0, $6, 'AVAILABLE', 'OLD_METAL')`,
           ['EXCHANGE', ex.metal_type, ex.name, barcode, gross, net]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Bill created', invoice_id: invoiceNumber });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ success: false, error: err.message }); } finally { client.release(); }
});

// 4. ADD BALANCE PAYMENT
router.post('/add-payment', async (req, res) => {
    const { sale_id, amount, payment_mode, note } = req.body;
    const client = await pool.connect();
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
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIAL';
        await client.query("UPDATE sales SET paid_amount = $1, balance_amount = $2, payment_status = $3, last_payment_date = NOW() WHERE id = $4", [newPaid, newBalance, newStatus, sale_id]);
        await client.query('COMMIT');
        res.json({ success: true, message: "Payment Recorded", new_balance: newBalance });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 5. GET PAYMENTS
router.get('/payments/:sale_id', async (req, res) => {
    try { const result = await pool.query("SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY payment_date DESC", [req.params.sale_id]); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. GET HISTORY
router.get('/history', async (req, res) => {
    try { const result = await pool.query(`SELECT * FROM sales ORDER BY id DESC`); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. DELETE BILL (MODIFIED: Handles Neighbour Restore Logic)
router.delete('/delete/:id', async (req, res) => {
    const { id } = req.params;
    // restore_mode: 'REVERT_DEBT' (default) or 'TAKE_OWNERSHIP'
    const { restore_mode } = req.query; 

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Fetch Items sold in this bill
      const itemsRes = await client.query(`SELECT * FROM sale_items WHERE sale_id = $1`, [id]);
      
      for (const saleItem of itemsRes.rows) {
          if (!saleItem.item_id) continue; 

          // Get current item details (even if sold)
          const invRes = await client.query(`SELECT * FROM inventory_items WHERE id = $1`, [saleItem.item_id]);
          const invItem = invRes.rows[0];

          if (invItem) {
              let newSource = invItem.source_type;
              let newNeighbourId = invItem.neighbour_shop_id;

              // --- LOGIC: HANDLE NEIGHBOUR ITEMS ---
              if (invItem.source_type === 'NEIGHBOUR' && invItem.neighbour_shop_id) {
                  
                  if (restore_mode === 'TAKE_OWNERSHIP') {
                      // Option A: Keep Debt, Make it OUR Item
                      // We change source to OWN, meaning we effectively 'bought' it.
                      // The debt created during sale remains valid.
                      newSource = 'OWN';
                      newNeighbourId = null;
                      
                      // Optional: Update the original 'BORROW_ADD' transaction description?
                      // For now, we leave it as is, as the debt is still valid.
                  } 
                  else {
                      // Option B (Default): Reverse Debt, Return to NEIGHBOUR Status
                      // We assume the sale never happened, so we shouldn't owe the neighbor.
                      
                      const weight = parseFloat(saleItem.sold_weight);
                      const shopId = invItem.neighbour_shop_id;
                      const isSilver = invItem.metal_type === 'SILVER';

                      // 1. Deduct from Shop Balance (Reversing the ADD)
                      if (isSilver) {
                          await client.query(`UPDATE external_shops SET balance_silver = balance_silver - $1 WHERE id = $2`, [weight, shopId]);
                      } else {
                          await client.query(`UPDATE external_shops SET balance_gold = balance_gold - $1 WHERE id = $2`, [weight, shopId]);
                      }

                      // 2. Add Reversal Transaction (So ledger matches balance)
                      await client.query(
                          `INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight, cash_amount) 
                           VALUES ($1, 'BORROW_REPAY', $2, $3, $4, $5, 0)`,
                          [
                              shopId, 
                              `Void Bill: ${saleItem.item_name} (Reversal)`, 
                              weight, 
                              isSilver ? 0 : weight, // Gold 
                              isSilver ? weight : 0  // Silver
                          ]
                      );
                  }
              }

              // --- RESTORE INVENTORY ---
              // Handle Bulk vs Single Logic
              if (invItem.stock_type === 'BULK') {
                  const soldWt = parseFloat(saleItem.sold_weight);
                  const purity = parseFloat(invItem.wastage_percent);
                  const pureWt = soldWt * (purity / 100);
                  
                  await client.query(
                      `UPDATE inventory_items 
                       SET gross_weight = gross_weight + $1, pure_weight = pure_weight + $2, status = 'AVAILABLE',
                           source_type = $3, neighbour_shop_id = $4
                       WHERE id = $5`,
                      [soldWt, pureWt, newSource, newNeighbourId, invItem.id]
                  );
              } else {
                  await client.query(
                      `UPDATE inventory_items 
                       SET status = 'AVAILABLE', source_type = $1, neighbour_shop_id = $2 
                       WHERE id = $3`,
                      [newSource, newNeighbourId, invItem.id]
                  );
              }
          }
      }

      // 2. Delete Bill Records
      await client.query("DELETE FROM sale_items WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sale_payments WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sale_exchange_items WHERE sale_id = $1", [id]);
      await client.query("DELETE FROM sales WHERE id = $1", [id]);
      
      await client.query('COMMIT');
      res.json({ success: true, message: "Bill Voided Successfully" });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// 8. PROCESS RETURN / EXCHANGE (MODIFIED: Handles Neighbour Restore Logic)
router.post('/process-return', async (req, res) => {
    const { sale_id, customer_id, returned_items, exchange_items } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. HANDLE RETURNS
        let totalRefund = 0;
        for (const item of returned_items) {
            totalRefund += parseFloat(item.refund_amount);

            // Fetch original info to check source
            const invRes = await client.query("SELECT * FROM inventory_items WHERE id = $1", [item.original_inventory_id]);
            const invItem = invRes.rows[0];

            if (invItem) {
                let newSource = invItem.source_type;
                let newNeighbourId = invItem.neighbour_shop_id;

                // CHECK: Did user choose to take ownership?
                if (invItem.source_type === 'NEIGHBOUR') {
                    if (item.restore_to_own === true) {
                        // A: Take Ownership (Debt Stays)
                        newSource = 'OWN';
                        newNeighbourId = null;
                    } else {
                        // B: Return to Neighbour (Reverse Debt) - Default behavior for returns usually
                        const weight = parseFloat(item.gross_weight); 
                        const shopId = invItem.neighbour_shop_id;
                        const isSilver = invItem.metal_type === 'SILVER';

                        // Deduct debt
                        if (isSilver) await client.query(`UPDATE external_shops SET balance_silver = balance_silver - $1 WHERE id = $2`, [weight, shopId]);
                        else await client.query(`UPDATE external_shops SET balance_gold = balance_gold - $1 WHERE id = $2`, [weight, shopId]);
                        
                        // Log Transaction
                        await client.query(
                           `INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight, silver_weight) 
                            VALUES ($1, 'BORROW_REPAY', $2, $3, $4, $5)`,
                           [shopId, `Return: ${invItem.item_name}`, weight, (isSilver?0:weight), (isSilver?weight:0)]
                        );
                    }
                }

                // Restore Item
                if (invItem.stock_type === 'BULK') {
                    // If returning bulk, we add weight back
                    const soldWt = parseFloat(item.gross_weight);
                    const purity = parseFloat(invItem.wastage_percent);
                    const pureWt = soldWt * (purity / 100);
                    
                     await client.query(
                        `UPDATE inventory_items 
                         SET gross_weight = gross_weight + $1, pure_weight = pure_weight + $2, status = 'AVAILABLE',
                             source_type = $3, neighbour_shop_id = $4
                         WHERE id = $5`, 
                        [soldWt, pureWt, newSource, newNeighbourId, item.original_inventory_id]
                    );

                } else {
                    await client.query(
                        `UPDATE inventory_items 
                         SET status = 'AVAILABLE', source_type = $1, neighbour_shop_id = $2
                         WHERE id = $3`, 
                        [newSource, newNeighbourId, item.original_inventory_id]
                    );
                }
            }
        }

        // 2. HANDLE EXCHANGE (Create New Sale for Exchange Items)
        let newInvoiceId = null;
        if (exchange_items.length > 0) {
            // Calculate Totals for new bill
            let grossTotal = 0;
            const newItems = [];
            
            for (const ex of exchange_items) {
                 grossTotal += parseFloat(ex.total_price);
                 newItems.push({
                     item_id: ex.id,
                     item_name: ex.item_name,
                     gross_weight: ex.gross_weight,
                     rate: ex.rate,
                     making_charges: ex.making_charges,
                     total: ex.total_price,
                     metal_type: ex.metal_type
                 });
            }

            const netPayable = grossTotal - totalRefund;
            const status = netPayable > 0 ? 'PENDING' : 'PAID'; 
            const newInvoiceNo = `EXC-${Date.now()}`;

            const saleRes = await client.query(
                `INSERT INTO sales 
                (invoice_number, customer_name, customer_phone, gross_total, discount, taxable_amount, final_amount, total_amount, exchange_total, payment_status, balance_amount)
                 VALUES ($1, (SELECT name FROM customers WHERE id=$2), (SELECT phone FROM customers WHERE id=$2), $3, 0, $3, $4, $4, $5, $6, $4) RETURNING id`,
                [newInvoiceNo, customer_id, grossTotal, netPayable, totalRefund, status]
            );
            const newSaleId = saleRes.rows[0].id;
            newInvoiceId = newInvoiceNo;

            // Process New Items
            for (const item of newItems) {
                await client.query(
                    `INSERT INTO sale_items (sale_id, item_id, item_name, sold_weight, sold_rate, making_charges_collected, total_item_price) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [newSaleId, item.item_id, item.item_name, item.gross_weight, item.rate, item.making_charges, item.total]
                );

                // Inventory Update & Neighbour Check (Standard Logic)
                let neighbourIdToUpdate = null;
                let weightForDebt = 0;
                let description = '';

                if (item.item_id && !String(item.item_id).startsWith('MANUAL')) {
                    const upRes = await client.query("UPDATE inventory_items SET status = 'SOLD' WHERE id = $1 RETURNING *", [item.item_id]);
                    const dbItem = upRes.rows[0];
                    if (dbItem && dbItem.source_type === 'NEIGHBOUR') {
                        neighbourIdToUpdate = dbItem.neighbour_shop_id;
                        weightForDebt = parseFloat(dbItem.gross_weight);
                        description = `Exchange Sold: ${item.item_name}`;
                    }
                } else if (item.neighbour_id) {
                     neighbourIdToUpdate = item.neighbour_id;
                     weightForDebt = parseFloat(item.gross_weight);
                     description = `Exchange Manual: ${item.item_name}`;
                }

                if (neighbourIdToUpdate && weightForDebt > 0) {
                     if (item.metal_type === 'SILVER') {
                         await client.query("UPDATE external_shops SET balance_silver = balance_silver + $1 WHERE id = $2", [weightForDebt, neighbourIdToUpdate]);
                         await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, silver_weight) VALUES ($1, 'BORROW_ADD', $2, $3, $3)`, [neighbourIdToUpdate, description, weightForDebt]);
                     } else {
                         await client.query("UPDATE external_shops SET balance_gold = balance_gold + $1 WHERE id = $2", [weightForDebt, neighbourIdToUpdate]);
                         await client.query(`INSERT INTO shop_transactions (shop_id, type, description, gross_weight, pure_weight) VALUES ($1, 'BORROW_ADD', $2, $3, $3)`, [neighbourIdToUpdate, description, weightForDebt]);
                     }
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, new_invoice: newInvoiceId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;