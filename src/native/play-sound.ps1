# Plays a wav file through .NET SoundPlayer; the main process spawns this
# once per effect, fire-and-forget (same role as afplay on macOS and paplay
# on Linux). wav matches the bundled effect files; mp3 would need another API.
param(
    [Parameter(Mandatory = $true)][string]$Path
)

$player = New-Object System.Media.SoundPlayer -ArgumentList $Path
try {
    $player.PlaySync()
} finally {
    $player.Dispose()
}
