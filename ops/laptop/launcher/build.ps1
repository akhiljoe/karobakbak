# Builds ops\laptop\karobakbak-live.exe - the double-click launcher.
#
#   powershell -ExecutionPolicy Bypass -File ops\laptop\launcher\build.ps1
#   powershell -ExecutionPolicy Bypass -File ops\laptop\launcher\build.ps1 -Shortcut
#
# -Shortcut also puts "karobakbak live" on the desktop.
#
# Uses the C# compiler that ships with the .NET Framework in Windows, so there
# is nothing to install. The exe is a build output and is gitignored: rebuild
# it after pulling a change to KarobakbakLive.cs.
#
# The icon is drawn here from the same geometry as frontend/public/favicon.svg
# (two arcs and a point on a dark plate), because a binary .ico committed beside
# the SVG would be a fourth copy of the mark that nothing keeps in step
# (CLAUDE.md: "the mark is drawn in three places and they must agree").

param([switch]$Shortcut)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Join-Path $here '..\karobakbak-live.exe' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $out) { $out = Join-Path (Resolve-Path (Join-Path $here '..')) 'karobakbak-live.exe' }
$obj = Join-Path $here 'obj'
New-Item -ItemType Directory -Force $obj | Out-Null

# Windows will not overwrite a running exe, and csc's message for it
# (CS0016, "being used by another process") does not say which process.
if (Get-Process -Name 'karobakbak-live' -ErrorAction SilentlyContinue) {
    throw 'The karobakbak live window is open. Close it (the site keeps running) and build again.'
}

# csc v4 reads a file without a byte-order mark in the Windows code page, so a
# UTF-8 character in the source compiles into mojibake - a middle dot became
# "Â·" in the persona status line. Write non-ASCII as \uXXXX escapes.
$srcLines = [System.IO.File]::ReadAllLines((Join-Path $here 'KarobakbakLive.cs'), [System.Text.Encoding]::UTF8)
for ($i = 0; $i -lt $srcLines.Length; $i++) {
    if ($srcLines[$i] -match '[^\x00-\x7F]') {
        throw "KarobakbakLive.cs line $($i + 1) has a non-ASCII character; write it as a \uXXXX escape."
    }
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    throw "The .NET Framework C# compiler was not found at $csc"
}

# ---------------------------------------------------------------------------
# The icon: PNG frames at four sizes inside one .ico
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Drawing

function New-MarkPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 48.0

    # The plate: 48x48, corner radius 11.
    $r = 11 * $s * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc($size - $r - 1, 0, $r, $r, 270, 90)
    $path.AddArc($size - $r - 1, $size - $r - 1, $r, $r, 0, 90)
    $path.AddArc(0, $size - $r - 1, $r, $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x13, 0x10, 0x0b))), $path)

    $width = [Math]::Max(1.5, 3.1 * $s)
    $amber = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(0xff, 0xb4, 0x20)), $width
    $amber.StartCap = 'Round'; $amber.EndCap = 'Round'
    $soft = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(128, 0xff, 0xc9, 0x4a)), $width
    $soft.StartCap = 'Round'; $soft.EndCap = 'Round'

    # SVG: M17.2 15.5 A 11.9 11.9 0 0 1 17.2 32.5 -> centre (8.87, 24), +-45.6 deg
    $g.DrawArc($amber, [float]((8.87 - 11.9) * $s), [float]((24 - 11.9) * $s), [float](23.8 * $s), [float](23.8 * $s), -45.6, 91.2)
    # SVG: M31.2 18.6 A 8.6 8.6 0 0 0 31.2 29.4 -> centre (37.89, 24), 141.1..218.9 deg
    $g.DrawArc($soft, [float]((37.89 - 8.6) * $s), [float]((24 - 8.6) * $s), [float](17.2 * $s), [float](17.2 * $s), 141.1, 77.8)
    # The point between them.
    $dot = 1.5 * $s
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xff, 0xb4, 0x20))),
        [float]((25 - 1.5) * $s), [float]((24 - 1.5) * $s), [float](2 * $dot), [float](2 * $dot))

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

$sizes = 16, 32, 48, 256
$frames = @($sizes | ForEach-Object { ,(New-MarkPng $_) })
$ico = Join-Path $obj 'karobakbak.ico'
$fs = [System.IO.File]::Create($ico)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([Byte]$dim); $w.Write([Byte]$dim); $w.Write([Byte]0); $w.Write([Byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$frames[$i].Length); $w.Write([UInt32]$offset)
    $offset += $frames[$i].Length
}
foreach ($f in $frames) { $w.Write([byte[]]$f) }
$w.Close()

# ---------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------
$src = Join-Path $here 'KarobakbakLive.cs'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    "/out:$out" "/win32icon:$ico" `
    /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
    $src
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "Built $out" -ForegroundColor Green

if ($Shortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $link = Join-Path $desktop 'karobakbak live.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($link)
    $s.TargetPath = "$out"
    $s.WorkingDirectory = Split-Path "$out"
    $s.IconLocation = "$out,0"
    $s.Description = 'Start karobakbak.com on this host'
    $s.Save()
    Write-Host "Shortcut: $link" -ForegroundColor Green
}
