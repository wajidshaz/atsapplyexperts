# =====================================================================
#  dev.ps1 — run the whole app in ONE terminal window.
#
#  - Backend runs in the FOREGROUND with auto-reload (node --watch):
#      edit any backend file and it restarts itself in this same window.
#  - JobSpy bot (:8000) and the static frontend (:5173) run quietly in the
#      background; their logs go to temp files.
#  - Press Ctrl+C once to stop everything.  To restart, just re-run this script.
#
#  Run from the project root:
#     powershell -ExecutionPolicy Bypass -File .\dev.ps1
# =====================================================================
$root = $PSScriptRoot
$bg = @()

function Stop-All {
  foreach ($p in $script:bg) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  # also clear anything left on our ports
  foreach ($port in 8000, 5173) {
    try { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } } catch {}
  }
}

try {
  # free our ports from any previous run so startup doesn't collide
  foreach ($port in 4000, 5173, 8000) {
    try { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } } catch {}
  }

  Write-Host "Starting JobSpy bot (:8000) + frontend (:5173) in background..." -ForegroundColor Cyan
  $bg += Start-Process python -ArgumentList "app.py" -WorkingDirectory "$root\jobspy-service" `
           -NoNewWindow -PassThru `
           -RedirectStandardOutput "$env:TEMP\ats-jobspy.log" -RedirectStandardError "$env:TEMP\ats-jobspy.err.log"
  $bg += Start-Process python -ArgumentList "-m", "http.server", "5173" -WorkingDirectory "$root\frontend" `
           -NoNewWindow -PassThru `
           -RedirectStandardOutput "$env:TEMP\ats-frontend.log" -RedirectStandardError "$env:TEMP\ats-frontend.err.log"

  Start-Sleep -Seconds 2
  Start-Process "http://localhost:5173/"

  Write-Host ""
  Write-Host "  App:    http://localhost:5173/" -ForegroundColor Green
  Write-Host "  Login:  Wajid Khosa  /  123456" -ForegroundColor Green
  Write-Host "  Backend auto-reloads on file changes. Ctrl+C stops everything." -ForegroundColor Green
  Write-Host "  (bg logs: $env:TEMP\ats-jobspy.log , ats-frontend.log)" -ForegroundColor DarkGray
  Write-Host ""

  Push-Location "$root\backend"
  node --watch src/app.js          # foreground: streams logs + restarts on changes
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
  Write-Host "`nStopping all services..." -ForegroundColor Yellow
  Stop-All
  Write-Host "All stopped."
}
