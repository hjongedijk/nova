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

# The helper overlay: the C# Win32 helpers compile (checked above), degrade without Windows (no display, no DPI API:
# scale 1.0, no window), and agent.example.json plus the script carry the mode setting and its endpoints.
if (-not $failed) {
  try {
    if ([NovaHelper]::Scale(0, 0) -ne 1.0) { $failed = $true; Write-Host 'NovaHelper: scale without a display should be 1.0' }
    elseif ([NovaHelper]::Alive([IntPtr]::Zero)) { $failed = $true; Write-Host 'NovaHelper: a null window should not be alive' }
    else { Write-Host 'NovaHelper: scale and window checks ok' }
  } catch [System.DllNotFoundException], [System.EntryPointNotFoundException] {
    # Not Windows: the user32 calls cannot run here, compiling was the check.
    Write-Host 'NovaHelper: compiles (Win32 calls need Windows)'
  } catch { $failed = $true; Write-Host "NovaHelper: $($_.Exception.Message)" }
  $example = Get-Content -Raw (Join-Path $root 'agent.example.json') | ConvertFrom-Json
  if (@('wallpaper', 'helper', 'both') -notcontains [string]$example.mode) { $failed = $true; Write-Host 'agent.example.json: mode must be wallpaper, helper or both' }
  else { Write-Host "agent.example.json: mode '$($example.mode)'" }
  # Fully rounded corners: one region over the whole window (no flat top, no DWM rounding that varies by Windows version).
  if ($text -notmatch 'CreateRoundRectRgn\(0, 0, w \+ 1') { $failed = $true; Write-Host 'NovaHelper: the window must be clipped to a full rounded rectangle' }
  if ($text -match 'DwmSetWindowAttribute\(') { $failed = $true; Write-Host 'NovaHelper: DWM corner rounding is not used' }
  foreach ($route in "'/v1/mode'", "'/v1/helper/size'", "'/v1/status'", "'/v1/displays'") {
    if (-not $text.Contains($route)) { $failed = $true; Write-Host "jarvis-agent.ps1: route $route is missing" }
  }
  if ($text -notmatch "\$agentVersion = '\d{4}-\d{2}-\d{2}\.\d+'") { $failed = $true; Write-Host 'jarvis-agent.ps1: agent version string not found' }
  # Every mode the agent accepts must be one NOVA sends (contracts: HelperMode).
  # (Skipped when only the agent folder is mounted, as in the docker one-liner.)
  $contractsFile = Join-Path $root '../../packages/contracts/src/settings.ts'
  if (Test-Path $contractsFile) {
    if ((Get-Content -Raw $contractsFile) -notmatch 'HelperMode = "wallpaper" \| "helper" \| "both"') { $failed = $true; Write-Host 'contracts: HelperMode differs from the agent modes' }
    else { Write-Host 'mode names agree with NOVA (contracts)' }
  }
}

# The browser tools talk to Edge through NovaCdp. Run it against a fake DevTools page socket: it must skip events,
# return the reply with its id, and fail (not hang) when nothing answers.
if (-not $failed) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public class FakeDevTools {
  public static HttpListener Start(string prefix, bool answer) {
    var listener = new HttpListener();
    listener.Prefixes.Add(prefix);
    listener.Start();
    Task.Run(async () => {
      while (true) {
        var ctx = await listener.GetContextAsync();
        var ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket;
        var buffer = new byte[4096];
        var got = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
        if (!answer) continue;
        string request = Encoding.UTF8.GetString(buffer, 0, got.Count);
        string echo = request.Contains("\"method\":\"Runtime.evaluate\"") ? "true" : "false";
        foreach (string reply in new[] { "{\"method\":\"Page.frameNavigated\",\"params\":{}}", "{\"id\":1,\"result\":{\"echo\":" + echo + ",\"text\":\"hé\"}}" })
          await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(reply)), WebSocketMessageType.Text, true, CancellationToken.None);
      }
    });
    return listener;
  }
}
'@ -ReferencedAssemblies @('System.Net.HttpListener', 'System.Net.WebSockets', 'System.Net.Primitives', 'System.Threading', 'System.Threading.Tasks', 'System.Runtime', 'System.Memory', 'System.Collections', 'System.Text.Encoding.Extensions') -ErrorAction Stop
    $good = [FakeDevTools]::Start('http://127.0.0.1:19331/', $true)
    $reply = ConvertFrom-Json ([NovaCdp]::Call('ws://127.0.0.1:19331/devtools/page/x', 'Runtime.evaluate', '{"expression":"1"}', 5000))
    if ($reply.id -eq 1 -and $reply.result.echo -eq $true -and $reply.result.text -eq ('h' + [char]0xE9)) { Write-Host 'NovaCdp: reply ok (events skipped)' }
    else { $failed = $true; Write-Host "NovaCdp: unexpected reply $(ConvertTo-Json -InputObject $reply -Compress)" }
    $good.Stop()
    $silent = [FakeDevTools]::Start('http://127.0.0.1:19332/', $false)
    try {
      [void][NovaCdp]::Call('ws://127.0.0.1:19332/devtools/page/x', 'Runtime.evaluate', '{}', 800)
      $failed = $true; Write-Host 'NovaCdp: a silent browser did not time out'
    } catch { Write-Host 'NovaCdp: timeout ok' }
    $silent.Stop()
  } catch {
    $failed = $true
    Write-Host "NovaCdp test: $($_.Exception.Message)"
  }
}
if ($failed) { exit 1 }
