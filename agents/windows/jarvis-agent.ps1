<#
Jarvis Windows agent: a tiny authenticated HTTP service that lets Jarvis open
allow-listed applications on this PC. It runs in YOUR desktop session (so
Notepad appears on your screen) and can only start the programs listed in
agent.json -> apps. There is no arbitrary command endpoint.

It can also hang NOVA behind the desktop icons as a living wallpaper, per display
(/v1/displays and /v1/wallpaper): Microsoft Edge, already part of Windows, shows the NOVA
page in a window that is parented to the desktop. The real wallpaper setting is never
changed. What is set is remembered in wallpaper.json and restored when the agent starts.
#>
param(
  [int]$Port = 8765,
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'agent.json')
)
$ErrorActionPreference = 'Stop'
$agentVersion = '2026-10-05.3'

# However the agent is started (task, double-click, a terminal), it runs on without a window: this copy starts
# a hidden one and ends. (conhost --headless also keeps Windows Terminal from opening a window.)
if (-not $env:NOVA_AGENT_CHILD) {
  $env:NOVA_AGENT_CHILD = '1'
  $self = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port -ConfigPath `"$ConfigPath`""
  $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
  try {
    if (Test-Path $conhost) { Start-Process -FilePath $conhost -ArgumentList "--headless powershell.exe $self" -WindowStyle Hidden }
    else { Start-Process -FilePath 'powershell.exe' -ArgumentList "-WindowStyle Hidden $self" -WindowStyle Hidden }
  } catch {
    Start-Process -FilePath 'powershell.exe' -ArgumentList "-WindowStyle Hidden $self" -WindowStyle Hidden
  }
  exit
}
# Only one agent at a time: an older one still running (for example before an update) is ended.
Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*jarvis-agent.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
$token = [string]$config.token
if ($token.Length -lt 24) { throw 'agent.json: token must be at least 24 characters' }
$allowedIps = @($config.allowedIps)
$apps = @{}
$config.apps.PSObject.Properties | ForEach-Object { $apps[$_.Name] = $_.Value }

function Test-Token([string]$given) {
  # Constant-time comparison.
  $a = [Text.Encoding]::UTF8.GetBytes($given)
  $b = [Text.Encoding]::UTF8.GetBytes($token)
  $diff = $a.Length -bxor $b.Length
  for ($i = 0; $i -lt [Math]::Min($a.Length, $b.Length); $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
  return $diff -eq 0
}
function Send($ctx, [int]$code, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6 -Compress))
  $ctx.Response.StatusCode = $code
  $ctx.Response.ContentType = 'application/json'
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
function Read-Body($ctx) {
  $reader = New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  if ($text.Length -gt 8192) { throw 'Body too large' }
  if ($text) { return $text | ConvertFrom-Json }
  return [pscustomobject]@{}
}
function Get-App($name) {
  if (-not $name -or -not $apps.ContainsKey([string]$name)) { throw "App '$name' is not in the allow-list" }
  return $apps[[string]$name]
}


# ---------- living wallpaper, per display ----------
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
public class NovaDesk {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  // Without this Windows reports a scaled-down screen size (a 4K display at 150% shows up as 2560x1440),
  // and the wallpaper window would only cover part of the screen. This asks for real pixels per display.
  public static void RealPixels() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }   // per-monitor v2
    try { SetProcessDPIAware(); } catch (Exception) { }
  }
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int max);

  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);

  // What the desktop looks like around a wallpaper window: its parent, its siblings from front to back,
  // where it is, and which window a click in its middle would really reach.
  public static string Describe(IntPtr handle) {
    var o = new System.Text.StringBuilder();
    IntPtr parent = GetParent(handle);
    o.Append("parent=" + ClassOf(parent));
    o.Append(" siblings(front->back)=");
    for (IntPtr h = GetWindow(parent, 5); h != IntPtr.Zero; h = GetWindow(h, 2))
      o.Append((h == handle ? "[NOVA]" : ClassOf(h)) + (IsWindowVisible(h) ? "" : "(hidden)") + ",");
    RECT r;
    GetWindowRect(handle, out r);
    o.Append(" rect=" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom);
    var p = new PT();
    p.X = (r.Left + r.Right) / 2;
    p.Y = (r.Top + r.Bottom) / 2;
    IntPtr hit = WindowFromPoint(p);
    o.Append(" clickInMiddleReaches=" + ClassOf(hit));
    return o.ToString();
  }

  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);

  // Edge brings its window back to the front now and then (when it goes full screen, on focus). On the newer
  // desktop that is in front of the icons, which then cannot be clicked, dragged or selected. This checks every
  // second and a half and puts the window right back behind the icon layer.
  static readonly System.Collections.Generic.List<IntPtr> kept = new System.Collections.Generic.List<IntPtr>();
  static System.Threading.Timer keeper;
  public static int Corrections = 0;

  public static void KeepBehindIcons(IntPtr handle) {
    lock (kept) if (!kept.Contains(handle)) kept.Add(handle);
    Behind(handle);
    if (keeper == null) keeper = new System.Threading.Timer(delegate { Tick(); }, null, 500, 1500);
  }

  static void Tick() {
    IntPtr[] list;
    lock (kept) list = kept.ToArray();
    foreach (IntPtr h in list) {
      try {
        if (!IsWindow(h)) { lock (kept) kept.Remove(h); continue; }
        Behind(h);
      } catch (Exception) { }
    }
  }

  static void Behind(IntPtr h) {
    IntPtr parent = GetParent(h);
    IntPtr icons = FindWindowEx(parent, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (icons == IntPtr.Zero) return;   // older layout: the icons live in another window, nothing to keep in order
    for (IntPtr w = GetWindow(parent, 5); w != IntPtr.Zero; w = GetWindow(w, 2)) {   // GW_CHILD, then GW_HWNDNEXT
      if (w == icons) return;   // the icons come first: all is well
      if (w == h) {
        SetWindowPos(h, icons, 0, 0, 0, 0, 0x0013);   // behind the icons; no move, no resize, no activate
        Corrections++;
        return;
      }
    }
  }

  public static string ClassOf(IntPtr h) {
    var name = new System.Text.StringBuilder(256);
    GetClassName(h, name, 256);
    return name.ToString();
  }

  // Finds where a wallpaper window has to go so that it sits behind the desktop icons.
  //  kind 1: older layout. A top-level WorkerW (made by the 0x052C message) lies behind the icon window:
  //          the window becomes its child, at the bottom.
  //  kind 2: Windows 11 24H2 and later. Progman holds the icons and a WorkerW child with the real
  //          wallpaper: the window becomes a child of Progman, right behind the icon layer (SHELLDLL_DefView).
  //  kind 0: not recognised. The caller must not guess: a wrong parent shows the window on top of everything.
  public static IntPtr Find(out int kind, out IntPtr after) {
    kind = 0;
    after = IntPtr.Zero;
    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) return IntPtr.Zero;
    IntPtr ignored;
    SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(1), 0, 1000, out ignored);

    IntPtr inside = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
    IntPtr icons = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (inside != IntPtr.Zero && icons != IntPtr.Zero) {
      kind = 2;
      after = icons;   // placed right behind the icon layer, and so in front of the wallpaper WorkerW
      return progman;
    }

    IntPtr worker = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (ClassOf(h) == "WorkerW" && FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
        worker = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
      return true;
    }, IntPtr.Zero);
    if (worker != IntPtr.Zero) {
      kind = 1;
      after = new IntPtr(1);   // HWND_BOTTOM
      return worker;
    }
    return IntPtr.Zero;
  }
}

// Windows hands every click and key on the desktop to the icon layer, never to a window behind it, so a
// wallpaper cannot receive input by itself. This listens for mouse and keyboard input on the bare desktop
// and passes it on to the wallpaper page (the way wallpaper programs do): moving, clicking and scrolling,
// and typing after a click on the input field. Icons keep working: the input is passed on, never taken,
// except for the keys typed into the field.
// Fallback (Forward = false): a click on the sphere opens a small NOVA window instead.
public class NovaClick {
  delegate IntPtr LowLevelProc(int code, IntPtr wParam, IntPtr lParam);
  delegate bool ChildProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk, scan, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, LowLevelProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT pt);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, ChildProc proc, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern short GetKeyState(int vk);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ToUnicodeEx(uint vk, uint scan, byte[] state, [Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder buf, int size, uint flags, IntPtr layout);

  class Target {
    public IntPtr Top, Render;
    public int X, Y, W, H, TaskbarPx, Port, Id;
    public double Scale;
    public ClientWebSocket Ws;
    public DateTime LastTry = DateTime.MinValue;
    public int ZonesId;
    public double[] Zones;   // groups of five, real screen pixels: x, y, w, h, typing
    public DateTime ZonesAt = DateTime.MinValue;
  }

  public static bool Forward = true;
  public static string EdgePath = "";
  public static string Arguments = "";
  public static int[] Regions = new int[0];   // fallback: centre x, centre y, radius (real pixels)
  static readonly System.Collections.Generic.List<Target> targets = new System.Collections.Generic.List<Target>();
  static LowLevelProc mouseProc = MouseHook, keyProc = KeyHook;
  static IntPtr mouseHook = IntPtr.Zero, keyHook = IntPtr.Zero;
  static bool leftDown, hovering;
  static int downX, downY;
  static Target armed;
  static DateTime armedAt = DateTime.MinValue;
  static DateTime lastMove = DateTime.MinValue;
  static Process assistant;
  static object gate = new object();

  public static void RemoveTarget(int x, int y) { lock (targets) targets.RemoveAll(delegate (Target t) { return t.X == x && t.Y == y; }); armed = null; }
  public static void ClearTargets() { lock (targets) targets.Clear(); armed = null; }
  public static void AddTarget(IntPtr top, int x, int y, int w, int h, int taskbarPx, int port) {
    var t = new Target();
    t.Top = top; t.X = x; t.Y = y; t.W = w; t.H = h; t.TaskbarPx = taskbarPx; t.Port = port;
    // The page draws at the scale of its own display (a 4K screen at 150%: 1.5). The window's own DPI cannot be
    // used: once it hangs in the desktop it reports the scale of the main display.
    var centre = new POINT();
    centre.X = x + w / 2;
    centre.Y = y + h / 2;
    uint dpiX = 0, dpiY = 0;
    try { GetDpiForMonitor(MonitorFromPoint(centre, 2), 0, out dpiX, out dpiY); } catch (Exception) { }
    if (dpiX == 0) dpiX = GetDpiForWindow(top);
    t.Scale = dpiX == 0 ? 1.0 : dpiX / 96.0;
    lock (targets) targets.Add(t);
    Enqueue(t, null);   // connect to the page right away
  }

  /* ---- the page's own control channel (Chrome DevTools Protocol, on this PC only) ----
     Clicks and keys sent as window messages reach Edge only now and then: Edge does not have the focus and
     does not know where the mouse is. Through this channel they arrive exactly, the way test tools drive a
     browser, and the page behaves as focused, so a clicked field gets the caret and the keys. */
  static readonly System.Collections.Concurrent.BlockingCollection<KeyValuePair<Target, string>> outbox =
    new System.Collections.Concurrent.BlockingCollection<KeyValuePair<Target, string>>(2000);
  static Thread sender;

  static string Num(double value) { return value.ToString("0.##", CultureInfo.InvariantCulture); }
  static string Json(string text) {
    var o = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') o.Append('\\').Append(c);
      else if (c < 32) o.Append("\\u").Append(((int)c).ToString("x4"));
      else o.Append(c);
    }
    return o.Append('"').ToString();
  }

  static bool Live(Target t) {
    if (t.Ws != null && t.Ws.State == WebSocketState.Open) return true;
    Enqueue(t, null);
    return false;
  }

  static void Enqueue(Target t, string command) {
    if (t.Port == 0) return;
    if (sender == null) {
      sender = new Thread(delegate () {
        foreach (var item in outbox.GetConsumingEnumerable()) {
          try { if (Connect(item.Key) && item.Value != null) Send(item.Key, item.Value); } catch (Exception) { }
        }
      });
      sender.IsBackground = true;
      sender.Start();
      StartPoller();
    }
    outbox.TryAdd(new KeyValuePair<Target, string>(t, command));
  }

  static void Cdp(Target t, string method, string parameters) {
    Enqueue(t, "\"method\":\"" + method + "\",\"params\":" + parameters);
  }

  static void Send(Target t, string body) {
    int id = Interlocked.Increment(ref t.Id);
    byte[] bytes = Encoding.UTF8.GetBytes("{\"id\":" + id + "," + body + "}");
    t.Ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).Wait(2000);
  }

  static bool Connect(Target t) {
    if (t.Ws != null && t.Ws.State == WebSocketState.Open) return true;
    if ((DateTime.UtcNow - t.LastTry).TotalSeconds < 2) return false;
    t.LastTry = DateTime.UtcNow;
    try {
      string list;
      using (var web = new System.Net.WebClient()) list = web.DownloadString("http://127.0.0.1:" + t.Port + "/json/list");
      Match m = Regex.Match(list, "\"webSocketDebuggerUrl\"\\s*:\\s*\"(ws://[^\"]*/devtools/page/[^\"]+)\"");
      if (!m.Success) return false;
      var ws = new ClientWebSocket();
      if (!ws.ConnectAsync(new Uri(m.Groups[1].Value), CancellationToken.None).Wait(3000) || ws.State != WebSocketState.Open) return false;
      t.Ws = ws;
      var reader = new Thread(delegate () {
        var buffer = new byte[65536];
        var message = new StringBuilder();
        try {
          while (ws.State == WebSocketState.Open) {
            var part = ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None).Result;
            message.Append(Encoding.UTF8.GetString(buffer, 0, part.Count));
            if (!part.EndOfMessage) continue;
            string text = message.ToString();
            message.Clear();
            if (t.ZonesId != 0 && text.Contains("\"id\":" + t.ZonesId + ",")) ReadZones(t, text);
          }
        } catch (Exception) { }
      });
      reader.IsBackground = true;
      reader.Start();
      Send(t, "\"method\":\"Emulation.setFocusEmulationEnabled\",\"params\":{\"enabled\":true}");
      return true;
    } catch (Exception) { return false; }
  }

  // Every so often the page is asked where its buttons, fields and open windows are (see __novaZones in the page).
  static Thread poller;
  static void StartPoller() {
    if (poller != null) return;
    poller = new Thread(delegate () {
      while (true) {
        Thread.Sleep(700);
        Target[] list;
        lock (targets) list = targets.ToArray();
        foreach (var t in list) {
          if (t.Ws == null || t.Ws.State != WebSocketState.Open) continue;
          try {
            int id = Interlocked.Increment(ref t.Id);
            t.ZonesId = id;
            byte[] bytes = Encoding.UTF8.GetBytes("{\"id\":" + id + ",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"window.__novaZones ? window.__novaZones() : ''\",\"returnByValue\":true}}");
            t.Ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).Wait(1000);
          } catch (Exception) { }
        }
      }
    });
    poller.IsBackground = true;
    poller.Start();
  }

  static void ReadZones(Target t, string text) {
    Match m = Regex.Match(text, "\"value\"\\s*:\\s*\"([0-9.,;\\-]*)\"");
    if (!m.Success) return;
    var values = new List<double>();
    foreach (string zone in m.Groups[1].Value.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) {
      string[] f = zone.Split(',');
      if (f.Length < 5) continue;
      double x, y, w, h;
      if (!double.TryParse(f[0], NumberStyles.Float, CultureInfo.InvariantCulture, out x) ||
          !double.TryParse(f[1], NumberStyles.Float, CultureInfo.InvariantCulture, out y) ||
          !double.TryParse(f[2], NumberStyles.Float, CultureInfo.InvariantCulture, out w) ||
          !double.TryParse(f[3], NumberStyles.Float, CultureInfo.InvariantCulture, out h)) continue;
      // page pixels to real screen pixels, with a little margin so an edge click still counts
      double margin = 4 * t.Scale;
      values.Add(t.X + x * t.Scale - margin);
      values.Add(t.Y + y * t.Scale - margin);
      values.Add(w * t.Scale + 2 * margin);
      values.Add(h * t.Scale + 2 * margin);
      values.Add(f[4] == "1" ? 1 : 0);
    }
    t.Zones = values.ToArray();
    t.ZonesAt = DateTime.UtcNow;
  }

  public static string State() {
    var o = new StringBuilder();
    lock (targets)
      foreach (var t in targets)
        o.Append("port " + t.Port + ": " + (t.Ws == null ? "not connected" : t.Ws.State.ToString()) + ", scale " + t.Scale +
          ", zones " + (t.Zones == null ? "none" : (t.Zones.Length / 5) + " (" + (int)(DateTime.UtcNow - t.ZonesAt).TotalSeconds + "s old)") + "; ");
    return o.ToString();
  }

  static void CdpMouse(Target t, string type, int x, int y, string button, int buttons, string extra) {
    Cdp(t, "Input.dispatchMouseEvent", "{\"type\":\"" + type + "\",\"x\":" + Num((x - t.X) / t.Scale) + ",\"y\":" + Num((y - t.Y) / t.Scale) +
      ",\"button\":\"" + button + "\",\"buttons\":" + buttons + extra + "}");
  }

  public static bool Start() {
    if (mouseHook != IntPtr.Zero) return true;
    var ready = new ManualResetEvent(false);
    var thread = new Thread(delegate () {
      IntPtr module = GetModuleHandle(null);
      mouseHook = SetWindowsHookEx(14, mouseProc, module, 0);   // WH_MOUSE_LL
      keyHook = SetWindowsHookEx(13, keyProc, module, 0);       // WH_KEYBOARD_LL
      ready.Set();
      MSG m;
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    });
    thread.IsBackground = true;
    thread.Start();
    ready.WaitOne(3000);
    return mouseHook != IntPtr.Zero;
  }

  static bool IsDesktop(string cls) {
    return cls == "SysListView32" || cls == "SHELLDLL_DefView" || cls == "WorkerW" || cls == "Progman";
  }

  static Target TargetAt(int x, int y) {
    lock (targets)
      foreach (var t in targets)
        if (x >= t.X && x < t.X + t.W && y >= t.Y && y < t.Y + t.H) return t;
    return null;
  }

  // The part of the page that takes the input: Chromium's render widget inside the browser window.
  static IntPtr RenderOf(Target t) {
    if (t.Render != IntPtr.Zero && IsWindow(t.Render)) return t.Render;
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(t.Top, delegate (IntPtr h, IntPtr l) {
      if (NovaDesk.ClassOf(h) == "Chrome_RenderWidgetHostHWND") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    t.Render = found;
    return found;
  }

  static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      int msg = wParam.ToInt32();
      if (msg == 0x200 || msg == 0x201 || msg == 0x202 || msg == 0x204 || msg == 0x205 || msg == 0x20A) {
        try {
          var s = (MSLL)Marshal.PtrToStructure(lParam, typeof(MSLL));
          if (Forward) Pass(msg, s); else LegacyClick(msg, s);
        } catch (Exception) { }
      }
    }
    return CallNextHookEx(mouseHook, code, wParam, lParam);
  }

  // Where the page has something to click: the sphere in the middle, and the input field with its buttons at
  // the bottom. Everywhere else the desktop belongs to Windows alone (selecting, dragging, dropping icons).
  static bool InZone(Target t, int x, int y) {
    bool typing;
    return InZone(t, x, y, out typing);
  }

  static bool InZone(Target t, int x, int y, out bool typing) {
    typing = false;
    double[] z = t.Zones;
    if (z != null && (DateTime.UtcNow - t.ZonesAt).TotalSeconds < 5) {
      bool hit = false;
      for (int i = 0; i + 4 < z.Length; i += 5)
        if (x >= z[i] && x <= z[i] + z[i + 2] && y >= z[i + 1] && y <= z[i + 1] + z[i + 3]) {
          hit = true;
          if (z[i + 4] == 1) typing = true;
        }
      return hit;
    }
    // Without word from the page: the sphere and the input field area.
    int bandTop = t.Y + t.H - t.TaskbarPx - (int)(150 * t.Scale), bandBottom = t.Y + t.H - t.TaskbarPx + (int)(10 * t.Scale);
    typing = y >= bandTop && y <= bandBottom;
    long dx = x - (t.X + t.W / 2), dy = y - (t.Y + (int)(t.H * 0.4));
    long r = (long)(t.H * 0.24);
    if (dx * dx + dy * dy <= r * r) return true;
    int bottom = t.Y + t.H - t.TaskbarPx + (int)(10 * t.Scale);
    int top = bottom - (int)(240 * t.Scale);   // the input field and the quick buttons above it
    return y >= top && y <= bottom && Math.Abs(x - (t.X + t.W / 2)) <= (int)(360 * t.Scale);
  }

  static void Pass(int msg, MSLL s) {
    if (msg == 0x204 || msg == 0x205) return;   // right button: always Windows' own menu
    if (msg == 0x200 && (DateTime.UtcNow - lastMove).TotalMilliseconds < 16) return;
    Target t = TargetAt(s.pt.X, s.pt.Y);
    if (t == null) { if (msg == 0x202) leftDown = false; if (msg == 0x201) armed = null; return; }
    // Only the bare desktop: a window on top keeps its own clicks.
    if (!IsDesktop(NovaDesk.ClassOf(WindowFromPoint(s.pt)))) { if (msg == 0x202) leftDown = false; return; }
    bool zone = InZone(t, s.pt.X, s.pt.Y);
    // A press that started outside the zone (selecting, dragging an icon) is never passed on, wherever it ends.
    if (msg == 0x200 && !leftDown && !zone && !hovering) return;
    if (msg == 0x201 && !zone) { armed = null; return; }
    if (msg == 0x202 && !leftDown) return;
    if (msg == 0x20A && !zone) return;
    if (Live(t)) {
      if (msg == 0x200) {
        lastMove = DateTime.UtcNow;
        hovering = zone;
        CdpMouse(t, "mouseMoved", s.pt.X, s.pt.Y, leftDown ? "left" : "none", leftDown ? 1 : 0, "");
      }
      else if (msg == 0x201) {
        leftDown = true;
        CdpMouse(t, "mouseMoved", s.pt.X, s.pt.Y, "none", 0, "");
        CdpMouse(t, "mousePressed", s.pt.X, s.pt.Y, "left", 1, ",\"clickCount\":1");
        Arm(t, s.pt.X, s.pt.Y);
      }
      else if (msg == 0x202) {
        leftDown = false;
        CdpMouse(t, "mouseReleased", s.pt.X, s.pt.Y, "left", 0, ",\"clickCount\":1");
      }
      else if (msg == 0x20A) {
        int wheel = (short)(s.mouseData >> 16);
        CdpMouse(t, "mouseWheel", s.pt.X, s.pt.Y, "none", 0, ",\"deltaX\":0,\"deltaY\":" + (-wheel));
      }
      return;
    }
    IntPtr render = RenderOf(t);
    if (render == IntPtr.Zero) return;
    int x = s.pt.X - t.X, y = s.pt.Y - t.Y;
    IntPtr at = new IntPtr((y << 16) | (x & 0xFFFF));
    if (msg == 0x200) {
      lastMove = DateTime.UtcNow;
      hovering = zone;
      PostMessage(render, 0x200, new IntPtr(leftDown ? 1 : 0), at);
    }
    else if (msg == 0x201) {
      leftDown = true;
      // The real pointer is over the desktop, so Edge has no idea where the mouse is. Telling it right before
      // the press makes it hit the right element every time instead of now and then.
      PostMessage(render, 0x200, IntPtr.Zero, at);
      PostMessage(render, 0x201, new IntPtr(1), at);
      Arm(t, s.pt.X, s.pt.Y);
      if (armed == t) {
        PostMessage(t.Top, 0x86, new IntPtr(1), IntPtr.Zero);   // WM_NCACTIVATE
        PostMessage(render, 0x7, IntPtr.Zero, IntPtr.Zero);     // WM_SETFOCUS
      }
    }
    else if (msg == 0x202) {
      leftDown = false;
      PostMessage(render, 0x200, new IntPtr(1), at);
      PostMessage(render, 0x202, IntPtr.Zero, at);
    }
    else if (msg == 0x20A) {
      int delta = (short)(s.mouseData >> 16);
      PostMessage(render, 0x20A, new IntPtr((delta << 16) | (leftDown ? 1 : 0)), new IntPtr((s.pt.Y << 16) | (s.pt.X & 0xFFFF)));
    }
  }

  // A click on the input field hands the keyboard to the page until Esc or a click elsewhere.
  static void Arm(Target t, int x, int y) {
    bool typing;
    InZone(t, x, y, out typing);
    if (typing) { armed = t; armedAt = DateTime.UtcNow; }
    else armed = null;
  }

  static readonly Dictionary<uint, string> Named = new Dictionary<uint, string> {
    { 8, "Backspace" }, { 9, "Tab" }, { 13, "Enter" }, { 46, "Delete" }, { 35, "End" }, { 36, "Home" },
    { 37, "ArrowLeft" }, { 38, "ArrowUp" }, { 39, "ArrowRight" }, { 40, "ArrowDown" }
  };
  static readonly Dictionary<uint, string> Shortcuts = new Dictionary<uint, string> {
    { 0x41, "selectAll" }, { 0x43, "copy" }, { 0x56, "paste" }, { 0x58, "cut" }, { 0x5A, "undo" }
  };

  static void CdpKey(Target t, KBD k, bool down, string text, bool control) {
    string vk = ",\"windowsVirtualKeyCode\":" + k.vk + ",\"nativeVirtualKeyCode\":" + k.vk;
    if (!down) { Cdp(t, "Input.dispatchKeyEvent", "{\"type\":\"keyUp\"" + vk + "}"); return; }
    string name;
    string command;
    if (control && Shortcuts.TryGetValue(k.vk, out command)) {
      Cdp(t, "Input.dispatchKeyEvent", "{\"type\":\"rawKeyDown\",\"modifiers\":2" + vk + ",\"commands\":[\"" + command + "\"]}");
    } else if (Named.TryGetValue(k.vk, out name)) {
      string enter = k.vk == 13 ? ",\"text\":\"\\r\"" : "";
      Cdp(t, "Input.dispatchKeyEvent", "{\"type\":\"" + (k.vk == 13 ? "keyDown" : "rawKeyDown") + "\",\"key\":\"" + name + "\",\"code\":\"" + name + "\"" + vk + enter + "}");
    } else if (!string.IsNullOrEmpty(text)) {
      Cdp(t, "Input.dispatchKeyEvent", "{\"type\":\"keyDown\",\"text\":" + Json(text) + ",\"unmodifiedText\":" + Json(text) + ",\"key\":" + Json(text) + vk + "}");
    }
  }

  static IntPtr KeyHook(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0 && armed != null) {
      try {
        if ((DateTime.UtcNow - armedAt).TotalSeconds > 120) armed = null;
        else if (Key(wParam.ToInt32(), (KBD)Marshal.PtrToStructure(lParam, typeof(KBD)))) return new IntPtr(1);
      } catch (Exception) { }
    }
    return CallNextHookEx(keyHook, code, wParam, lParam);
  }

  static bool Key(int msg, KBD k) {
    // Only while the desktop itself has the focus, so typing in any window is never taken.
    string foreground = NovaDesk.ClassOf(GetForegroundWindow());
    if (foreground != "Progman" && foreground != "WorkerW") return false;
    bool down = msg == 0x100 || msg == 0x104, up = msg == 0x101 || msg == 0x105;
    if (!down && !up) return false;
    if (k.vk == 0x1B && down) { armed = null; return false; }   // Esc ends typing and still reaches the desktop
    armedAt = DateTime.UtcNow;
    bool ctrl = (GetKeyState(0x11) & 0x8000) != 0, altKey = (GetKeyState(0x12) & 0x8000) != 0;
    if (Live(armed)) {
      CdpKey(armed, k, down, down && (!ctrl || altKey) ? Typed(k, ctrl, altKey) : null, ctrl && !altKey);
      return true;
    }
    IntPtr render = RenderOf(armed);
    if (render == IntPtr.Zero) return false;
    int extended = (k.flags & 1) != 0 ? 1 << 24 : 0;
    int bits = 1 | ((int)k.scan << 16) | extended;
    if (up) {
      PostMessage(render, 0x101, new IntPtr((int)k.vk), new IntPtr(bits | (1 << 30) | unchecked((int)(1u << 31))));
      return true;
    }
    // One key, one character: Edge turns a key-down into a character by itself, so a printable key is sent
    // only as its character, and only the named keys (Enter, Backspace, arrows, ...) as a key-down.
    string typed = (!ctrl || altKey) ? Typed(k, ctrl, altKey) : null;
    if (Named.ContainsKey(k.vk) || string.IsNullOrEmpty(typed) || typed[0] < 32)
      PostMessage(render, 0x100, new IntPtr((int)k.vk), new IntPtr(bits));
    else
      foreach (char c in typed) PostMessage(render, 0x102, new IntPtr((int)c), new IntPtr(bits));
    return true;
  }

  // The text a key produces with the current keyboard layout and Shift/Caps/AltGr state.
  static string Typed(KBD k, bool control, bool alt) {
    var state = new byte[256];
    if ((GetKeyState(0x10) & 0x8000) != 0) state[0x10] = 0x80;
    if ((GetKeyState(0x14) & 1) != 0) state[0x14] = 1;
    if (control) state[0x11] = 0x80;
    if (alt) state[0x12] = 0x80;
    uint pid;
    uint thread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    var text = new System.Text.StringBuilder(8);
    int n = ToUnicodeEx(k.vk, k.scan, state, text, 8, 4, GetKeyboardLayout(thread));
    return n > 0 ? text.ToString(0, n) : null;
  }

  // ---- fallback: a click on the sphere opens a small NOVA window ----
  static void LegacyClick(int msg, MSLL s) {
    if (msg == 0x201) { leftDown = true; downX = s.pt.X; downY = s.pt.Y; }
    else if (msg == 0x202 && leftDown) {
      leftDown = false;
      if (Math.Abs(s.pt.X - downX) <= 6 && Math.Abs(s.pt.Y - downY) <= 6) CheckRegion(s.pt);
    }
  }

  static void CheckRegion(POINT pt) {
    int[] r = Regions;
    bool inside = false;
    for (int i = 0; i + 2 < r.Length; i += 3) {
      long dx = pt.X - r[i], dy = pt.Y - r[i + 1];
      if (dx * dx + dy * dy <= (long)r[i + 2] * r[i + 2]) inside = true;
    }
    if (!inside || !IsDesktop(NovaDesk.ClassOf(WindowFromPoint(pt)))) return;
    ThreadPool.QueueUserWorkItem(delegate { OpenAssistant(pt); });
  }

  static void OpenAssistant(POINT pt) {
    try {
      lock (gate) {
        if (assistant != null && !assistant.HasExited) {
          IntPtr existing = assistant.MainWindowHandle;
          if (existing != IntPtr.Zero) { ShowWindow(existing, 9); SetForegroundWindow(existing); return; }
        }
        if (EdgePath == "") return;
        assistant = Process.Start(new ProcessStartInfo(EdgePath, Arguments) { UseShellExecute = false });
      }
      IntPtr window = IntPtr.Zero;
      for (int i = 0; i < 40 && window == IntPtr.Zero; i++) {
        Thread.Sleep(250);
        try { assistant.Refresh(); window = assistant.MainWindowHandle; } catch (Exception) { }
      }
      if (window == IntPtr.Zero) return;
      var info = new MONITORINFO();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromPoint(pt, 2), ref info)) return;
      double scale = GetDpiForWindow(window) / 96.0;
      int width = (int)(480 * scale), height = (int)(760 * scale), margin = (int)(24 * scale);
      MoveWindow(window, info.rcWork.Right - width - margin, info.rcWork.Bottom - height - margin, width, height, true);
      SetForegroundWindow(window);
    } catch (Exception) { }
  }
}
'@ -IgnoreWarnings
[NovaDesk]::RealPixels()
Add-Type -AssemblyName System.Windows.Forms
$wallpaperStore = Join-Path $PSScriptRoot 'wallpaper.json'
$script:placed = @{}
$novaPort = if ($config.novaPort) { [int]$config.novaPort } else { 8080 }
$edgeExe = (Get-Command msedge.exe -ErrorAction SilentlyContinue).Source
if (-not $edgeExe) {
  $edgeExe = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Get-WallpaperState {
  $state = @{}
  if (Test-Path $wallpaperStore) {
    try { (Get-Content -Raw $wallpaperStore | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value } } catch { }
  }
  return $state
}
function Save-WallpaperState($state) { $state | ConvertTo-Json -Depth 4 | Set-Content -Path $wallpaperStore -Encoding UTF8 }
function Get-Tag($screen) { return 'nova-wallpaper-' + ($screen.DeviceName -replace '[^A-Za-z0-9]', '') }
function Get-WallpaperEdge($screen) {
  $tag = Get-Tag $screen
  Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$tag*" }
}
function Stop-WallpaperEdge($screen) {
  Get-WallpaperEdge $screen | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Get-Displays {
  $state = Get-WallpaperState
  $i = 0
  return @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    $i++
    $entry = $state[$_.DeviceName]
    [ordered]@{
      index = $i; name = $_.DeviceName; primary = $_.Primary
      width = $_.Bounds.Width; height = $_.Bounds.Height; x = $_.Bounds.X; y = $_.Bounds.Y
      mode = $(if ($entry) { [string]$entry.mode } else { 'off' })
    }
  })
}
function Set-DisplayWallpaper($screen, [string]$mode, [string]$baseUrl) {
  Stop-WallpaperEdge $screen
  [NovaClick]::RemoveTarget([int]$screen.Bounds.X, [int]$screen.Bounds.Y)
  if ($mode -eq 'off') { return }
  if (-not $edgeExe) { throw 'Microsoft Edge is not installed on this PC' }
  $b = $screen.Bounds
  $taskbar = [Math]::Max(0, $b.Height - $screen.WorkingArea.Height)
  if ($taskbar -eq 0) { $taskbar = 48 }
  # talk=1: the page keeps its input field and microphone; taskbarpx lifts the field above the taskbar.
  $address = "$baseUrl/?wallpaper=1&talk=1&taskbarpx=$taskbar" + $(if ($mode -eq 'sphere') { '&panels=0' } else { '' })
  $profileDir = Join-Path $PSScriptRoot ('wallpaper-profiles\' + (Get-Tag $screen))
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  # Each display's window gets its own control port, reachable from this PC only.
  $port = 9330
  $all = [System.Windows.Forms.Screen]::AllScreens
  for ($n = 0; $n -lt $all.Count; $n++) { if ($all[$n].DeviceName -eq $screen.DeviceName) { $port = 9331 + $n } }
  # Kiosk: no title bar, no toolbar, the page alone. (An --app window keeps a title bar that pushes the page down.)
  Start-Process -FilePath $edgeExe -ArgumentList @(
    '--kiosk', $address, '--edge-kiosk-type=fullscreen', "--user-data-dir=`"$profileDir`"",
    "--window-position=$($b.X),$($b.Y)", "--window-size=$($b.Width),$($b.Height)",
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
    "--unsafely-treat-insecure-origin-as-secure=$baseUrl", '--use-fake-ui-for-media-stream', "--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1'
  ) | Out-Null
  $handle = [IntPtr]::Zero
  for ($i = 0; $i -lt 60 -and $handle -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 500
    $ids = @(Get-WallpaperEdge $screen | ForEach-Object { $_.ProcessId })
    if ($ids.Count -eq 0) { continue }
    $window = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($window) { $handle = $window.MainWindowHandle }
  }
  if ($handle -eq [IntPtr]::Zero) {
    Stop-WallpaperEdge $screen
    throw "The wallpaper window did not open. Is $baseUrl reachable from this PC?"
  }
  $desk = [IntPtr]::Zero
  $kind = [int]0
  $after = [IntPtr]::Zero
  for ($i = 0; $i -lt 30 -and $desk -eq [IntPtr]::Zero; $i++) {
    $desk = [NovaDesk]::Find([ref]$kind, [ref]$after)
    if ($desk -eq [IntPtr]::Zero) { Start-Sleep -Seconds 1 }
  }
  if ($desk -eq [IntPtr]::Zero -or $kind -eq 0) {
    Stop-WallpaperEdge $screen
    $build = (Get-CimInstance Win32_OperatingSystem).BuildNumber
    throw "The desktop layout of this Windows (build $build) is not recognised, so no window was placed on top of your screen"
  }
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  [void][NovaDesk]::SetWindowLong($handle, -16, 0x50000000)   # WS_CHILD | WS_VISIBLE: no title bar or border
  [void][NovaDesk]::SetParent($handle, $desk)
  [void][NovaDesk]::SetWindowPos($handle, $after, $b.X - $virtual.X, $b.Y - $virtual.Y, $b.Width, $b.Height, 0x0070)   # no activate, show, and the frame is recalculated
  [NovaClick]::AddTarget($handle, [int]$b.X, [int]$b.Y, [int]$b.Width, [int]$b.Height, [int]$taskbar, [int]$port)
  [NovaDesk]::KeepBehindIcons($handle)
  $script:placed[$screen.DeviceName] = @{ handle = $handle; kind = $kind; expected = "$($b.X - $virtual.X),$($b.Y - $virtual.Y),$($b.Width)x$($b.Height) (virtual origin $($virtual.X),$($virtual.Y))" }
  if ([NovaDesk]::GetParent($handle) -ne $desk) {
    Stop-WallpaperEdge $screen
    throw 'Windows did not accept the wallpaper window behind the desktop'
  }
}

function Update-ClickRegions {
  [NovaClick]::Forward = ([string]$config.wallpaperInput -ne 'window')
  $state = Get-WallpaperState
  $regions = New-Object System.Collections.Generic.List[int]
  $base = ''
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $entry = $state[$screen.DeviceName]
    if (-not $entry) { continue }
    $base = [string]$entry.url
    $b = $screen.Bounds
    # The sphere sits in the middle, a little above the centre of the screen.
    $regions.Add([int]($b.X + $b.Width / 2)); $regions.Add([int]($b.Y + $b.Height * 0.4)); $regions.Add([int]($b.Height * 0.24))
  }
  [NovaClick]::Regions = $regions.ToArray()
  if ($base -and $edgeExe) {
    $profile = Join-Path $PSScriptRoot 'wallpaper-profiles\nova-assistant'
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    [NovaClick]::EdgePath = $edgeExe
    # The page is plain http on your own network; this lets the microphone work there without a certificate.
    [NovaClick]::Arguments = "--app=$base/?assistant=1 --user-data-dir=`"$profile`" --unsafely-treat-insecure-origin-as-secure=$base --no-first-run --no-default-browser-check --disable-extensions --window-size=480,760"
  }
}
function Set-Wallpaper($display, [string]$mode, [string]$baseUrl) {
  if (@('off', 'full', 'sphere') -notcontains $mode) { throw "mode must be off, full or sphere" }
  if ($baseUrl -notmatch '^https?://[^\s/]+$') { throw 'Invalid NOVA address' }
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $chosen = @()
  if ("$display" -eq '0' -or "$display" -eq 'all') { $chosen = @($screens) }
  else {
    $n = [int]$display
    if ($n -lt 1 -or $n -gt $screens.Count) { throw "There is no display $display (this PC has $($screens.Count))" }
    $chosen = @($screens[$n - 1])
  }
  $state = Get-WallpaperState
  foreach ($screen in $chosen) {
    Set-DisplayWallpaper $screen $mode $baseUrl
    if ($mode -eq 'off') { $state.Remove($screen.DeviceName) }
    else { $state[$screen.DeviceName] = @{ mode = $mode; url = $baseUrl } }
  }
  Save-WallpaperState $state
  Update-ClickRegions
}
function Restore-Wallpapers {
  $state = Get-WallpaperState
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $entry = $state[$screen.DeviceName]
    if ($entry) { try { Set-DisplayWallpaper $screen ([string]$entry.mode) ([string]$entry.url) } catch { Write-Host "Wallpaper: $($_.Exception.Message)" } }
  }
  Update-ClickRegions
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()
Write-Host "Jarvis agent listening on port $Port"
try { if (-not [NovaClick]::Start()) { Write-Host 'Click hook not available' } } catch { Write-Host "Click hook: $($_.Exception.Message)" }
Restore-Wallpapers
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $remote = $ctx.Request.RemoteEndPoint.Address.ToString()
    if ($allowedIps.Count -gt 0 -and $allowedIps -notcontains $remote) { Send $ctx 403 @{ ok = $false; error = 'Source not allowed' }; continue }
    if (-not (Test-Token ($ctx.Request.Headers['Authorization'] -replace '^Bearer ', ''))) { Send $ctx 401 @{ ok = $false; error = 'Unauthorized' }; continue }
    $path = $ctx.Request.Url.AbsolutePath
    switch ($path) {
      '/v1/status' {
        $running = @($apps.Keys | Where-Object { $p = $apps[$_].process; $p -and (Get-Process -Name $p -ErrorAction SilentlyContinue) })
        $os = Get-CimInstance Win32_OperatingSystem
        Send $ctx 200 @{ ok = $true; hostname = $env:COMPUTERNAME; user = $env:USERNAME; uptimeHours = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1); features = @('wallpaper'); agent = $agentVersion; apps = @($apps.Keys | Sort-Object); running = $running }
      }
      '/v1/open-app' {
        $app = Get-App (Read-Body $ctx).app
        Start-Process -FilePath $app.path
        Send $ctx 200 @{ ok = $true }
      }
      '/v1/close-app' {
        $body = Read-Body $ctx
        $app = Get-App $body.app
        if (-not $app.process) { throw 'This app cannot be closed by the agent' }
        $procs = @(Get-Process -Name $app.process -ErrorAction SilentlyContinue)
        $procs | ForEach-Object { [void]$_.CloseMainWindow() }
        Send $ctx 200 @{ ok = $true; closed = $procs.Count }
      }
      '/v1/open-url' {
        $url = [string](Read-Body $ctx).url
        if ($url -notmatch '^https?://[^\s]+$') { throw 'Only http(s) URLs are allowed' }
        Start-Process -FilePath $url
        Send $ctx 200 @{ ok = $true }
      }
      '/v1/lock' {
        Start-Process -FilePath 'rundll32.exe' -ArgumentList 'user32.dll,LockWorkStation'
        Send $ctx 200 @{ ok = $true }
      }
      '/v1/wallpaper-debug' {
        $os = Get-CimInstance Win32_OperatingSystem
        $details = @($script:placed.Keys | ForEach-Object {
          $p = $script:placed[$_]
          @{ display = $_; kind = $p.kind; expected = $p.expected; desktop = [NovaDesk]::Describe([IntPtr]$p.handle) }
        })
        Send $ctx 200 @{ ok = $true; agent = $agentVersion; build = $os.BuildNumber; version = $os.Version; forward = [NovaClick]::Forward; corrections = [NovaDesk]::Corrections; input = [NovaClick]::State(); placed = $details }
      }
      '/v1/displays' {
        Send $ctx 200 @{ ok = $true; displays = @(Get-Displays) }
      }
      '/v1/wallpaper' {
        $body = Read-Body $ctx
        # The NOVA address defaults to the machine that is calling, on the web port.
        $base = if ($body.url) { [string]$body.url } else { "http://${remote}:$novaPort" }
        Set-Wallpaper $body.display ([string]$body.mode) $base
        Send $ctx 200 @{ ok = $true; displays = @(Get-Displays) }
      }
      default { Send $ctx 404 @{ ok = $false; error = 'Not found' } }
    }
  } catch {
    try { Send $ctx 400 @{ ok = $false; error = $_.Exception.Message } } catch { }
  }
}
