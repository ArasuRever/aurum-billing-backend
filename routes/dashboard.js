const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET FULL DASHBOARD DATA
router.get('/', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];

        // 1. RATES
        const ratesRes = await pool.query("SELECT * FROM daily_rates");
        const rates = {};
        ratesRes.rows.forEach(r => rates[r.metal_type] = r.rate);

        // 2. INVENTORY HEALTH
        // Total Weights
        const stockRes = await pool.query(`
            SELECT metal_type, SUM(gross_weight) as gross, SUM(pure_weight) as pure, COUNT(id) as count 
            FROM inventory_items WHERE status = 'AVAILABLE' GROUP BY metal_type
        `);
        // Low Stock (Example: Items with < 2 qty if bulk, or count if single)
        const lowStockRes = await pool.query(`
            SELECT item_name, quantity FROM inventory_items 
            WHERE status='AVAILABLE' AND quantity < 2 LIMIT 5
        `);
        // Stagnant Stock (> 180 Days)
        const stagnantRes = await pool.query(`
            SELECT COUNT(*) as count, SUM(gross_weight) as weight 
            FROM inventory_items 
            WHERE status='AVAILABLE' AND created_at < NOW() - INTERVAL '180 days'
        `);

        // 3. SALES PULSE
        // Today's Stats
        const salesToday = await pool.query(`
            SELECT COUNT(*) as bills, COALESCE(SUM(final_amount),0) as total 
            FROM sales WHERE DATE(created_at) = $1
        `, [today]);
        
        // Category Pie (Top Selling Items)
        const categoryRes = await pool.query(`
            SELECT item_name, COUNT(*) as sold_count 
            FROM sale_items 
            GROUP BY item_name 
            ORDER BY sold_count DESC LIMIT 5
        `);

        // Hourly Heatmap (Bills per hour today)
        const hourlyRes = await pool.query(`
            SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count 
            FROM sales 
            WHERE DATE(created_at) = $1 
            GROUP BY hour ORDER BY hour
        `, [today]);

        // 4. ACTIVITY STREAM (Audit Logs - assuming you have an audit table or using transactions)
        // For now, we mock this with recent sales/expenses if no specific audit table exists
        const activityRes = await pool.query(`
            SELECT 'SALE' as type, CONCAT('Bill #', invoice_number, ' - ', customer_name) as desc, created_at 
            FROM sales ORDER BY created_at DESC LIMIT 5
        `);

        res.json({
            rates,
            inventory: {
                summary: stockRes.rows,
                low_stock: lowStockRes.rows,
                stagnant: stagnantRes.rows[0]
            },
            sales: {
                today_bills: salesToday.rows[0].bills,
                today_revenue: salesToday.rows[0].total,
                categories: categoryRes.rows,
                heatmap: hourlyRes.rows
            },
            activity: activityRes.rows
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;