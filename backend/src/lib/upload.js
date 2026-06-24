// =====================================================================
//  File upload (multer → disk) + server-side resume text extraction.
//  Files are written under UPLOAD_DIR with random names; access is always
//  gated through the API (signed grant), never by exposing the path.
// =====================================================================
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';   // v2 class-based API
import mammoth from 'mammoth';

// On Vercel (serverless) the only writable path is /tmp; elsewhere use ./uploads.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || (process.env.VERCEL ? '/tmp/uploads' : './uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
catch (e) { console.warn('[upload] could not create UPLOAD_DIR:', e.message); }

const ALLOWED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'text/plain',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

export const uploadResume = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type (PDF, DOC/DOCX, or TXT only)'));
  },
});

// Extract plain text from an uploaded resume for AI analysis.
export async function extractText(filePath, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
      const result = await parser.getText();
      return result.text || '';
    }
    if (mimetype.includes('wordprocessingml') || mimetype === 'application/msword') {
      const { value } = await mammoth.extractRawText({ path: filePath });
      return value || '';
    }
    if (mimetype === 'text/plain') {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (e) {
    console.error('[upload] text extraction failed:', e.message);
  }
  return '';
}

// Resolve a stored file path safely (must stay within UPLOAD_DIR).
export function resolveStored(fileUrl) {
  const base = path.resolve(UPLOAD_DIR);
  const full = path.resolve(base, path.basename(fileUrl || ''));
  if (!full.startsWith(base)) return null; // path traversal guard
  return fs.existsSync(full) ? full : null;
}
