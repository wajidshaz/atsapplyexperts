// =====================================================================
//  In-app notification helper. Writes a row to the notifications table
//  that the bell UI polls via GET /api/notifications. sent_at stays NULL
//  until the user marks it read.
// =====================================================================
import { query } from '../config/db.js';

export async function createNotification(userId, kind, payload = {}) {
  if (!userId) return;
  try {
    await query(
      `INSERT INTO notifications (user_id, kind, payload) VALUES ($1,$2,$3)`,
      [userId, kind, JSON.stringify(payload)],
    );
  } catch (e) {
    // Never let a notification failure break the primary action.
    console.error('[notifications] failed to create:', e.message);
  }
}
