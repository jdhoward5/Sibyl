# Generates a branded multi-resolution Sibyl app icon (build/icon.ico) using
# GDI+ — no external image tooling required. The mark mirrors the in-app logo:
# an arcane diamond sigil on a midnight rounded square.
#
# The .ico embeds PNG-compressed images at 16/32/48/64/128/256 px (Vista+),
# rendered natively at each size for crispness.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path build | Out-Null

$MIDNIGHT = [System.Drawing.Color]::FromArgb(255, 0x0e, 0x0c, 0x15)
$VIOLET = [System.Drawing.Color]::FromArgb(255, 0x9a, 0x76, 0xe6)
$MOONLIGHT = [System.Drawing.Color]::FromArgb(255, 0xc7, 0xb0, 0xf4)

# Spark control points in a 24x24 viewBox (matches SparkIcon path), bbox center (12,10).
$SPARK = @(
  @(12.0, 3.0), @(13.9, 8.2), @(19.0, 10.0), @(13.9, 11.8),
  @(12.0, 17.0), @(10.1, 11.8), @(5.0, 10.0), @(10.1, 8.2)
)
$DIAMOND = @(@(12.0, 2.75), @(21.25, 12.0), @(12.0, 21.25), @(2.75, 12.0))

function New-RoundedPath([System.Drawing.RectangleF]$r, [float]$radius) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $p.AddArc($r.X, $r.Y, $d, $d, 180, 90)
  $p.AddArc($r.Right - $d, $r.Y, $d, $d, 270, 90)
  $p.AddArc($r.Right - $d, $r.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($r.X, $r.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconPng([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded-square midnight field.
  $margin = [float]([math]::Max(0.5, $S * 0.055))
  $rect = New-Object System.Drawing.RectangleF($margin, $margin, ($S - 2 * $margin), ($S - 2 * $margin))
  $radius = [float]($S * 0.225)
  $bgPath = New-RoundedPath $rect $radius
  $field = New-Object System.Drawing.SolidBrush($MIDNIGHT)
  $g.FillPath($field, $bgPath)
  $framePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, $VIOLET), [float]([math]::Max(1.0, $S * 0.014)))
  $g.DrawPath($framePen, $bgPath)

  # Helper to map a 24-box point to icon space, scaled around spark center (12,10).
  $cx = $S / 2.0; $cy = $S / 2.0
  function MapPts($pts, $sc, $ccx, $ccy, [float]$sourceCy = 10.0) {
    $out = New-Object 'System.Drawing.PointF[]' ($pts.Count)
    for ($i = 0; $i -lt $pts.Count; $i++) {
      $x = $ccx + ($pts[$i][0] - 12.0) * $sc
      $y = $ccy + ($pts[$i][1] - $sourceCy) * $sc
      $out[$i] = New-Object System.Drawing.PointF($x, $y)
    }
    return $out
  }

  # Fine diamond aperture around the central four-point star.
  $diamondScale = [float]($S * 0.033)
  [System.Drawing.PointF[]]$diamondPts = MapPts $DIAMOND $diamondScale $cx $cy 12.0
  $diamondPen = New-Object System.Drawing.Pen($VIOLET, [float]([math]::Max(1.0, $S * 0.018)))
  $g.DrawPolygon($diamondPen, $diamondPts)

  $sparkPts = MapPts $SPARK ([float]($S * 0.041)) $cx $cy
  $moonBrush = New-Object System.Drawing.SolidBrush($MOONLIGHT)
  $g.FillPolygon($moonBrush, $sparkPts)

  if ($S -ge 32) {
    $nodeBrush = New-Object System.Drawing.SolidBrush($VIOLET)
    $nodeSize = [float]([math]::Max(2.0, $S * 0.035))
    foreach ($point in $diamondPts) {
      $g.FillEllipse($nodeBrush, $point.X - $nodeSize / 2, $point.Y - $nodeSize / 2, $nodeSize, $nodeSize)
    }
  }

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return $ms.ToArray()
}

$sizes = @(256, 128, 64, 48, 32, 16)
$pngs = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($s in $sizes) {
  [byte[]]$data = New-IconPng $s
  $pngs.Add($data)
  Write-Host ("  {0,3}px -> {1,7:N0} bytes" -f $s, $data.Length)
}

[byte[]]$master = New-IconPng 1024
[System.IO.File]::WriteAllBytes(
  (Join-Path (Get-Location) 'build\icon.png'),
  $master)

# Assemble the .ico container.
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([uint16]0)            # reserved
$bw.Write([uint16]1)            # type = icon
$bw.Write([uint16]$sizes.Count) # image count
$offset = [uint32](6 + 16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  [byte[]]$data = $pngs[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim)         # width  (0 => 256)
  $bw.Write([byte]$dim)         # height (0 => 256)
  $bw.Write([byte]0)            # palette count
  $bw.Write([byte]0)            # reserved
  $bw.Write([uint16]1)          # color planes
  $bw.Write([uint16]32)         # bits per pixel
  $bw.Write([uint32]$data.Length)
  $bw.Write([uint32]$offset)
  $offset += [uint32]$data.Length
}
for ($i = 0; $i -lt $sizes.Count; $i++) {
  [byte[]]$data = $pngs[$i]
  $bw.Write($data, 0, $data.Length)
}
$bw.Flush()

[System.IO.File]::WriteAllBytes((Join-Path (Get-Location) 'build\icon.ico'), $out.ToArray())

function Write-BigEndianUInt32 {
  param(
    [System.IO.BinaryWriter]$Writer,
    [uint32]$Value
  )

  $Writer.Write([byte](($Value -shr 24) -band 0xFF))
  $Writer.Write([byte](($Value -shr 16) -band 0xFF))
  $Writer.Write([byte](($Value -shr 8) -band 0xFF))
  $Writer.Write([byte]($Value -band 0xFF))
}

# Modern ICNS files can embed PNG payloads directly. Writing the container here
# keeps the checked-in macOS icon in lockstep with the Windows mark, even when a
# branding update is made from Windows.
$icnsEntries = @(
  @{ Type = 'icp4'; Data = [byte[]](New-IconPng 16) }
  @{ Type = 'icp5'; Data = [byte[]](New-IconPng 32) }
  @{ Type = 'icp6'; Data = [byte[]](New-IconPng 64) }
  @{ Type = 'ic07'; Data = [byte[]](New-IconPng 128) }
  @{ Type = 'ic08'; Data = [byte[]](New-IconPng 256) }
  @{ Type = 'ic09'; Data = [byte[]](New-IconPng 512) }
  @{ Type = 'ic10'; Data = $master }
)

[uint32]$icnsLength = 8
foreach ($entry in $icnsEntries) {
  $icnsLength += 8 + $entry.Data.Length
}

$icnsStream = New-Object System.IO.MemoryStream
$icnsWriter = New-Object System.IO.BinaryWriter($icnsStream)
$icnsWriter.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
Write-BigEndianUInt32 -Writer $icnsWriter -Value $icnsLength
foreach ($entry in $icnsEntries) {
  $icnsWriter.Write([System.Text.Encoding]::ASCII.GetBytes($entry.Type))
  Write-BigEndianUInt32 -Writer $icnsWriter -Value (8 + $entry.Data.Length)
  $icnsWriter.Write($entry.Data, 0, $entry.Data.Length)
}

[System.IO.File]::WriteAllBytes((Join-Path (Get-Location) 'build\icon.icns'), $icnsStream.ToArray())
$icnsWriter.Dispose()
$icnsStream.Dispose()

Write-Host ("Wrote build/icon.ico, build/icon.icns, and build/icon.png ({0} ICO sizes)" -f $sizes.Count)
