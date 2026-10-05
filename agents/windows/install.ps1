<#
Run once in an elevated PowerShell on the Windows PC:
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost 192.168.10.9
Creates agent.json (with a random token), opens the firewall for the Jarvis host
only, and registers a logon task so the agent runs in your desktop session.
#>
param(
  [Parameter(Mandatory = $true)][string]$JarvisHost,
  [int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$configPath = Join-Path $dir 'agent.json'
if (-not (Test-Path $configPath)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $config = Get-Content -Raw (Join-Path $dir 'agent.example.json') | ConvertFrom-Json
  $config.token = $token
  $config.allowedIps = @($JarvisHost)
  $config | ConvertTo-Json -Depth 6 | Set-Content -Path $configPath -Encoding UTF8
  # Only the current user and administrators may read the token.
  icacls $configPath /inheritance:r /grant:r "${env:USERNAME}:(R)" 'Administrators:(F)' | Out-Null
}
$token = (Get-Content -Raw $configPath | ConvertFrom-Json).token
netsh http add urlacl url="http://+:$Port/" user="$env:USERDOMAIN\$env:USERNAME" | Out-Null
Remove-NetFirewallRule -DisplayName 'Jarvis agent' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Jarvis agent' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $JarvisHost -Action Allow | Out-Null
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\jarvis-agent.ps1`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName 'JarvisAgent' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'JarvisAgent' -Action $action -Trigger $trigger -Principal $principal | Out-Null
Start-ScheduledTask -TaskName 'JarvisAgent'
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Agent installed. Add these two lines to /opt/jarvis/.env on the Jarvis host:' -ForegroundColor Green
Write-Host "WINDOWS_AGENT_URL=http://${ip}:$Port"
Write-Host "WINDOWS_AGENT_TOKEN=$token"
