#!/usr/bin/env node
// Build standalone executables of the server (Node.js single executable
// applications), so a lab can run it without installing Node.js.
//
//   node build-sea.mjs                      # the platform this runs on
//   node build-sea.mjs --all                # every platform below
//   node build-sea.mjs --platform win-x64   # one or more (repeat the flag)
//
// For each platform it writes edrys-executable-<platform>/ with the
// executable, a start script and a README.txt.
//
// How: esbuild bundles src/server.js into one CommonJS file; the official
// Node.js binary of each platform (NODE_VERSION, checked against the
// release's SHASUMS256.txt) is downloaded, and `node --build-sea` injects the
// bundle into it. Cross-building works from any host, but macOS executables
// must be signed, which needs `codesign`, so build those on macOS.

import { build } from 'esbuild'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// Node.js release the executables embed (an LTS line). Bump it here.
const NODE_VERSION = 'v26.13.1'
const NODE_DIST = `https://nodejs.org/dist/${NODE_VERSION}`
const PORT = 3210

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const WORK = path.join(ROOT, 'build', 'sea')

/**
 * archive: file name on nodejs.org/dist; node: path of the binary inside it;
 * exe: name of the executable we ship.
 * @type {Record<string, { name: string, archive: string, node: string, exe: string }>}
 */
const PLATFORMS = {
  'linux-x64': { name: 'Linux (x64)', archive: 'linux-x64.tar.xz', node: 'bin/node', exe: 'edrys-server-linux-x64' },
  'linux-arm64': { name: 'Linux (arm64)', archive: 'linux-arm64.tar.xz', node: 'bin/node', exe: 'edrys-server-linux-arm64' },
  'win-x64': { name: 'Windows (x64)', archive: 'win-x64.zip', node: 'node.exe', exe: 'edrys-server-win-x64.exe' },
  'darwin-x64': { name: 'macOS (Intel)', archive: 'darwin-x64.tar.gz', node: 'bin/node', exe: 'edrys-server-macos-x64' },
  'darwin-arm64': { name: 'macOS (Apple Silicon)', archive: 'darwin-arm64.tar.gz', node: 'bin/node', exe: 'edrys-server-macos-arm64' }
}

const hostPlatform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`

/** @param {string[]} argv */
function parseTargets (argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node build-sea.mjs [--all | --platform <name> ...]')
    console.log(`Platforms: ${Object.keys(PLATFORMS).join(', ')} (default: ${hostPlatform})`)
    process.exit(0)
  }
  if (argv.includes('--all')) return Object.keys(PLATFORMS)
  const targets = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform') targets.push(argv[++i])
    else if (argv[i].startsWith('--platform=')) targets.push(argv[i].slice('--platform='.length))
    else throw new Error(`unknown argument: ${argv[i]} (see --help)`)
  }
  if (targets.length === 0) targets.push(hostPlatform)
  for (const t of targets) {
    if (!PLATFORMS[t]) throw new Error(`unknown platform "${t}"; known: ${Object.keys(PLATFORMS).join(', ')}`)
  }
  return targets
}

/** @param {string} url */
async function download (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** @type {Map<string, string> | null} */
let checksums = null

/**
 * The official Node.js binary for `platform`, downloaded once into
 * build/sea/ and verified against the release's SHASUMS256.txt.
 * @param {string} platform
 */
async function nodeBinary (platform) {
  const p = PLATFORMS[platform]
  const base = `node-${NODE_VERSION}-${p.archive.replace(/\.(tar\.xz|tar\.gz|zip)$/, '')}`
  const binary = path.join(WORK, base, p.node)
  if (fs.existsSync(binary)) return binary

  if (!checksums) {
    const text = (await download(`${NODE_DIST}/SHASUMS256.txt`)).toString('utf8')
    checksums = new Map(text.trim().split('\n').map(line => {
      const [hash, file] = line.trim().split(/\s+/)
      return [file, hash]
    }))
  }
  const file = `node-${NODE_VERSION}-${p.archive}`
  const expected = checksums.get(file)
  if (!expected) throw new Error(`${file} is not listed in ${NODE_DIST}/SHASUMS256.txt`)

  console.log(`  downloading ${file}`)
  const data = await download(`${NODE_DIST}/${file}`)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) throw new Error(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`)

  const archive = path.join(WORK, file)
  fs.writeFileSync(archive, data)
  if (file.endsWith('.zip')) execFileSync('unzip', ['-q', '-o', archive, '-d', WORK])
  else execFileSync('tar', ['-xf', archive, '-C', WORK])
  fs.rmSync(archive)
  if (!fs.existsSync(binary)) throw new Error(`${p.node} not found in ${file}`)
  return binary
}

/** Bundle the server and its dependencies into one CommonJS file. */
async function bundle () {
  const out = path.join(WORK, 'server.cjs')
  await build({
    entryPoints: [path.join(ROOT, 'src', 'server.js')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${NODE_VERSION.slice(1).split('.')[0]}`,
    // ws loads these native speedups only if present
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning'
  })
  // drop the shebang esbuild keeps from the entry file
  const code = fs.readFileSync(out, 'utf8').replace(/^#!.*\n/, '')
  fs.writeFileSync(out, code)
  return out
}

/**
 * @param {string} platform
 * @param {string} exe
 */
function startScript (platform, exe) {
  if (platform === 'win-x64') {
    return {
      file: 'start-server.bat',
      content: [
        '@echo off',
        'title Edrys WebSocket Server',
        'for /f "tokens=2 delims=:" %%a in (\'ipconfig ^| findstr "IPv4"\') do set IP=%%a',
        'set IP=%IP: =%',
        'echo Edrys WebSocket Server',
        `echo   WebSocket: ws://%IP%:${PORT}/`,
        `echo   Streaming: ws://%IP%:${PORT}/stream`,
        'echo   Press Ctrl+C to stop',
        `"%~dp0${exe}" --port ${PORT}`,
        'pause',
        ''
      ].join('\r\n')
    }
  }
  return {
    file: 'start-server.sh',
    content: `#!/bin/sh
cd "$(dirname "$0")"
IP=$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null) | awk '{print $1}')
[ -z "$IP" ] && IP=localhost
echo "Edrys WebSocket Server"
echo "  WebSocket: ws://$IP:${PORT}/"
echo "  Streaming: ws://$IP:${PORT}/stream"
echo "  Press Ctrl+C to stop"
exec ./${exe} --port ${PORT}
`
  }
}

/**
 * @param {string} platform
 * @param {string} exe
 * @param {string} script
 */
function readme (platform, exe, script) {
  const p = PLATFORMS[platform]
  const run = platform === 'win-x64' ? `${exe} --port ${PORT}` : `./${exe} --port ${PORT}`
  return `EDRYS WEBSOCKET SERVER - ${p.name}
Standalone executable: no Node.js installation needed.

QUICK START
  Run ${script}, or start the executable directly:
    ${run}
  ${exe} --help lists all options (port, host, TLS).

ENDPOINTS
  Yjs (classroom sync):  ws://YOUR-IP:${PORT}/
  Video streaming:       ws://YOUR-IP:${PORT}/stream

CLASSROOM SETUP
  1. Start the server on a computer in the lab network.
  2. In the classroom's communication settings, choose WebSocket and enter
     ws://YOUR-IP:${PORT}/ (or wss://... when started with --ssl).
  3. With --ssl, open https://YOUR-IP:${PORT}/ once in each browser and accept
     the self-signed certificate. --ssl needs OpenSSL on this computer.
  A room's state lives in memory while someone is connected to it.

TROUBLESHOOTING
  - All devices must reach this computer (same network, firewall open for
    port ${PORT}).
${platform === 'win-x64'
    ? '  - Allow the .exe in Windows Defender / SmartScreen if asked.\n'
    : `  - "Permission denied": chmod +x ${exe} ${script}\n`}${platform.startsWith('darwin')
    ? `  - macOS blocks downloaded apps that are not notarized: right-click the
    executable > Open once, or run: xattr -d com.apple.quarantine ${exe}\n`
    : ''}
Built with Node.js ${NODE_VERSION} (single executable application).
https://github.com/edrys-labs/edrys-websocket-server
`
}

/**
 * @param {string} platform
 * @param {string} bundled
 * @param {string} hostNode
 */
async function buildPlatform (platform, bundled, hostNode) {
  const p = PLATFORMS[platform]
  console.log(`\n${p.name}`)
  const targetNode = await nodeBinary(platform)

  const outDir = path.join(ROOT, `edrys-executable-${platform}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const exe = path.join(outDir, p.exe)

  const config = path.join(WORK, `sea-config-${platform}.json`)
  fs.writeFileSync(config, JSON.stringify({
    main: bundled,
    output: exe,
    executable: targetNode,
    disableExperimentalSEAWarning: true,
    // must stay off for cross-platform builds
    useSnapshot: false,
    useCodeCache: false
  }, null, 2))
  execFileSync(hostNode, ['--build-sea', config], { stdio: 'inherit' })

  if (platform.startsWith('darwin')) {
    if (process.platform === 'darwin') {
      // injecting invalidated Node's signature; macOS kills unsigned arm64
      // binaries, so sign ad hoc (not notarized: Gatekeeper still asks once)
      execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' })
    } else {
      console.warn(`  WARNING: ${p.exe} is not signed (needs codesign on macOS) and will not start on macOS.`)
    }
  }
  if (platform !== 'win-x64') fs.chmodSync(exe, 0o755)

  const script = startScript(platform, p.exe)
  fs.writeFileSync(path.join(outDir, script.file), script.content, { mode: 0o755 })
  fs.writeFileSync(path.join(outDir, 'README.txt'), readme(platform, p.exe, script.file))
  console.log(`  -> ${path.relative(ROOT, exe)} (${Math.round(fs.statSync(exe).size / 1048576)} MB)`)
}

async function main () {
  const targets = parseTargets(process.argv.slice(2))
  fs.mkdirSync(WORK, { recursive: true })

  console.log(`Bundling src/server.js (Node.js ${NODE_VERSION})`)
  const bundled = await bundle()

  // --build-sea must run on the exact Node.js version that is embedded: use
  // this process if it matches, else that version's binary for this host.
  let hostNode = process.execPath
  if (process.version !== NODE_VERSION) {
    if (!PLATFORMS[hostPlatform]) throw new Error(`cannot build on ${hostPlatform}; run with Node.js ${NODE_VERSION}`)
    hostNode = await nodeBinary(hostPlatform)
  }

  for (const platform of targets) await buildPlatform(platform, bundled, hostNode)
  console.log(`\nDone: ${targets.map(t => `edrys-executable-${t}/`).join(', ')}`)
}

main().catch(err => {
  console.error(`Build failed: ${err.message}`)
  process.exit(1)
})
