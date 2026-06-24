# AI Integration (OpenRouter)

All AI runs through **OpenRouter** with one key (`OPENROUTER_API_KEY`). Module: `backend/src/services/openrouter.js`.

**Rule:** the AI only *suggests*. It never writes to the DB, sends email, applies to jobs, or triggers automation. Callers (routes / the scheduler) decide what to persist.

## Confirmed in-scope features
1. **Job scoring** — `matchJob(resumeText, job)`
2. **Resume analysis** — `analyzeResume(resumeText)`
3. **Job summaries** — `simplifyJob(description)`

(Cover-letter and ATS-keyword *generation* were explicitly out of scope.)

## Two sub-systems

### Embeddings — job matching
- Model: `OPENROUTER_EMBED_MODEL` (default `nvidia/llama-nemotron-embed-vl-1b-v2:free`).
- Embeds the resume and the job text, computes **cosine similarity**, and maps it to a 0–100 score using calibration constants `SCORE_MIN=0.40` / `SCORE_MAX=0.90`.
- Recommendation: `score≥80` → approve, `<50` → reject, else review.
- `reasoning` stores the raw similarity (e.g. `cosine 0.7321 → score 66`) so you can re-tune `SCORE_MIN/MAX` after observing real values.
- Inputs are truncated to ~6000 chars (`MAX_CHARS`) to stay under the token limit.

### Chat completions — analysis & summaries
- Model: `OPENROUTER_CHAT_MODEL` (default `google/gemini-2.0-flash-exp:free`).
- `analyzeResume` → `{ skills[], strength 0–100, summary }` (JSON).
- `simplifyJob` → 1–2 plain sentences.
- `suggestBatchSize(stats)` and `recommend(score, reasoning)` exist as helpers (JSON, ≤50 cap on batch size).
- A shared `GUARD` system prompt enforces the suggest-only contract. JSON responses are parsed defensively (markdown code fences stripped) since some free models wrap output.

## Errors / retries
- Each call throws on non-2xx with the upstream status + body. Callers in the scheduler wrap summary generation in try/catch so one failure never aborts a batch. Tune model choice via env without code changes.
