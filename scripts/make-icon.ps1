# Generates a branded multi-resolution Sibyl app icon (build/icon.ico) using
# GDI+ — no external image tooling required. The mark mirrors the in-app logo:
# a 4-point "spark" on a violet→blue rounded-square gradient.
#
# The .ico embeds PNG-compressed images at 16/32/48/64/128/256 px (Vista+),
# rendered natively at each size for crispness.

Add-Type -AssemblyName System.Drawing

$ACCENT1 = [System.Drawing.Color]::FromArgb(255, 0x8b, 0x7c, 0xff) # violet
$ACCENT2 = [System.Drawing.Color]::FromArgb(255, 0x5b, 0x8d, 0xff) # blue

# Spark control points in a 24x24 viewBox (matches SparkIcon path), bbox center (12,10).
$SPARK = @(
  @(12.0, 3.0), @(13.9, 8.2), @(19.0, 10.0), @(13.9, 11.8),
  @(12.0, 17.0), @(10.1, 11.8), @(5.0, 10.0), @(10.1, 8.2)
)

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

  # Rounded-square background with a diagonal gradient.
  $margin = [float]([math]::Max(0.5, $S * 0.055))
  $rect = New-Object System.Drawing.RectangleF($margin, $margin, ($S - 2 * $margin), ($S - 2 * $margin))
  $radius = [float]($S * 0.225)
  $bgPath = New-RoundedPath $rect $radius
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $ACCENT1, $ACCENT2, 50.0)
  $g.FillPath($grad, $bgPath)

  # Soft top sheen for a glassy feel (clipped to the rounded square).
  $g.SetClip($bgPath)
  $sheenRect = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $rect.Width, $rect.Height * 0.55)
  $sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $sheenRect,
    [System.Drawing.Color]::FromArgb(46, 255, 255, 255),
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
    90.0)
  $g.FillRectangle($sheen, $sheenRect)
  $g.ResetClip()

  # Helper to map a 24-box point to icon space, scaled around spark center (12,10).
  $scale = [float]($S * 0.052)  # tuned so the spark fills ~62% of the icon
  $cx = $S / 2.0; $cy = $S / 2.0
  function MapPts($pts, $sc, $ccx, $ccy) {
    $out = New-Object 'System.Drawing.PointF[]' ($pts.Count)
    for ($i = 0; $i -lt $pts.Count; $i++) {
      $x = $ccx + ($pts[$i][0] - 12.0) * $sc
      $y = $ccy + ($pts[$i][1] - 10.0) * $sc
      $out[$i] = New-Object System.Drawing.PointF($x, $y)
    }
    return $out
  }

  # Drop shadow (subtle, only at larger sizes).
  if ($S -ge 48) {
    $shadowPts = MapPts $SPARK $scale ($cx) ($cy + $S * 0.018)
    $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 20, 16, 60))
    $g.FillPolygon($shadow, $shadowPts)
  }

  # Main spark (crisp white).
  $sparkPts = MapPts $SPARK $scale $cx $cy
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
  $g.FillPolygon($white, $sparkPts)

  # Small accent sparkle, upper-right, for a touch of magic (skip on tiny sizes).
  if ($S -ge 32) {
    $accentScale = $scale * 0.32
    $accentPts = MapPts $SPARK $accentScale ($cx + $S * 0.205) ($cy - $S * 0.165)
    $accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
    $g.FillPolygon($accentBrush, $accentPts)
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

New-Item -ItemType Directory -Force -Path build | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path (Get-Location) 'build\icon.ico'), $out.ToArray())

Write-Host ("Wrote build/icon.ico ({0} sizes, {1:N0} bytes total)" -f $sizes.Count, $out.Length)
