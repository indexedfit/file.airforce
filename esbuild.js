import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

build({
  entryPoints: ['./src/main.js'],
  outfile: './dist/main.js',
  sourcemap: 'inline',
  minify: false,
  bundle: true,
  define: {
    'process.env.NODE_DEBUG': 'false',
    global: 'globalThis'
  }
}).catch(() => process.exit(1))

// Copy index.html into dist so the dev server has an entry point
const srcHtml = path.resolve('src/index.html')
const distHtml = path.resolve('dist/index.html')
try {
  fs.mkdirSync(path.dirname(distHtml), { recursive: true })
  fs.copyFileSync(srcHtml, distHtml)
} catch {}
