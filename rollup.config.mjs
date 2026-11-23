import { builtinModules } from 'module'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Node built-ins and every (peer) dependency stay require()s; only our own
// src/ files are bundled.
const external = new Set([
  ...builtinModules,
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {})
])

export default [
  {
    input: ['./src/server.js', './src/utils.js', './src/callback.js'],
    // also matches subpaths such as 'lib0/encoding' and 'node:fs'
    external: (id) => external.has(id.replace(/^node:/, '')) || external.has(id.split('/')[0]),
    output: [
      {
        dir: 'dist',
        format: 'cjs',
        sourcemap: true,
        entryFileNames: '[name].cjs',
        chunkFileNames: '[name]-[hash].cjs'
      }
    ]
  }
]
