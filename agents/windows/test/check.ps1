# Checks the Windows agent without Windows: PowerShell syntax of the scripts, and that the C# it
# embeds compiles. Runs on any machine with PowerShell 7 (pwsh), including the CI runner.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$failed = $false

foreach ($file in 'jarvis-agent.ps1', 'install.ps1') {
  $errors = $null; $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$errors)
  if ($errors.Count) {
    $failed = $true
    $errors | ForEach-Object { Write-Host "${file} line $($_.Extent.StartLineNumber): $($_.Message)" }
  } else { Write-Host "${file}: syntax ok" }
}

$text = Get-Content -Raw (Join-Path $root 'jarvis-agent.ps1')
$start = $text.IndexOf("Add-Type @'") + "Add-Type @'".Length
$end = $text.IndexOf("`n'@", $start)
$code = $text.Substring($start, $end - $start)
# On Windows PowerShell 5.1 these all live in System.dll; on .NET they are separate assemblies.
$refs = @('System.Net.WebSockets', 'System.Net.WebSockets.Client', 'System.Collections.Concurrent', 'System.Net.WebClient',
  'System.Text.RegularExpressions', 'System.Collections', 'System.Diagnostics.Process', 'System.ComponentModel.Primitives',
  'System.Net.Primitives', 'System.Threading', 'System.Threading.Thread', 'System.Runtime.InteropServices', 'System.Private.Uri',
  'System.Linq', 'System.Console', 'System.Net.Requests', 'System.Collections.NonGeneric', 'System.Threading.ThreadPool', 'System.Memory')
try {
  Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies $refs -IgnoreWarnings -ErrorAction Stop
  Write-Host 'embedded C#: compiles'
} catch {
  $failed = $true
  Write-Host "embedded C#: $($_.Exception.Message)"
}
if ($failed) { exit 1 }
