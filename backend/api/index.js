// Vercel serverless entry point.
// An Express app is itself a (req, res) handler, so we just re-export it.
// vercel.json rewrites every path here, and Express does the internal routing.
import app from '../src/app.js';

export default app;
