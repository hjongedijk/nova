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
  $same = { param($a, $b) (($a -join ',') -eq ($b -join ',')) }
  $l = [NovaHelper]::Layout(100, 0, 360, 44, 0, 0, 0, 0)
  if (-not (& $same $l @(100, 0, 360, 44))) { $failed = $true; Write-Host 'NovaHelper.Layout: rectangle differs' }
  $ib = [NovaHelper]::InvisibleBorders(92, 0, 468, 52, 100, 0, 460, 44)
  if (-not (& $same $ib @(8, 0, 8, 8))) { $failed = $true; Write-Host 'NovaHelper.InvisibleBorders: measurement differs' }
  $l = [NovaHelper]::Layout(100, 0, 360, 44, 8, 0, 8, 8)
  if (-not (& $same $l @(92, 0, 376, 52))) { $failed = $true; Write-Host 'NovaHelper.Layout: invisible borders differ' }
  else { Write-Host 'NovaHelper.Layout: rectangular visible bounds ok' }
  # The security flags and the chrome fallback are pure functions of the script: run them from its own source.
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$null)
  foreach ($fn in 'Get-EdgeSecurityArgs', 'Get-HelperChrome', 'Get-HelperGeometry', 'Get-ModeState', 'Save-ModeState', 'ConvertTo-HelperHotkeys', 'ConvertTo-HelperNotification', 'Send-HelperNotification', 'Get-PersistedHelperView') {
    $def = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $fn }, $true) | Select-Object -First 1
    if (-not $def) { $failed = $true; Write-Host "jarvis-agent.ps1: function $fn is missing" } else { . ([scriptblock]::Create($def.Extent.Text)) }
  }
  if (@(Get-EdgeSecurityArgs 'https://nova.example.nl').Count -ne 0) { $failed = $true; Write-Host 'Edge flags: https must not get the unsupported-flag switch' }
  elseif ((@(Get-EdgeSecurityArgs 'http://192.168.1.2:8080') -join ' ') -notmatch 'unsafely-treat-insecure-origin-as-secure=http://192.168.1.2:8080 --test-type') { $failed = $true; Write-Host 'Edge flags: http must get the switch with --test-type' }
  else { Write-Host 'Edge flags: only plain http gets the insecure-origin switch' }
  if ($text -match '(?m)^\s*"--unsafely-treat') { $failed = $true; Write-Host 'Edge flags: the switch must only come from Get-EdgeSecurityArgs' }
  $fallback = Get-HelperChrome $null 1.5
  $real = Get-HelperChrome ([pscustomobject]@{ w = 0; h = 33 }) 1.25
  if ($fallback.cy -ne 0 -or $real.cy -ne 41 -or $real.cx -ne 0) { $failed = $true; Write-Host "Get-HelperChrome: fallback $($fallback.cy), measured $($real.cy)" }
  else { Write-Host 'Get-HelperChrome: measured and fallback ok' }
  $example = Get-Content -Raw (Join-Path $root 'agent.example.json') | ConvertFrom-Json
  if (@('wallpaper', 'helper', 'both') -notcontains [string]$example.mode) { $failed = $true; Write-Host 'agent.example.json: mode must be wallpaper, helper or both' }
  else { Write-Host "agent.example.json: mode '$($example.mode)'" }
  if ($text -match 'SetWindowRgn|CreateRoundRectRgn|GetWindowRgn|Reasserted|static Thread keeper') { $failed = $true; Write-Host 'NovaHelper: region clipping and its guard must be absent' }
  if ($text -notmatch "'--edge-kiosk-type=fullscreen'") { $failed = $true; Write-Host 'NovaHelper: browser must launch without chrome' }
  $sizesAssignment = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$helperSizes' }, $true) | Select-Object -First 1
  if (-not $sizesAssignment) { throw 'Helper sizes assignment missing' }
  . ([scriptblock]::Create($sizesAssignment.Extent.Text))
  $expectedSizes = @{ compact = @(360, 44); overview = @(640, 180); notifications = @(640, 180); weather = @(640, 180); lists = @(640, 180); chat = @(640, 340); confirmation = @(640, 170) }
  foreach ($view in $expectedSizes.Keys) {
    if (-not (& $same $helperSizes[$view] $expectedSizes[$view])) { $failed = $true; Write-Host "Helper sizes: wrong $view CSS dimensions" }
  }
  $bounds = [pscustomobject]@{ X = -1920; Y = -1080; Width = 1920; Height = 1080 }
  foreach ($view in $helperSizes.Keys) {
    foreach ($scale in @(1.0, 1.5, 2.0)) {
      $r = Get-HelperGeometry $bounds $scale $view $false
      $size = $helperSizes[$view]
      if ($r.y -ne -1080 -or $r.w -ne [int]($size[0] * $scale) -or $r.h -ne [int]($size[1] * $scale) -or $r.x -ne [int]($bounds.X + ($bounds.Width - $r.w) / 2)) {
        $failed = $true; Write-Host "Get-HelperGeometry: wrong $view bounds at scale $scale"
      }
      $hidden = Get-HelperGeometry $bounds $scale $view $true
      if ($hidden.y -ne $bounds.Y -or $hidden.h -ne [int][Math]::Round(3 * $scale)) { $failed = $true; Write-Host 'Get-HelperGeometry: hidden strip differs' }
    }
  }
  $small = Get-HelperGeometry ([pscustomobject]@{ X = 0; Y = 0; Width = 320; Height = 200 }) 2.0 'chat'
  if ($small.w -ne 320 -or $small.h -ne 200) { $failed = $true; Write-Host 'Get-HelperGeometry: must fit small displays' }
  foreach ($invalid in @('unknown', '')) {
    try { Get-HelperGeometry $bounds 1 $invalid | Out-Null; $failed = $true; Write-Host 'Get-HelperGeometry: accepted invalid view' } catch { }
  }
  foreach ($invalid in @(0, -1, [double]::NaN, [double]::PositiveInfinity)) {
    try { Get-HelperGeometry $bounds $invalid 'compact' | Out-Null; $failed = $true; Write-Host 'Get-HelperGeometry: accepted invalid scale' } catch { }
  }
  Write-Host 'Get-HelperGeometry: sizes, DPI, negative screens and hidden strip checked'
  foreach ($selected in @('overview', 'chat', 'notifications', 'weather', 'lists')) {
    $remembered = Get-PersistedHelperView 'compact' $selected $false
    $remembered = Get-PersistedHelperView $remembered 'compact' $false
    $remembered = Get-PersistedHelperView $remembered 'compact' $true
    $remembered = Get-PersistedHelperView $remembered 'confirmation' $false
    if ($remembered -ne $selected) { $failed = $true; Write-Host "Helper persistence: compact/strip/confirmation replaced $selected" }
  }
  if ((Get-PersistedHelperView 'compact' 'compact' $false) -ne 'compact') { $failed = $true; Write-Host 'Helper persistence: initial compact default lost' }
  Write-Host 'Helper persistence: last meaningful view survives collapse and confirmation'

  $messageType = [NovaControls].GetNestedType('MSG', [System.Reflection.BindingFlags]::NonPublic)
  $expectedMessageSize = if ([IntPtr]::Size -eq 8) { 48 } else { 32 }
  if ([System.Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($messageType)) -ne $expectedMessageSize) { $failed = $true; Write-Host 'NovaControls: MSG layout differs from Win32' }
  $clickMessageType = [NovaClick].GetNestedType('MSG', [System.Reflection.BindingFlags]::NonPublic)
  if ([System.Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($clickMessageType)) -ne $expectedMessageSize) { $failed = $true; Write-Host 'NovaClick: MSG layout differs from Win32' }
  foreach ($sample in @(@('Ctrl+Alt+N', 3, 78), @('Shift+Win+F24', 12, 135), @('Ctrl+Alt+Space', 3, 32), @('', 0, 0))) {
    $parsed = [NovaControls]::ParseChord([string]$sample[0])
    if ($parsed[0] -ne $sample[1] -or $parsed[1] -ne $sample[2]) { $failed = $true; Write-Host 'NovaControls.ParseChord: incorrect native binding' }
  }
  foreach ($invalid in @('N', 'Ctrl', 'Ctrl+Ctrl+N', 'Ctrl+Alt+N+M', 'Ctrl+F25', 'Ctrl+Enter', 'Ctrl++N')) {
    try { [void][NovaControls]::ParseChord($invalid); $failed = $true; Write-Host "NovaControls.ParseChord: accepted $invalid" } catch { }
  }
  $validKeys = @{ open = 'Ctrl+Alt+N'; speak = 'Ctrl+Alt+Space'; mute = ''; desktop = 'Ctrl+Alt+D' }
  $validated = ConvertTo-HelperHotkeys $validKeys
  if ($validated.mute -ne '') { $failed = $true; Write-Host 'Helper shortcuts: disabled binding lost' }
  try { ConvertTo-HelperHotkeys @{ open = 'Ctrl+Alt+N'; speak = 'Alt+Ctrl+N'; mute = ''; desktop = '' } | Out-Null; $failed = $true; Write-Host 'Helper shortcuts: duplicate bindings accepted' } catch { }
  try { ConvertTo-HelperHotkeys @{ open = 'Ctrl+Alt+N' } | Out-Null; $failed = $true; Write-Host 'Helper shortcuts: incomplete set accepted' } catch { }
  Write-Host 'NovaControls: chord parsing, disabled bindings, duplicates and missing bindings checked'
  $notification = @{ seq = 1; severity = 'warning'; title = 'Server offline'; detail = "Quoted ' content remains data"; at = '2026-10-09T12:00:00Z' }
  $clean = ConvertTo-HelperNotification $notification
  if ($clean.seq -ne 1 -or $clean.detail -ne $notification.detail) { $failed = $true; Write-Host 'Notification: validated content differs' }
  foreach ($invalid in @(@{ seq = 0 }, @{ seq = 1.5 }, @{ seq = '1' }, @{ seq = $true }, @{ severity = 'danger' }, @{ title = ('x' * 121) }, @{ detail = ('x' * 241) }, @{ at = 'invalid' })) {
    $candidate = $notification.Clone()
    foreach ($key in $invalid.Keys) { $candidate[$key] = $invalid[$key] }
    try { ConvertTo-HelperNotification $candidate | Out-Null; $failed = $true; Write-Host 'Notification: accepted invalid fields' } catch { }
  }
  $script:agentPaused = $true
  if ((Send-HelperNotification $notification).reason -ne 'paused') { $failed = $true; Write-Host 'Notification: pause must suppress delivery' }
  $script:agentPaused = $false


  $storeDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
  [void][System.IO.Directory]::CreateDirectory($storeDirectory)
  $modeStore = Join-Path $storeDirectory 'mode.json'
  $config = [pscustomobject]@{ mode = 'helper'; helperDisplay = 2; novaUrl = 'https://nova.example.nl' }
  try {
    $initial = Get-ModeState
    if ($initial.view -ne 'compact' -or $initial.display -ne 2) { $failed = $true; Write-Host 'Get-ModeState: defaults differ' }
    Save-ModeState @{ mode = 'both'; display = 3; url = 'https://nova.example.nl'; view = 'overview'; hotkeys = $validKeys }
    $restored = Get-ModeState
    if ($restored.view -ne 'overview' -or $restored.display -ne 3 -or $restored.mode -ne 'both' -or $restored.hotkeys.mute -ne '') { $failed = $true; Write-Host 'Get-ModeState: restart lost view/display' }
    Save-ModeState @{ mode = 'helper'; display = 2; url = 'https://nova.example.nl'; view = 'notifications' }
    if ((Get-ModeState).view -ne 'notifications') { $failed = $true; Write-Host 'Get-ModeState: notification view lost on restart' }
    foreach ($extraView in @('weather', 'lists')) {
      Save-ModeState @{ mode = 'helper'; display = 2; url = 'https://nova.example.nl'; view = $extraView }
      if ((Get-ModeState).view -ne $extraView) { $failed = $true; Write-Host "Get-ModeState: $extraView view lost on restart" }
    }
    Save-ModeState @{ mode = 'helper'; display = 1; url = 'https://nova.example.nl'; view = 'confirmation' }
    if ((Get-ModeState).view -ne 'compact') { $failed = $true; Write-Host 'Get-ModeState: must not restore a stale confirmation' }
    Save-ModeState @{ mode = 'wallpaper'; display = 1; url = 'https://nova.example.nl'; view = 'compact' }
    if ((Send-HelperNotification $notification).reason -ne 'helper-disabled') { $failed = $true; Write-Host 'Notification: wallpaper mode must not open a helper' }
    Write-Host 'Get-ModeState: view/display persistence, stale confirmation and disabled notification checked'
  } finally { [System.IO.Directory]::Delete($storeDirectory, $true) }

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
