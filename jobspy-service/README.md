# JobSpy micro-service

A small Python (Flask) service that wraps the [JobSpy](https://github.com/speedyapply/JobSpy)
library. The Node backend calls it over HTTP to extract jobs from LinkedIn, Indeed,
Glassdoor, Google, and ZipRecruiter.

## Run it

```bash
cd jobspy-service
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py                   # starts on http://127.0.0.1:8000
```

Check it's alive:
```bash
curl http://127.0.0.1:8000/health
# {"ok": true, "jobspy_installed": true, "error": null}
```

## Test a scrape

```bash
curl -X POST http://127.0.0.1:8000/scrape \
  -H "Content-Type: application/json" \
  -d '{"site_name":["indeed"],"search_term":"frontend engineer","location":"United States","results_wanted":20,"hours_old":72,"country_indeed":"USA"}'
```

## Honest notes

- **Indeed** is the most reliable. **LinkedIn** rate-limits around the 10th page —
  use the `proxies` field for larger pulls.
- Each board caps around ~1000 results per search.
- Sites change; if a board stops returning data, JobSpy itself needs updating
  (`pip install -U python-jobspy`).
- Run this service privately (bound to 127.0.0.1) — only your Node backend should
  reach it. Do not expose it to the public internet.
```
