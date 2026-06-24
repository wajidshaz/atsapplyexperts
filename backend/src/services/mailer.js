// Email via the Gmail REST API using native fetch.
// We deliberately avoid the googleapis/gaxios client here because its bundled
// node-fetch throws ERR_STREAM_PREMATURE_CLOSE on some Node builds. No SMTP
// passwords are ever stored — only an OAuth refresh token for the sender.

const SENDER = process.env.GMAIL_SENDER || 'atsapplyexperts@gmail.com';
const FROM   = `ATS Apply Experts <${SENDER}>`;

// Exchange the long-lived refresh token for a short-lived access token.
async function getAccessToken() {
  if (!process.env.GMAIL_REFRESH_TOKEN) throw new Error('GMAIL_REFRESH_TOKEN is not set');
  const form = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

function encode(to, subject, html) {
  const msg = [
    `From: ${FROM}`,
    `To: ${to}`,
    'Content-Type: text/html; charset=utf-8',
    `Subject: ${subject}`,
    '',
    html,
  ].join('\n');
  return Buffer.from(msg).toString('base64url');
}

export async function sendEmail(to, subject, html) {
  const accessToken = await getAccessToken();
  const raw = encode(to, subject, html);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gmail send failed ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Templated triggers used across the app
export const notify = {
  jobsReady: (to, count) =>
    sendEmail(to, 'Your job matches are ready', `<p>${count} new roles were matched this morning. Open ATS Apply Experts to review.</p>`),
  batchReady: (to, n) =>
    sendEmail(to, `Batch ${n} is ready to approve`, `<p>Your approval window is open. Approve before 9:00 AM.</p>`),
  statusUpdate: (to, role, status) =>
    sendEmail(to, 'Application status updated', `<p>${role} is now: <b>${status}</b>.</p>`),
  // Client invite — secure link, they sign in with Google (no password).
  invite: (to, name) =>
    sendEmail(to, "You're invited to ATS Apply Experts",
      `<p>Hi ${name || 'there'},</p>
       <p>You've been invited to ATS Apply Experts. Click below to set up your account — you'll sign in with Google, so there's no password to create.</p>
       <p><a href="${process.env.APP_URL || 'https://app.atsapplyexperts.com'}/invite?email=${encodeURIComponent(to)}">Accept your invite</a></p>`),
  // Sent ONCE, when a candidate first signs in and their account activates.
  welcome: (to, name) => {
    const app = process.env.APP_URL || 'https://app.atsapplyexperts.com';
    const first = (name || '').trim().split(/\s+/)[0] || 'there';
    return sendEmail(to, 'Welcome to ATS Apply Experts 🎉',
      `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto">
         <h2 style="color:#6c5ce7;margin:0 0 4px">Welcome aboard, ${first}! 🎉</h2>
         <p style="font-size:15px;line-height:1.5">Your account is active. From here on, we do the heavy lifting of your job search — here's how it works:</p>
         <ol style="font-size:14px;line-height:1.7;padding-left:18px">
           <li><b>We find & match jobs.</b> Every day we scrape fresh roles and our AI scores each one against your resume.</li>
           <li><b>You approve a batch.</b> You'll get a short daily list of the best matches — approve the ones you like in one click.</li>
           <li><b>We apply for you.</b> Our team submits your applications and tracks every response.</li>
         </ol>
         <p style="font-size:14px;line-height:1.5"><b>One quick step:</b> open your dashboard, complete your profile and confirm your job interests so your matches are spot-on.</p>
         <p style="margin:22px 0">
           <a href="${app}" style="background:#6c5ce7;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">Open your dashboard</a>
         </p>
         <p style="font-size:13px;color:#888">Questions? Just reply to this email and our team will help.<br>— The ATS Apply Experts team</p>
       </div>`);
  },
};
