const { query } = require('../src/config/database');

exports.up = async () => {
    // Create notifications table
    await query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            recipient_type VARCHAR(10) NOT NULL CHECK (recipient_type IN ('client', 'admin', 'b2b')),
            recipient_id UUID NOT NULL,
            type VARCHAR(100) NOT NULL,
            title VARCHAR(255) NOT NULL,
            body TEXT,
            data JSONB,
            path VARCHAR(255),
            read BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('  ✓ notifications table created');

    // Index for fast lookup per user
    await query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient
        ON notifications (recipient_type, recipient_id)
    `);
    console.log('  ✓ idx_notifications_recipient created');

    // Index for unread notifications
    await query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON notifications (recipient_id, read)
    `);
    console.log('  ✓ idx_notifications_unread created');

    // Index for ordering (latest first)
    await query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_created_at
        ON notifications (created_at DESC)
    `);
    console.log('  ✓ idx_notifications_created_at created');
};

exports.down = async () => {
    await query('DROP TABLE IF EXISTS notifications');
};