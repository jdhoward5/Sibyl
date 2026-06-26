import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// The strict production CSP. Kept in sync with the header CSP applied in
// src/main/index.ts. Injected as a <meta> tag only for the production build —
// file:// loads don't reliably receive response headers, so the meta tag is the
// authoritative policy there. In dev it is omitted (Vite HMR needs inline
// scripts + eval + a websocket, which a strict CSP forbids).
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://*.hf.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'sibyl-csp',
    transformIndexHtml(html, ctx) {
      if (ctx.server) return html // dev server: no meta CSP
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />\n  </head>`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Native/binary-backed deps must never be bundled: node-llama-cpp ships
        // native bindings; onnxruntime-node (Piper TTS) loads a native .node +
        // shared lib at runtime.
        external: ['node-llama-cpp', 'onnxruntime-node']
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
})
