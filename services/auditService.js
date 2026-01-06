const pool = require('../config/db');

const logAction = async (req, actionType, description, entityId = null) => {
    try {
        // Safe defaults if user is not logged in (e.g. during login failures)
        const userId = req.user ? req.user.id : null;
        const username = req.user ? req.user.username : 'SYSTEM/GUEST';
        
        // Capture IP address safely
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';

        await pool.query(
            `INSERT INTO system_audit_logs (user_id, username, action_type, description, ip_address, entity_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, username, actionType, description, ip, entityId]
        );
        
        console.log(`📝 AUDIT: [${actionType}] ${description}`);
    } catch (err) {
        // Audit logging should essentially never crash the main app, so we catch & log error
        console.error("❌ AUDIT LOG FAILED:", err.message);
    }
};

module.exports = { logAction };