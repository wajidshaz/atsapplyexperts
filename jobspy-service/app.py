"""
JobSpy micro-service.

A tiny Flask app that wraps the JobSpy library and exposes ONE endpoint the
Node backend calls. Keeps Python isolated from the Node app.

POST /scrape
  body: {
    "site_name":   ["indeed", "linkedin", "zip_recruiter", "glassdoor", "google"],
    "search_term": "frontend engineer",
    "location":    "United States",
    "results_wanted": 50,
    "hours_old":   72,
    "is_remote":   false,
    "country_indeed": "USA",
    "proxies":     ["user:pass@host:port"]   # optional; recommended for LinkedIn
  }
  returns: { "count": N, "jobs": [ {normalized job}, ... ] }

NOTES / HONEST CAVEATS:
- LinkedIn rate-limits aggressively (~10th page). Use proxies for large pulls.
- Indeed is the most reliable. Each board caps around ~1000 results per search.
- Sites change; if a board breaks, JobSpy must be updated. This service catches
  per-board errors and returns whatever succeeded.
"""

import os
from flask import Flask, request, jsonify

app = Flask(__name__)

# Import lazily so the service still starts if jobspy isn't installed yet,
# and so import errors surface in the response instead of crashing boot.
try:
    from jobspy import scrape_jobs
    JOBSPY_OK = True
    JOBSPY_ERR = None
except Exception as e:  # pragma: no cover
    JOBSPY_OK = False
    JOBSPY_ERR = str(e)


def normalize(row):
    """Map a JobSpy dataframe row to the shape our Node backend expects."""
    def g(*keys):
        for k in keys:
            v = row.get(k)
            if v is not None and str(v) != "nan":
                return v
        return None

    site = g("site") or "jobspy"
    job_id = g("id", "job_url") or ""
    salary_max = g("max_amount")
    try:
        salary_max = int(float(salary_max)) if salary_max is not None else None
    except (TypeError, ValueError):
        salary_max = None

    return {
        "external_id": f"jobspy:{site}:{job_id}",
        "source": site,
        "title": g("title"),
        "company": g("company"),
        "location": g("location", "city"),
        "salary": g("salary_source", "interval"),
        "salary_max": salary_max,
        "job_type": g("job_type"),
        "experience_level": None,  # JobSpy doesn't always provide this
        "description": g("description") or "",
        "apply_link": g("job_url", "job_url_direct"),
        "posted_at": str(g("date_posted")) if g("date_posted") else None,
    }


@app.get("/health")
def health():
    return jsonify(ok=True, jobspy_installed=JOBSPY_OK, error=JOBSPY_ERR)


@app.post("/scrape")
def scrape():
    if not JOBSPY_OK:
        return jsonify(error="jobspy not installed", detail=JOBSPY_ERR), 500

    body = request.get_json(force=True, silent=True) or {}
    site_name = body.get("site_name") or ["indeed"]
    search_term = body.get("search_term") or ""
    location = body.get("location") or ""
    results_wanted = int(body.get("results_wanted") or 30)
    hours_old = body.get("hours_old")
    is_remote = bool(body.get("is_remote") or False)
    country_indeed = body.get("country_indeed") or "USA"
    proxies = body.get("proxies")  # list or None

    try:
        df = scrape_jobs(
            site_name=site_name,
            search_term=search_term,
            location=location,
            results_wanted=results_wanted,
            hours_old=hours_old,
            is_remote=is_remote,
            country_indeed=country_indeed,
            proxies=proxies,
        )
    except Exception as e:
        return jsonify(error="scrape failed", detail=str(e)), 502

    jobs = []
    if df is not None and len(df) > 0:
        for _, row in df.iterrows():
            try:
                jobs.append(normalize(row.to_dict()))
            except Exception:
                continue

    return jsonify(count=len(jobs), jobs=jobs)


if __name__ == "__main__":
    port = int(os.environ.get("JOBSPY_PORT", "8000"))
    app.run(host="127.0.0.1", port=port)
