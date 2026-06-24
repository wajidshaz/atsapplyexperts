# =====================================================================
#  Launch ATS Apply Experts locally — opens 3 windows:
#    1) Backend API        -> http://localhost:4000
#    2) JobSpy job bot      -> http://127.0.0.1:8000   (optional)
#    3) Frontend (static)   -> http://localhost:5173
#  Run from this folder:   powershell -ExecutionPolicy Bypass -File .\run-local.ps1
# =====================================================================
$root = $PSScriptRoot

Write-Host "Starting backend API (:4000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\backend'; node src/app.js"

Write-Host "Starting JobSpy bot (:8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\jobspy-service'; python app.py"

Write-Host "Starting frontend (:5173)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\frontend'; python -m http.server 5173"

Start-Sleep -Seconds 4
Start-Process "http://localhost:5173/"

Write-Host ""
Write-Host "All started. Open http://localhost:5173/" -ForegroundColor Green
Write-Host "Log in as staff:  Wajid Khosa  /  123456" -ForegroundColor Green
Write-Host "(Close the 3 windows to stop the services.)"
