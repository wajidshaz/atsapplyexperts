// Google Sheets integration — one sheet per approved batch.
// Uses a service account / OAuth token; employees update Status in the sheet.
import { google } from 'googleapis';

function client() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Create a sheet for a batch and fill approved jobs. Returns the sheet URL.
export async function createBatchSheet(candidateName, rows) {
  const sheets = client();
  const { data } = await sheets.spreadsheets.create({
    requestBody: { properties: { title: `JobPilot — ${candidateName} — ${new Date().toISOString().slice(0, 10)}` } },
  });
  const id = data.spreadsheetId;
  const values = [
    ['Job title', 'Company', 'Apply link', 'Status'],
    ...rows.map((r) => [r.title, r.company, r.apply_link, 'To do']),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: 'A1',
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  return `https://docs.google.com/spreadsheets/d/${id}`;
}

// Read status updates the employee made in the sheet (sync back to DB).
export async function readSheetStatuses(spreadsheetId) {
  const sheets = client();
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A2:D' });
  return (data.values || []).map(([title, company, link, status]) => ({ title, company, link, status }));
}
