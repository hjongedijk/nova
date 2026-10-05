<#
Run once in an elevated PowerShell on the Windows PC:
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost 192.168.10.9
Installs what the agent needs (Node.js and its packages), creates agent.json with a random
token, opens the firewall for the NOVA host only, and registers a logon task so the agent
runs in your desktop session. It controls Chrome, or Edge with -Browser msedge.
#>
param(
  [Parameter(Mandatory = $true)][string]$JarvisHost,
  [int]$Port = 8766,
  [ValidateSet('chrome', 'msedge')][string]$Browser = 'chrome'
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Installing the LTS version with winget...'
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
Push-Location $dir
npm install --omit=dev
Pop-Location

$configPath = Join-Path $dir 'agent.json'
if (-not (Test-Path $configPath)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $config = Get-Content -Raw (Join-Path $dir 'agent.example.json') | ConvertFrom-Json
  $config.token = $token
  $config.port = $Port
  $config.browser = $Browser
  $config.allowFrom = @($JarvisHost)
  $config | ConvertTo-Json -Depth 6 | Set-Content -Path $configPath -Encoding UTF8
  # Only the current user and administrators may read the token.
  icacls $configPath /inheritance:r /grant:r "${env:USERNAME}:(R)" 'Administrators:(F)' | Out-Null
}
$token = (Get-Content -Raw $configPath | ConvertFrom-Json).token

Remove-NetFirewallRule -DisplayName 'NOVA browser agent' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'NOVA browser agent' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $JarvisHost -Action Allow | Out-Null

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\agent.mjs`" `"$configPath`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName 'JarvisBrowserAgent' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'JarvisBrowserAgent' -Action $action -Trigger $trigger -Principal $principal | Out-Null
Start-ScheduledTask -TaskName 'JarvisBrowserAgent'

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Browser agent installed. Add these two lines to /opt/jarvis/.env on the NOVA host:' -ForegroundColor Green
Write-Host "BROWSER_AGENT_URL=http://${ip}:$Port"
Write-Host "BROWSER_AGENT_TOKEN=$token"
Write-Host 'Then run: docker compose up -d jarvis-api'
