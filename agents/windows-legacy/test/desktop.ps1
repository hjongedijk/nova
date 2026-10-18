# Checks the desktop eyes-and-hands rules without Windows: the embedded C# compiles and its pure rules behave
# (coordinate scaling, deny-list, key allow-list, ttl clamp, rate limit, arm/expire/kill), and the defaults are off.
# Win32 calls (SendInput, screenshots, the red bar) need a real Windows desktop and are not exercised here.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$text = Get-Content -Raw (Join-Path $root 'nova-agent.ps1')
$marker = "# ---------- desktop eyes and hands"
$begin = $text.IndexOf($marker)
$start = $text.IndexOf("Add-Type @'", $begin) + "Add-Type @'".Length
$end = $text.IndexOf("`n'@", $start)
$code = $text.Substring($start, $end - $start)
$refs = @('System.Collections', 'System.Diagnostics.Process', 'System.Runtime.InteropServices', 'System.Threading', 'System.Threading.Thread',
  'System.Linq', 'System.Console', 'System.Memory', 'System.ComponentModel.Primitives', 'System.Runtime.Extensions')
Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies $refs -IgnoreWarnings -ErrorAction Stop
Write-Host 'desktop C#: compiles'

$failed = $false
function Check([string]$name, [bool]$ok) { if ($ok) { Write-Host "ok   $name" } else { $script:failed = $true; Write-Host "FAIL $name" } }
function Throws([scriptblock]$block) { try { & $block; return $false } catch { return $true } }

# Coordinates: screenshot 1280x720 of a 2560x1440 display at (100,50): the middle maps to the real middle.
$p = [NovaDesktopPolicy]::ScalePoint(640, 360, 1280, 720, 100, 50, 2560, 1440)
Check 'scale middle' ($p[0] -eq 1380 -and $p[1] -eq 770)
$p = [NovaDesktopPolicy]::ScalePoint(99999, -5, 1280, 720, 100, 50, 2560, 1440)
Check 'scale clamps inside the display' ($p[0] -eq 2659 -and $p[1] -eq 50)
$p = [NovaDesktopPolicy]::ScalePoint(10, 20, 0, 0, 0, 0, 1920, 1080)
Check 'no relativeTo means real pixels' ($p[0] -eq 10 -and $p[1] -eq 20)
Check 'scale refuses NaN' (Throws { [void][NovaDesktopPolicy]::ScalePoint([double]::NaN, 1, 1, 1, 0, 0, 10, 10) })
Check 'scale refuses an empty display' (Throws { [void][NovaDesktopPolicy]::ScalePoint(1, 1, 1, 1, 0, 0, 0, 10) })

# Deny-list: case-insensitive, title or process.
$deny = [string[]]@('KeePass', 'Windows Security', 'consent')
Check 'deny by title' ([NovaDesktopPolicy]::IsDenied('Unlock - keepass database', 'x', $deny))
Check 'deny by process' ([NovaDesktopPolicy]::IsDenied('Prompt', 'consent', $deny))
Check 'allow ordinary window' (-not [NovaDesktopPolicy]::IsDenied('Notepad', 'notepad', $deny))
Check 'empty deny entries ignored' (-not [NovaDesktopPolicy]::IsDenied('Notepad', 'notepad', [string[]]@('', ' ')))
Check 'null list allows' (-not [NovaDesktopPolicy]::IsDenied('Notepad', 'notepad', $null))

# Keys: allow-list only.
Check 'ctrl+c' ((([NovaDesktopPolicy]::ParseKey('Ctrl+C')) -join ',') -eq '17,67')
Check 'enter' ((([NovaDesktopPolicy]::ParseKey('Enter')) -join ',') -eq '13')
Check 'f5' ((([NovaDesktopPolicy]::ParseKey('F5')) -join ',') -eq '116')
Check 'win refused' (Throws { [void][NovaDesktopPolicy]::ParseKey('Win+R') })
Check 'ctrl+alt+delete refused' (Throws { [void][NovaDesktopPolicy]::ParseKey('Ctrl+Alt+Delete') })
Check 'two keys refused' (Throws { [void][NovaDesktopPolicy]::ParseKey('A+B') })
Check 'unknown key refused' (Throws { [void][NovaDesktopPolicy]::ParseKey('PrintScreen') })
Check 'modifier only refused' (Throws { [void][NovaDesktopPolicy]::ParseKey('Ctrl') })
Check 'F13 refused' (Throws { [void][NovaDesktopPolicy]::ParseKey('F13') })

# TTL: never above 900 s, never below 1.
Check 'ttl clamped to 900' ([NovaDesktopPolicy]::ClampTtlSeconds(86400) -eq 900)
Check 'ttl kept' ([NovaDesktopPolicy]::ClampTtlSeconds(45.9) -eq 45)
Check 'ttl zero refused' (Throws { [void][NovaDesktopPolicy]::ClampTtlSeconds(0) })

# Arm, expire, kill. Starts disarmed (memory only, so a restart is always disarmed).
Check 'starts disarmed' (-not [NovaDesktopGuard]::IsArmed(1000))
$until = [NovaDesktopGuard]::Arm(60, 1000)
Check 'armed until now+60s' ($until -eq 61000 -and [NovaDesktopGuard]::IsArmed(60999))
Check 'expires' (-not [NovaDesktopGuard]::IsArmed(61000))
[void][NovaDesktopGuard]::Arm(60, 1000)
[NovaDesktopGuard]::Disarm('hotkey')
Check 'kill disarms at once' (-not [NovaDesktopGuard]::IsArmed(1001) -and [NovaDesktopGuard]::Reason() -eq 'hotkey')
Check 'arm above 900 s is capped' (([NovaDesktopGuard]::Arm(99999, 0)) -eq 900000)

# Rate limit: 10 actions per second.
$rl = New-Object NovaRateLimiter 10, 1000
$allowed = 0; 1..15 | ForEach-Object { if ($rl.Allow(5000)) { $allowed++ } }
Check 'ten per second' ($allowed -eq 10)
Check 'window slides' ($rl.Allow(6000))

# Chord for the kill switch.
$c = [NovaDesktopPolicy]::ParseChord('Ctrl+Alt+Shift+K')
Check 'kill chord parsed' ($c[0] -eq 7 -and $c[1] -eq [int][char]'K')
Check 'chord needs a modifier' (Throws { [void][NovaDesktopPolicy]::ParseChord('K') })

# Source-level invariants: defaults off, control request needs the config, disarm always works, kill item in the tray.
Check 'view off unless enabled' ($text -match '\$script:desktopView = \(\$desktopCfg -and \$desktopCfg\.enabled -eq \$true\)')
Check 'control off unless enabled' ($text -match '\$script:desktopControl = \(\$script:desktopView -and \$desktopCfg\.control -eq \$true\)')
Check 'tray kill item' ($text -match '"Besturing stoppen"' -and $text -match "desktop-stop")
Check 'input refuses when not armed' ($text -match "Control is not armed")
Check 'input never logs typed text' ($text -match 'type chars=' -and $text -notmatch 'Write-DesktopLog[^\n]*\$text\b')
$example = Get-Content -Raw (Join-Path $root 'agent.example.json') | ConvertFrom-Json
Check 'example config: desktop off' ($example.desktop.enabled -eq $false -and $example.desktop.control -eq $false)

if ($failed) { exit 1 }
Write-Host 'desktop checks passed'
