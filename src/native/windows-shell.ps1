# Ashley Windows shell bridge.
#
# Long-lived PowerShell 5.1 process spawned by the Electron main process.
# Every stdin line is one JSON request; every stdout line is one JSON response
# with the same id. Anything that must reach the Windows API (user32 window
# enumeration, SendInput, WinRT location, WScript.Shell, Get-StartApps) lives
# here so the Node side only speaks JSON. PowerShell 5.1 ships with Windows
# 10/11, so no extra toolchain is required on the user's machine.
#
# Keep this script parseable by Windows PowerShell 5.1: no ternary operator,
# no ?? / && / || pipeline operators, no using statements.

try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # Encoding setup can fail on exotic hosts; the protocol still works for
    # ASCII, only non-ASCII app names would garble.
}

$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AshleyUser32
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);

    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    public struct INPUT
    {
        public uint type;
        public INPUTUNION union;
    }

    // Mirrors the Swift window-status helper: a normal visible app/document
    // window of reasonable size means the desktop is "occupied".
    public static bool HasVisibleAppWindow(int excludedPid)
    {
        bool found = false;
        int excluded = excludedPid;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (found) { return false; }
            if (!IsWindowVisible(hWnd)) { return true; }
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if ((int)pid == excluded) { return true; }
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) { return true; }
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width < 100 || height < 80) { return true; }
            // Tool windows (overlay widgets, tray popups) are not apps.
            int exStyle = GetWindowLong(hWnd, -20); // GWL_EXSTYLE
            if ((exStyle & 0x80) != 0) { return true; } // WS_EX_TOOLWINDOW
            // The desktop, taskbars and their layers are shell furniture,
            // not applications covering the avatar.
            StringBuilder className = new StringBuilder(256);
            if (GetClassName(hWnd, className, className.Capacity) > 0)
            {
                string cls = className.ToString();
                if (cls == "Progman" || cls == "WorkerW" ||
                    cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" ||
                    cls == "NotifyIconOverflowWindow" || cls == "Windows.UI.Input.InputSite.WindowClass")
                {
                    return true;
                }
            }
            // Cloaked windows (Win+Tab switcher, snapped-away UWP) are not
            // actually presenting on this desktop.
            int cloaked = 0;
            if (DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0)
            {
                return true;
            }
            found = true;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // Presses a key combination in a single SendInput call so every key event
    // lands in one input frame, then releases in reverse order.
    public static void SendCombo(ushort[] keys)
    {
        int n = keys.Length;
        INPUT[] inputs = new INPUT[n * 2];
        for (int i = 0; i < n; i++)
        {
            inputs[i] = KeyEvent(keys[i], false);
        }
        for (int i = 0; i < n; i++)
        {
            inputs[n + i] = KeyEvent(keys[n - 1 - i], true);
        }
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    // SetForegroundWindow is ignored when the caller does not own the
    // foreground; attaching to the foreground thread borrows its right.
    public static void ForceForegroundWindow(IntPtr hWnd)
    {
        IntPtr foregroundHandle = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foregroundHandle, out uint ignoredPid);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != currentThread)
        {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }
        SetForegroundWindow(hWnd);
        if (attached)
        {
            AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    // Clicks a point given in physical screen pixels, mapped onto the whole
    // virtual desktop so multi-monitor layouts behave.
    public static void ClickAt(int x, int y)
    {
        int screenWidth = GetSystemMetrics(0);
        int screenHeight = GetSystemMetrics(1);
        if (screenWidth <= 1 || screenHeight <= 1) { return; }
        INPUT[] inputs = new INPUT[3];
        uint absolute = 0x8000 | 0x4000; // ABSOLUTE | VIRTUALDESK
        inputs[0] = MouseEvent(absolute, (x * 65535) / (screenWidth - 1), (y * 65535) / (screenHeight - 1));
        inputs[1] = MouseEvent(0x0002, 0, 0); // LEFTDOWN
        inputs[2] = MouseEvent(0x0004, 0, 0); // LEFTUP
        SendInput(3, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static INPUT MouseEvent(uint flags, int dx, int dy)
    {
        INPUT input = new INPUT();
        input.type = 0; // INPUT_MOUSE
        MOUSEINPUT mi = new MOUSEINPUT();
        mi.dx = dx;
        mi.dy = dy;
        mi.mouseData = 0;
        mi.dwFlags = flags;
        mi.time = 0;
        mi.dwExtraInfo = IntPtr.Zero;
        input.union.mi = mi;
        return input;
    }

    private static INPUT KeyEvent(ushort vk, bool keyUp)
    {
        INPUT input = new INPUT();
        input.type = 1; // INPUT_KEYBOARD
        KEYBDINPUT ki = new KEYBDINPUT();
        ki.wVk = vk;
        ki.wScan = 0;
        ki.dwFlags = keyUp ? 2u : 0u; // KEYEVENTF_KEYUP
        ki.time = 0;
        ki.dwExtraInfo = IntPtr.Zero;
        input.union.ki = ki;
        return input;
    }
}
'@

function Write-Response($payload) {
    $json = ConvertTo-Json -InputObject $payload -Depth 5 -Compress
    [Console]::Out.WriteLine($json)
}

function Get-ErrorPayload($id, $error) {
    $message = $error
    if ($null -ne $error -and $null -ne $error.Exception) { $message = $error.Exception.Message }
    if ($null -eq $message) { $message = 'unknown error' }
    $message = [string]$message -replace "`r?`n", ' '
    New-Object PSObject -Property @{ id = $id; ok = $false; error = $message }
}

try {
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop
} catch {
    Write-Response (New-Object PSObject -Property @{ ready = $false; error = ('native interop unavailable: ' + $_.Exception.Message) })
    exit 1
}

# Work with physical pixels so window rects, UIA bounds and SendInput agree.
try { [void][AshleyUser32]::SetProcessDpiAwareness(2) } catch { }

# Music player automation (search, playback confirmation, UI debug dumps).
. (Join-Path $PSScriptRoot 'music-automation.ps1')

$ownPid = $args[0]
if ($null -eq $ownPid -or $ownPid -eq '') { $ownPid = '0' }

$mediaKeyMap = @{
    play_pause = [ushort]0xB3
    next       = [ushort]0xB0
    previous   = [ushort]0xB1
}

function Invoke-ShellCommand($request) {
    $id = $request.id
    switch ($request.cmd) {
        'check' {
            $occupied = [AshleyUser32]::HasVisibleAppWindow([int]$ownPid)
            New-Object PSObject -Property @{ id = $id; ok = $true; state = $(if ($occupied) { 'occupied' } else { 'clear' }) }
        }
        'media' {
            $key = [string]$request.args.key
            if (-not $mediaKeyMap.ContainsKey($key)) { throw ('unknown media key: ' + $key) }
            [AshleyUser32]::SendCombo(@($mediaKeyMap[$key]))
            New-Object PSObject -Property @{ id = $id; ok = $true }
        }
        'desktop' {
            $left = @( [ushort]0x11, [ushort]0x5B, [ushort]0x25 )  # Ctrl + Win + Left
            $right = @( [ushort]0x11, [ushort]0x5B, [ushort]0x27 ) # Ctrl + Win + Right
            $destination = [string]$request.args.destination
            if ($destination -eq 'next') {
                [AshleyUser32]::SendCombo($right)
            } elseif ($destination -eq 'previous') {
                [AshleyUser32]::SendCombo($left)
            } else {
                # Absolute targets walk all the way left first, matching the
                # macOS Spaces implementation.
                for ($i = 0; $i -lt 12; $i++) {
                    [AshleyUser32]::SendCombo($left)
                    Start-Sleep -Milliseconds 60
                }
                if ($destination -eq 'second') {
                    Start-Sleep -Milliseconds 60
                    [AshleyUser32]::SendCombo($right)
                }
            }
            New-Object PSObject -Property @{ id = $id; ok = $true }
        }
        'apps' {
            $apps = Get-StartApps | ForEach-Object {
                New-Object PSObject -Property @{ name = $_.Name; appId = $_.AppID }
            }
            New-Object PSObject -Property @{ id = $id; ok = $true; apps = @($apps) }
        }
        'resolve' {
            $shell = New-Object -ComObject WScript.Shell
            try {
                $shortcut = $shell.CreateShortcut([string]$request.args.appId)
                New-Object PSObject -Property @{ id = $id; ok = $true; target = $shortcut.TargetPath }
            } finally {
                [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
            }
        }
        'location' {
            [void][Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime]
            $locator = New-Object Windows.Devices.Geolocation.Geolocator
            $operation = $locator.GetGeopositionAsync()
            $position = $operation.GetAwaiter().GetResult()
            $coordinate = $position.Coordinate
            New-Object PSObject -Property @{
                id = $id
                ok = $true
                latitude = $coordinate.Point.Position.Latitude
                longitude = $coordinate.Point.Position.Longitude
            }
        }
        'music-search' {
            $result = Invoke-MusicSearch ([string]$request.args.player) ([string]$request.args.query) ([string]$request.args.launchAppId)
            New-Object PSObject -Property @{
                id = $id
                ok = $true
                played = $result.played
                title = $result.title
                steps = @($result.steps)
            }
        }
        'music-debug' {
            $result = Export-PlayerUiDebug ([string]$request.args.player) ([string]$request.args.outDir)
            New-Object PSObject -Property @{
                id = $id
                ok = $true
                path = $result.path
                elementCount = $result.elementCount
            }
        }
        default {
            throw ('unknown command: ' + $request.cmd)
        }
    }
}

Write-Response (New-Object PSObject -Property @{ ready = $true })

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $request = $null
    try {
        $request = ConvertFrom-Json -InputObject $line
        Write-Response (Invoke-ShellCommand $request)
    } catch {
        $id = $null
        if ($null -ne $request) { $id = $request.id }
        Write-Response (Get-ErrorPayload $id $_)
    }
}
