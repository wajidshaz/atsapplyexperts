import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';
import { globalLimiter } from './middleware/rateLimit.js';

import authRoutes from './routes/auth.js';
import candidateRoutes from './routes/candidates.js';
import jobRoutes from './routes/jobs.js';
import batchRoutes from './routes/batches.js';
import adminRoutes from './routes/admin.js';
import employeeRoutes from './routes/employees.js';
import reportRoutes from './routes/reports.js';
import messageRoutes from './routes/messages.js';
import notificationRoutes from './routes/notifications.js';

const app = express();

// --- security headers ---
app.use(helmet());

// --- CORS locked to the known frontend origin(s) ---
// APP_URL is the primary origin; CORS_ORIGINS can add a comma-separated list.
const allowedOrigins = [
  process.env.APP_URL || 'http://localhost:5173',
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : []),
].filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // allow same-origin / curl / server-to-server (no Origin header)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// --- rate limiting (looser global cap; strict limiters live in middleware/rateLimit.js) ---
app.use('/api', globalLimiter);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ats-apply-experts-api' }));

app.use('/api/auth', authRoutes);
app.use('/api/candidates', candidateRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);

// central error handler
app.use((err, _req, res, _next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 4000;
// Don't bind a port when imported by tests.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`ATS Apply Experts API on :${PORT}`));
}

export default app;
