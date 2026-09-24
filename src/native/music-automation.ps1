# Music search automation for the Ashley Windows shell bridge.
#
# Dot-sourced by windows-shell.ps1 after the AshleyUser32 interop type is
# loaded. Drives the real, logged-in music player window exactly like the
# macOS AppleScript implementation: focus the window, click the search box,
# paste the query through the clipboard, press Enter, click the first
# result, then confirm playback through the system media session (SMTC).
#
# The fractional offsets below are first-guess defaults; they are tuned on a
# real Windows machine using the Export-PlayerUiDebug dump (tray menu:
# 音乐搜索调试). Keep every construct PowerShell 5.1 compatible.

$script:MusicPlayerConfig = @{
    netease = @{
        displayName   = '网易云音乐'
        processNames  = @('cloudmusic')
        windowTitle   = '网易云音乐'
        searchX       = 0.70   # 搜索框中心:窗口宽度比例(待真机校准)
        searchY       = 0.06
        resultX       = 0.25   # 搜索结果第一行(待真机校准)
        resultY       = 0.18
        resultDelayMs = 2200
    }
    kugou = @{
        displayName   = '酷狗音乐'
        processNames  = @('KuGou', 'kugou')
        windowTitle   = '酷狗'
        searchX       = 0.42
        searchY       = 0.09
        resultX       = 0.22
        resultY       = 0.25
        resultDelayMs = 2500
    }
    soda = @{
        displayName   = '汽水音乐'
        processNames  = @('SodaMusic', 'soda')
        windowTitle   = '汽水音乐'
        searchX       = 0.78
        searchY       = 0.07
        resultX       = 0.25
        resultY       = 0.25
        resultDelayMs = 2500
    }
}

function Get-MusicPlayerConfig([string]$player) {
    $cfg = $script:MusicPlayerConfig[$player]
    if (-not $cfg) { throw ('unknown music player: ' + $player) }
    return $cfg
}

function Find-MusicPlayerProcess($cfg) {
    foreach ($name in $cfg.processNames) {
        $found = Get-Process -Name $name -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    return $null
}

function Normalize-PlayText([string]$text) {
    if (-not $text) { return '' }
    $normalized = $text.ToLowerInvariant()
    $normalized = $normalized -replace '\s', ''
    $normalized = $normalized -replace '[\(\)（）\[\]【】""''""''、，。.:：;；·!！?？~～\-_]', ''
    return $normalized
}

function Set-SearchClipboard([string]$text) {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.Clipboard]::SetText($text)
}

function Get-NowPlayingMatch([string]$songNorm, [string[]]$processHints) {
    try {
        [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime]
        $manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
        $sessions = $manager.GetSessions()
        foreach ($session in $sessions) {
            try {
                $appId = $session.SourceAppUserModelId
                $props = $session.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
                $title = $props.Title
                if (-not $title) { continue }
                $titleNorm = Normalize-PlayText $title
                if (-not $titleNorm.Contains($songNorm)) { continue }
                $appMatch = $false
                foreach ($hint in $processHints) {
                    if ($appId -like ('*' + $hint + '*')) { $appMatch = $true; break }
                }
                return @{ title = $title; artist = $props.Artist; app = $appId; appMatched = $appMatch }
            } catch {
                # A session can vanish mid-read; try the next one.
            }
        }
    } catch {
        # SMTC unavailable (very old Windows); verification is skipped.
    }
    return $null
}

function Invoke-MusicSearch([string]$player, [string]$query, [string]$launchAppId) {
    $cfg = Get-MusicPlayerConfig $player
    $steps = @()
    $songNorm = Normalize-PlayText ($query -split ' ')[0]

    $proc = Find-MusicPlayerProcess $cfg
    if (-not $proc) {
        if (-not $launchAppId) { throw ($cfg.displayName + ' 没有在运行,且找不到它的启动方式。') }
        $steps += 'launching'
        Start-Process explorer.exe -ArgumentList ('"' + $launchAppId + '"')
        $deadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $deadline -and -not $proc) {
            Start-Sleep -Milliseconds 500
            $proc = Find-MusicPlayerProcess $cfg
        }
        if (-not $proc) { throw ('启动 ' + $cfg.displayName + ' 后没有找到它的窗口。') }
    }
    $steps += ('process:' + $proc.ProcessName + ':' + $proc.Id)

    $hwnd = $proc.MainWindowHandle
    if ([AshleyUser32]::IsIconic($hwnd)) {
        [void][AshleyUser32]::ShowWindow($hwnd, 9) # SW_RESTORE
        Start-Sleep -Milliseconds 300
    }
    [AshleyUser32]::ForceForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    $steps += 'foregrounded'

    $rect = New-Object AshleyUser32+RECT
    if (-not [AshleyUser32]::GetWindowRect($hwnd, [ref]$rect)) {
        throw '无法读取播放器窗口位置。'
    }
    $windowWidth = $rect.Right - $rect.Left
    $windowHeight = $rect.Bottom - $rect.Top
    if ($windowWidth -lt 300 -or $windowHeight -lt 200) {
        throw ($cfg.displayName + ' 窗口太小,请把窗口恢复到普通大小后再试。')
    }

    $searchX = $rect.Left + [int]($windowWidth * $cfg.searchX)
    $searchY = $rect.Top + [int]($windowHeight * $cfg.searchY)
    [AshleyUser32]::ClickAt($searchX, $searchY)
    Start-Sleep -Milliseconds 250
    $steps += ('click-search:' + $searchX + ',' + $searchY)

    Set-SearchClipboard $query
    [AshleyUser32]::SendCombo(@([ushort]0x11, [ushort]0x41)) # Ctrl+A selects any leftover text
    Start-Sleep -Milliseconds 120
    [AshleyUser32]::SendCombo(@([ushort]0x11, [ushort]0x56)) # Ctrl+V pastes the query
    Start-Sleep -Milliseconds 150
    [AshleyUser32]::SendCombo(@([ushort]0x0D))               # Enter submits
    $steps += 'submitted'

    Start-Sleep -Milliseconds $cfg.resultDelayMs

    $resultX = $rect.Left + [int]($windowWidth * $cfg.resultX)
    $resultY = $rect.Top + [int]($windowHeight * $cfg.resultY)
    [AshleyUser32]::ClickAt($resultX, $resultY)
    $steps += ('click-result:' + $resultX + ',' + $resultY)

    $played = $false
    $observedTitle = $null
    $match = Get-NowPlayingMatch $songNorm $cfg.processNames
    $pollDeadline = (Get-Date).AddSeconds(8)
    while (-not $match -and (Get-Date) -lt $pollDeadline) {
        Start-Sleep -Milliseconds 500
        $match = Get-NowPlayingMatch $songNorm $cfg.processNames
    }
    if ($match) {
        $observedTitle = $match.title
        $played = -not [string]::IsNullOrWhiteSpace($observedTitle)
        $steps += ('smtc:' + $match.app + ':' + $observedTitle)
    } else {
        $steps += 'smtc:none'
    }

    return @{ played = $played; title = $observedTitle; steps = $steps }
}

function Export-PlayerUiDebug([string]$player, [string]$outDir) {
    $cfg = Get-MusicPlayerConfig $player
    $proc = Find-MusicPlayerProcess $cfg
    if (-not $proc) {
        throw ($cfg.displayName + ' 没有在运行。请先打开它,再导出界面信息。')
    }

    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    $hwnd = $proc.MainWindowHandle
    $rect = New-Object AshleyUser32+RECT
    if (-not [AshleyUser32]::GetWindowRect($hwnd, [ref]$rect)) {
        throw '无法读取播放器窗口位置。'
    }

    $script:uiNodes = New-Object System.Collections.ArrayList
    $script:uiInteractiveTypes = @(
        'ControlType.Edit', 'ControlType.Button', 'ControlType.ListItem',
        'ControlType.ComboBox', 'ControlType.TabItem', 'ControlType.MenuItem',
        'ControlType.Hyperlink', 'ControlType.List', 'ControlType.Document'
    )

    function Walk-UiElement($element, [int]$depth) {
        if ($depth -gt 12 -or $script:uiNodes.Count -ge 4000) { return }
        try {
            $current = $element.Current
            $include = -not [string]::IsNullOrWhiteSpace($current.Name)
            if (-not $include) {
                if ($script:uiInteractiveTypes -contains $current.ControlType.ProgrammaticName) { $include = $true }
            }
            if ($include) {
                $bounds = $current.BoundingRectangle
                $node = New-Object PSObject -Property @{
                    depth        = $depth
                    type         = $current.ControlType.ProgrammaticName
                    name         = $current.Name
                    automationId = $current.AutomationId
                    className    = $current.ClassName
                    x            = [int]$bounds.X
                    y            = [int]$bounds.Y
                    width        = [int]$bounds.Width
                    height       = [int]$bounds.Height
                }
                [void]$script:uiNodes.Add($node)
            }
            $children = $element.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($child in $children) {
                Walk-UiElement $child ($depth + 1)
            }
        } catch {
            # Skip subtrees that deny access; the dump stays partial but useful.
        }
    }

    $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if (-not $rootElement) { throw '无法读取播放器界面(UIA)。' }
    Walk-UiElement $rootElement 0

    $windowWidth = $rect.Right - $rect.Left
    $windowHeight = $rect.Bottom - $rect.Top
    $payload = New-Object PSObject -Property @{
        capturedAt        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        player            = $player
        processName       = $proc.ProcessName
        processId         = $proc.Id
        windowHandle      = $hwnd.ToInt64()
        window            = @{
            x      = $rect.Left
            y      = $rect.Top
            width  = $windowWidth
            height = $windowHeight
        }
        screen            = @{
            width  = [AshleyUser32]::GetSystemMetrics(0)
            height = [AshleyUser32]::GetSystemMetrics(1)
        }
        configuredSearch  = @{
            fraction = @{ x = $cfg.searchX; y = $cfg.searchY }
            pixels   = @{
                x = $rect.Left + [int]($windowWidth * $cfg.searchX)
                y = $rect.Top + [int]($windowHeight * $cfg.searchY)
            }
        }
        configuredResult  = @{
            fraction = @{ x = $cfg.resultX; y = $cfg.resultY }
            pixels   = @{
                x = $rect.Left + [int]($windowWidth * $cfg.resultX)
                y = $rect.Top + [int]($windowHeight * $cfg.resultY)
            }
        }
        elementCount      = $script:uiNodes.Count
        elements          = $script:uiNodes.ToArray()
    }

    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $path = Join-Path $outDir ('ui-' + $player + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
    $json = ConvertTo-Json -InputObject $payload -Depth 6
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
    return @{ path = $path; elementCount = $script:uiNodes.Count }
}
