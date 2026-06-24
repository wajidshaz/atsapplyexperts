import { Router } from 'express';
import { query } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';

const r = Router();

// All notifications for the current user (unread first, newest first).
// GET /api/notifications
r.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, kind, payload, sent_at, created_at
         FROM notifications
        WHERE user_id=$1
        ORDER BY (sent_at IS NULL) DESC, created_at DESC
        LIMIT 50`,
      [req.user.id]);
    const unread = rows.filter(n => !n.sent_at).length;
    res.json({ notifications: rows, unread });
  } catch (e) { next(e); }
});

// Mark the current user's notifications as read (sets sent_at as "seen at").
// PATCH /api/notifications/read
r.patch('/read', requireAuth, async (req, res, next) => {
  try {
    await query(
      `UPDATE notifications SET sent_at=now() WHERE user_id=$1 AND sent_at IS NULL`,
      [req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
