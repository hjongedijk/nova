# Checks the PC-side 3D modelling and slicing rules without Windows: the embedded C# compiles, the rules reject what they
# must, and the bounded process runner really enforces output and time limits (using sh on Linux/macOS, cmd on Windows).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$text = Get-Content -Raw (Join-Path $root 'nova-agent.ps1')
$begin = $text.IndexOf('# ---------- 3D modelling and slicing on this PC')
$start = $text.IndexOf("Add-Type @'", $begin) + "Add-Type @'".Length
$end = $text.IndexOf("`n'@", $start)
$code = $text.Substring($start, $end - $start)
$refs = @('System.Collections', 'System.Diagnostics.Process', 'System.Runtime.InteropServices', 'System.Threading', 'System.Threading.Thread',
  'System.Linq', 'System.Console', 'System.Memory', 'System.ComponentModel.Primitives', 'System.Runtime.Extensions', 'System.Text.RegularExpressions', 'System.IO')
Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies $refs -IgnoreWarnings -ErrorAction Stop
Write-Host 'fabrication C#: compiles'

$failed = $false
function Check([string]$name, [bool]$ok) { if ($ok) { Write-Host "ok   $name" } else { $script:failed = $true; Write-Host "FAIL $name" } }
function Throws([scriptblock]$block) { try { & $block; return $false } catch { return $true } }

# OpenSCAD source rules
Check 'plain scad accepted' ([NovaFab]::CheckScad('cube([1,2,3]);') -eq 'cube([1,2,3]);')
foreach ($bad in @('include <x.scad>;', 'use <x.scad>;', 'import("/etc/passwd");', 'surface(file="a.dat");', '', '   ', ('x' * 70000), "cube(1);`0"))
  { Check "scad refused: $($bad.Substring(0, [Math]::Min(18, $bad.Length)).Replace("`0", '\0'))" (Throws { [void][NovaFab]::CheckScad($bad) }) }

# Windows argument quoting
Check 'plain arg unquoted' ([NovaFab]::QuoteArg('abc') -eq 'abc')
Check 'space quoted' ([NovaFab]::QuoteArg('a b') -eq '"a b"')
Check 'embedded quote escaped' ([NovaFab]::QuoteArg('a"b') -eq '"a\"b"')
Check 'trailing backslash doubled' ([NovaFab]::QuoteArg('C:\my dir\') -eq '"C:\my dir\\"')
Check 'empty arg is ""' ([NovaFab]::QuoteArg('') -eq '""')
Check 'join' ([NovaFab]::JoinArgs([string[]]@('-o', 'out file.stl')) -eq '-o "out file.stl"')
Check 'nul refused' (Throws { [void][NovaFab]::QuoteArg("a`0b") })

# Placeholders: only known names
$v = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$v['input'] = 'C:\t\model.stl'; $v['layer'] = '0.2'
Check 'expand' ([NovaFab]::Expand('--layer={layer}', $v) -eq '--layer=0.2')
Check 'unknown placeholder refused' (Throws { [void][NovaFab]::Expand('{oops}', $v) })

# Slice parameters
Check 'material ok' ([NovaFab]::CheckMaterial(' petg ') -eq 'PETG')
Check 'material refused' (Throws { [void][NovaFab]::CheckMaterial('wood') })
Check 'number ok' ([NovaFab]::CheckNumber('layer', '0.2', 0.05, 0.6) -eq 0.2)
foreach ($bad in @('abc', '9', 'NaN', '-1', ''))
  { Check "number refused: '$bad'" (Throws { [void][NovaFab]::CheckNumber('layer', $bad, 0.05, 0.6) }) }
Check 'supports refused' (Throws { [void][NovaFab]::CheckSupports('maybe') })
Check 'supports default' ([NovaFab]::CheckSupports($null) -eq 'auto')

# Estimates
$sample = "; HEADER\n; total estimated time: 1h 35m 30s\n; total filament weight [g] : 31.5\n; unrelated\n".Replace('\n', "`n")
$est = [NovaFab]::EstimateLines($sample)
Check 'estimate lines kept' ($est -match 'total estimated time' -and $est -match 'filament weight' -and $est -notmatch 'unrelated')

# Capped reads
$ms = New-Object IO.MemoryStream (, [byte[]](1..200 | ForEach-Object { [byte]($_ % 250) }))
Check 'capped read ok' ([NovaFab]::ReadCapped($ms, 200, 1000).Length -eq 200)
$ms2 = New-Object IO.MemoryStream (, [byte[]](1..200 | ForEach-Object { [byte]($_ % 250) }))
Check 'capped read refuses by size' (Throws { [void][NovaFab]::ReadCapped($ms2, -1, 100) })
Check 'capped read refuses declared size' (Throws { [void][NovaFab]::ReadCapped($ms2, 5000, 100) })

# Bounded runner
$dir = [IO.Path]::GetTempPath()
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  $r = [NovaFab]::Run('cmd.exe', '/c echo hello', $dir, 5000, 1000)
  Check 'runs and captures output' ($r.ExitCode -eq 0 -and $r.Output -match 'hello' -and -not $r.TimedOut)
  $t = [NovaFab]::Run('cmd.exe', '/c ping -n 30 127.0.0.1', $dir, 700, 1000)
} else {
  $r = [NovaFab]::Run('/bin/sh', '-c "echo hello; echo err 1>&2; exit 3"', $dir, 5000, 1000)
  Check 'runs and captures output' ($r.ExitCode -eq 3 -and $r.Output -match 'hello' -and $r.Output -match 'err' -and -not $r.TimedOut)
  $big = [NovaFab]::Run('/bin/sh', '-c "yes x | head -c 200000"', $dir, 5000, 1000)
  Check 'output is bounded' ($big.Output.Length -le 1100)
  $t = [NovaFab]::Run('/bin/sh', '-c "sleep 30"', $dir, 700, 1000)
}
Check 'timeout kills the process' ($t.TimedOut -and $t.ExitCode -eq -1)

# Source invariants
Check 'off unless enabled' ($text -match '\$script:fabEnabled = \(\$fabCfg -and \$fabCfg\.enabled -eq \$true\)')
Check 'slicer path and args come from agent.json only' ($text -match '\$s\.path' -and $text -notmatch '\$q\[''path''\]|\$q\[''exe''\]')
Check 'slicer profile fixed to P2S' ($text -match "-match 'P2S'" -and $text -match 'does not match this PC')
$example = Get-Content -Raw (Join-Path $root 'agent.example.json') | ConvertFrom-Json
Check 'example config: fabrication off' ($example.fabrication.enabled -eq $false)

if ($failed) { exit 1 }
Write-Host 'fabrication checks passed'
