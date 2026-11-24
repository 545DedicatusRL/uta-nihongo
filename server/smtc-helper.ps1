# SMTC helper: a long-running process that reports one app's media session as JSON lines
# and executes simple commands read from stdin. Used by server/smtc.js.
#
# SMTC = System Media Transport Controls, the Windows media interface that apps such as QQ Music
# publish their now-playing info to (title / artist / album / play state / timeline).
# Windows PowerShell 5.1 (preinstalled) can call that WinRT API directly, so nothing has to be installed.
#
# stdout: one JSON object per line, every $IntervalMs
#   { running, proc, app, status, title, artist, album, pos, end, stamp, now, canSeek }
#   pos / end are seconds; stamp is when the app last updated pos (Unix ms, 0 = never); now is Unix ms.
# stdin: play | pause | playpause | next | prev | art <file>  (art saves the current thumbnail)
# This file is kept ASCII-only: Windows PowerShell reads BOM-less scripts in the system code page.
param([string]$Prefer = 'QQMusic.exe', [int]$IntervalMs = 250)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$out = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$out.AutoFlush = $true
$in = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Wait-WinRt($op, [Type]$type, [int]$timeoutMs = 3000) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait($timeoutMs)) { throw 'timeout' }
    $task.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
$mgr = Wait-WinRt ($mgrType::RequestAsync()) $mgrType 8000
$wanted = @($Prefer -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
$procNames = @($wanted | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_) })

function Find-Session {
    foreach ($w in $wanted) {
        foreach ($s in @($mgr.GetSessions())) { if ($s.SourceAppUserModelId.ToLowerInvariant() -eq $w) { return $s } }
    }
    $null
}
function Invoke-Command2([string]$line) {
    $parts = $line.Trim() -split ' ', 2
    $s = Find-Session
    $reply = @{ reply = $parts[0]; ok = $false }
    try {
        if ($s) {
            switch ($parts[0]) {
                'play' { $reply.ok = Wait-WinRt ($s.TryPlayAsync()) ([bool]) }
                'pause' { $reply.ok = Wait-WinRt ($s.TryPauseAsync()) ([bool]) }
                'playpause' { $reply.ok = Wait-WinRt ($s.TryTogglePlayPauseAsync()) ([bool]) }
                'next' { $reply.ok = Wait-WinRt ($s.TrySkipNextAsync()) ([bool]) }
                'prev' { $reply.ok = Wait-WinRt ($s.TrySkipPreviousAsync()) ([bool]) }
                'art' {
                    $reply.file = $parts[1]
                    $p = Wait-WinRt ($s.TryGetMediaPropertiesAsync()) $propsType
                    if ($p.Thumbnail) {
                        $ras = Wait-WinRt ($p.Thumbnail.OpenReadAsync()) $streamType
                        $src = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ras)
                        $dst = [IO.File]::Create($parts[1])
                        try { $src.CopyTo($dst) } finally { $dst.Close(); $src.Close() }
                        $reply.ok = (Get-Item $parts[1]).Length -gt 0
                    }
                }
            }
        }
    } catch { $reply.err = "$($_.Exception.Message)" }
    $out.WriteLine(($reply | ConvertTo-Json -Compress))
}

$readTask = $in.ReadLineAsync()
$tick = 0; $proc = $false
while ($true) {
    while ($readTask.IsCompleted) {
        $line = $readTask.Result
        if ($null -eq $line) { exit 0 }   # stdin closed: the server is gone
        if ($line.Trim()) { Invoke-Command2 $line }
        $readTask = $in.ReadLineAsync()
    }
    if ($tick % 8 -eq 0) { $proc = [bool](Get-Process -Name $procNames -ErrorAction SilentlyContinue) }
    $tick++
    $o = [ordered]@{ running = $false; proc = $proc }
    try {
        $s = Find-Session
        if ($s) {
            $p = Wait-WinRt ($s.TryGetMediaPropertiesAsync()) $propsType
            $info = $s.GetPlaybackInfo()
            $t = $s.GetTimelineProperties()
            $stamp = 0
            if ($t.LastUpdatedTime.Year -gt 2000) { $stamp = $t.LastUpdatedTime.ToUnixTimeMilliseconds() }
            $o.running = $true
            $o.app = $s.SourceAppUserModelId
            $o.status = "$($info.PlaybackStatus)"
            $o.title = "$($p.Title)"; $o.artist = "$($p.Artist)"; $o.album = "$($p.AlbumTitle)"
            $o.pos = [Math]::Round($t.Position.TotalSeconds, 3)
            $o.end = [Math]::Round($t.EndTime.TotalSeconds, 3)
            $o.stamp = $stamp
            $o.canSeek = [bool]$info.Controls.IsPlaybackPositionEnabled
        }
    } catch { $o.err = "$($_.Exception.Message)" }
    $o.now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $out.WriteLine(($o | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds $IntervalMs
}
