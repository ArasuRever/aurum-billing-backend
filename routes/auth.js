const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { logAction } = require('../services/auditService'); // Import Audit Service

// Ensure Secret Exists
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error("FATAL: JWT_SECRET missing.");
    process.exit(1);
}

// --- MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    const token = req.header('Authorization')?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access Denied" });
    try {
        const verified = jwt.verify(token, JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
};

const verifyAdmin = (req, res, next) => {
    verifyToken(req, res, () => {
        if (req.user.role === 'admin' || req.user.role === 'superadmin') next();
        else res.status(403).json({ error: "Access Denied: Admins Only" });
    });
};

// --- ROUTES ---

router.get('/login-config', async (req, res) => {
    try {
        const userCheck = await pool.query('SELECT COUNT(*) FROM users');
        const bizCheck = await pool.query('SELECT business_name, logo FROM business_settings LIMIT 1');
        const bizData = bizCheck.rows[0] || { business_name: 'AURUM BILLING', logo: null };
        res.json({ setupRequired: parseInt(userCheck.rows[0].count) === 0, business: bizData });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            // Log Failed Attempt
            await logAction(req, 'LOGIN_FAILED', `Failed login attempt for user: ${username}`);
            return res.status(400).json({ error: "Invalid Credentials" });
        }

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            await logAction(req, 'LOGIN_FAILED', `Wrong password for user: ${username}`);
            return res.status(400).json({ error: "Invalid Credentials" });
        }

        const payload = { id: user.id, username: user.username, role: user.role, permissions: user.permissions || [] };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });

        // Log Success
        req.user = payload; // Manually set for logger
        await logAction(req, 'LOGIN_SUCCESS', `User logged in successfully`);
        
        res.json({ token, user: payload });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

router.post('/setup', async (req, res) => {
    const { username, password } = req.body;
    try {
        const check = await pool.query('SELECT * FROM users');
        if(check.rows.length > 0) return res.status(403).json({ error: "Admin already exists." });

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        await pool.query('INSERT INTO users (username, password, role, permissions) VALUES ($1, $2, $3, $4)', 
            [username, hash, 'superadmin', []]);
            
        await logAction(req, 'SYSTEM_SETUP', `Super Admin Created: ${username}`);
        res.json({ success: true, message: "Super Admin Created" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PROTECTED ROUTES ---

router.get('/users', verifyAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role, permissions, created_at FROM users ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users/add', verifyAdmin, async (req, res) => {
    const { username, password, role, permissions } = req.body;
    try {
        const check = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (check.rows.length > 0) return res.status(400).json({ error: "Username already exists" });

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        await pool.query(
            'INSERT INTO users (username, password, role, permissions) VALUES ($1, $2, $3, $4)',
            [username, hash, role || 'staff', permissions || []]
        );
        
        await logAction(req, 'USER_CREATE', `Created new user: ${username} (${role})`);
        res.json({ success: true, message: "User Created Successfully" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/users/:id', verifyAdmin, async (req, res) => {
    try {
        if (req.user.id == req.params.id) return res.status(400).json({ error: "Cannot delete your own account" });
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        
        await logAction(req, 'USER_DELETE', `Deleted user ID: ${req.params.id}`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id', verifyAdmin, async (req, res) => {
    const { password, role, permissions } = req.body;
    const { id } = req.params;
    try {
        if (password) {
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(password, salt);
            await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, id]);
        }
        if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
        if (permissions) await pool.query('UPDATE users SET permissions = $1 WHERE id = $2', [permissions, id]);
        
        await logAction(req, 'USER_UPDATE', `Updated user ID: ${id}`);
        res.json({ success: true, message: "User Updated" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;