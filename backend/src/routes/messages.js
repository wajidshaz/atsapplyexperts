import { Router } from 'express';
import { query } from '../config/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createNotification } from '../lib/notifications.js';
import { validateBody, z } from '../middleware/validate.js';
const r = Router();

r.use(requireAuth);

// Only the thread's client or an admin may read/post in it.
function canAccessThread(req, res, next) {
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'candidate' && req.user.id === req.params.clientId) return next();
  return res.status(403).json({ error: 'Forbidden: not your thread' });
}

// Admin: list all client threads with the latest message + unread count.
// GET /api/messages/threads
r.get('/threads', requireRole('admin'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id AS client_id, u.full_name,
              (SELECT body FROM messages m WHERE m.client_id=u.id ORDER BY created_at DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM messages m WHERE m.client_id=u.id ORDER BY created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*) FROM messages m WHERE m.client_id=u.id AND m.sender_role='candidate' AND m.read_at IS NULL) AS unread
         FROM users u
        WHERE u.role='candidate'
        ORDER BY last_at DESC NULLS LAST`);
    res.json(rows);
  } catch (e) { next(e); }
});

// Get all messages in one client's thread (works for both the client and admin).
// GET /api/messages/thread/:clientId
r.get('/thread/:clientId', canAccessThread, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, sender_id, sender_role, body, read_at, edited_at, created_at
         FROM messages WHERE client_id=$1 ORDER BY created_at`,
      [req.params.clientId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Send a message into a client's thread. Sender identity comes from the token.
// POST /api/messages/thread/:clientId  { body }
const sendSchema = z.object({ body: z.string().trim().min(1).max(5000) });
r.post('/thread/:clientId', canAccessThread, validateBody(sendSchema), async (req, res, next) => {
  try {
    const { body } = req.body;
    const senderRole = req.user.role === 'admin' ? 'admin' : 'candidate';
    const { rows } = await query(
      `INSERT INTO messages (client_id, sender_id, sender_role, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.clientId, req.user.id, senderRole, body]);

    // Notify the other party with a useful preview + who it's from, so the bell
    // shows "Sara: Can you update my…" and can deep-link to the thread.
    const preview = body.length > 90 ? body.slice(0, 90) + '…' : body;
    const { rows: [sender] } = await query(`SELECT full_name FROM users WHERE id=$1`, [req.user.id]);
    if (senderRole === 'candidate') {
      const fromName = sender?.full_name || 'Client';
      const { rows: admins } = await query(`SELECT id FROM users WHERE role='admin'`);
      for (const a of admins) await createNotification(a.id, 'new_message', { client_id: req.params.clientId, from_name: fromName, preview });
    } else {
      await createNotification(req.params.clientId, 'new_message', { client_id: req.params.clientId, from: 'admin', from_name: sender?.full_name || 'Your manager', preview });
    }
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Mark the OTHER party's messages as read when you open the thread.
// PATCH /api/messages/thread/:clientId/read
r.patch('/thread/:clientId/read', canAccessThread, async (req, res, next) => {
  try {
    const readerRole = req.user.role === 'admin' ? 'admin' : 'candidate';
    const other = readerRole === 'admin' ? 'candidate' : 'admin';
    await query(
      `UPDATE messages SET read_at=now()
        WHERE client_id=$1 AND sender_role=$2 AND read_at IS NULL`,
      [req.params.clientId, other]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Edit a message. Only the original sender may change their own words.
// PATCH /api/messages/message/:messageId  { body }
r.patch('/message/:messageId', validateBody(sendSchema), async (req, res, next) => {
  try {
    const { rows: [msg] } = await query(`SELECT * FROM messages WHERE id=$1`, [req.params.messageId]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages' });
    const { rows } = await query(
      `UPDATE messages SET body=$1, edited_at=now() WHERE id=$2
         RETURNING id, sender_id, sender_role, body, read_at, edited_at, created_at`,
      [req.body.body, req.params.messageId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Delete a message. Admin-only — candidates cannot delete messages.
// DELETE /api/messages/message/:messageId
r.delete('/message/:messageId', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows: [msg] } = await query(`SELECT id FROM messages WHERE id=$1`, [req.params.messageId]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    await query(`DELETE FROM messages WHERE id=$1`, [req.params.messageId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
