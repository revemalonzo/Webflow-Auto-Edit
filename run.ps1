$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = "logs\run-$timestamp.log"
New-Item -ItemType Directory -Force -Path logs | Out-Null
Write-Host "Logging to $logFile"
node src/index.js 2>&1 | Tee-Object -FilePath $logFile
Write-Host "Done. Log saved to $logFile"
