// Generates the macOS app icon (build/icon.icns + build/icon.png) from the same
// "spark on a violet→blue rounded square" mark as the Windows make-icon.ps1, but
// rendered as a vector (SVG) and rasterized natively at 1024px through an
// offscreen Electron (Chromium) window — so the large Retina sizes are crisp
// rather than upscaled from the 256px .ico. Then `iconutil` packs an .iconset
// into the .icns. macOS-only (needs `iconutil`); run with the bundled Electron:
//
//   node_modules/.bin/electron scripts/make-icon-mac.mjs
//
// (wrapped by `npm run make-icon:mac`).

import { app, BrowserWindow, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = 1024

// Spark control points in a 24x24 box (matches the in-app SparkIcon), bbox
// center (12,10). Mapped into icon space exactly as make-icon.ps1 does.
const SPARK = [
  [12.0, 3.0], [13.9, 8.2], [19.0, 10.0], [13.9, 11.8],
  [12.0, 17.0], [10.1, 11.8], [5.0, 10.0], [10.1, 8.2]
]
const mapPts = (sc, ccx, ccy) =>
  SPARK.map(([x, y]) => `${(ccx + (x - 12) * sc).toFixed(2)},${(ccy + (y - 10) * sc).toFixed(2)}`).join(' ')

const margin = S * 0.055
const side = S - 2 * margin
const radius = S * 0.225
const cx = S / 2
const cy = S / 2
const scale = S * 0.052

// 50° diagonal gradient direction (cos50, sin50), matching the GDI brush angle.
const gx = Math.cos((50 * Math.PI) / 180)
const gy = Math.sin((50 * Math.PI) / 180)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="${gx.toFixed(4)}" y2="${gy.toFixed(4)}">
      <stop offset="0" stop-color="#8b7cff"/>
      <stop offset="1" stop-color="#5b8dff"/>
    </linearGradient>
    <linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="0" y1="${margin}" x2="0" y2="${margin + side * 0.55}">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="rr">
      <rect x="${margin}" y="${margin}" width="${side}" height="${side}" rx="${radius}" ry="${radius}"/>
    </clipPath>
  </defs>
  <rect x="${margin}" y="${margin}" width="${side}" height="${side}" rx="${radius}" ry="${radius}" fill="url(#bg)"/>
  <g clip-path="url(#rr)">
    <rect x="${margin}" y="${margin}" width="${side}" height="${side * 0.55}" fill="url(#sheen)"/>
  </g>
  <polygon points="${mapPts(scale, cx, cy + S * 0.018)}" fill="#14103c" fill-opacity="0.235"/>
  <polygon points="${mapPts(scale, cx, cy)}" fill="#ffffff"/>
  <polygon points="${mapPts(scale * 0.32, cx + S * 0.205, cy - S * 0.165)}" fill="#ffffff" fill-opacity="0.92"/>
</svg>`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block}
</style></head><body>${svg}</body></html>`

// macOS .iconset → .icns size manifest.
const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
]

// Never let a stuck GUI launch hang forever.
const watchdog = setTimeout(() => {
  console.error('[make-icon-mac] timed out waiting for render')
  app.exit(1)
}, 30_000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: S,
    height: S,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false }
  })

  const shown = new Promise((r) => win.once('ready-to-show', r))
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await shown
  // Let the compositor produce a frame for the (now visible) window before
  // capturing — a hidden window may never paint, so we show it briefly.
  await new Promise((r) => setTimeout(r, 500))

  let shot = await win.webContents.capturePage()
  clearTimeout(watchdog)
  // capturePage returns device pixels (2x on a Retina panel); normalize to S.
  if (shot.getSize().width !== S) shot = shot.resize({ width: S, height: S, quality: 'best' })

  const buildDir = path.join(root, 'build')
  mkdirSync(buildDir, { recursive: true })
  // A 1024px master PNG (handy for docs / electron-builder fallback).
  writeFileSync(path.join(buildDir, 'icon.png'), shot.toPNG())

  const iconset = path.join(buildDir, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  for (const [name, size] of ICONSET) {
    const img = size === S ? shot : shot.resize({ width: size, height: size, quality: 'best' })
    writeFileSync(path.join(iconset, name), img.toPNG())
  }

  const res = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')], {
    stdio: 'inherit'
  })
  rmSync(iconset, { recursive: true, force: true })

  if (res.status !== 0) {
    console.error('[make-icon-mac] iconutil failed')
    app.exit(1)
    return
  }
  console.log('[make-icon-mac] wrote build/icon.icns + build/icon.png')
  app.exit(0)
})
