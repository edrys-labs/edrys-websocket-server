#!/usr/bin/env node

import WebSocket from 'ws'
import http from 'http'
import https from 'https'
import * as number from 'lib0/number'
import { setupWSConnection } from './utils.js'
import { setupStreamConnection, setupStreamHeartbeat } from './stream-utils.js'
import { generateSelfSignedCert, loadSSLCertificates, validateSSLCertificates } from './ssl-utils.js'
import os from 'os'

// ANSI colors, only on a terminal and not with NO_COLOR (https://no-color.org)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
/** @param {...string} codes */
const paint = (...codes) => (/** @type {string} */ text) =>
  useColor ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text

const info = paint('36') // cyan
const success = paint('32') // green
const warning = paint('33') // yellow
const error = paint('31') // red
const header = paint('1', '35') // bright magenta
const highlight = paint('42', '30', '1') // bright black on green
const urlText = paint('4', '32') // underlined green

// Display help information
function showHelp () {
  console.log('Unified WebSocket Server - For Yjs and Video Streaming')
  console.log('\nUsage:')
  console.log('  node server.js [options]')
  console.log('\nOptions:')
  console.log(
    '  --port, --port=NUMBER       Port to listen on (default: 1234 or $PORT env)'
  )
  console.log(
    '  --host, --host=STRING       Host to bind to (default: 0.0.0.0 or $HOST env)'
  )
  console.log(
    '  --ssl, --https              Enable HTTPS/WSS with self-signed certificate'
  )
  console.log(
    '  --ssl-key PATH              Path to SSL private key file (or --ssl-key=PATH)'
  )
  console.log(
    '  --ssl-cert PATH             Path to SSL certificate file (or --ssl-cert=PATH)'
  )
  console.log('  --help, -h                  Show this help message')
  console.log('\nEnvironment Variables:')
  console.log('  PORT                        Alternative to --port')
  console.log('  HOST                        Alternative to --host')
  console.log('  SSL_KEY                     Path to SSL private key')
  console.log('  SSL_CERT                    Path to SSL certificate')
  console.log('  YJS_MAX_PAYLOAD             Max Yjs message size in bytes (default: 100 MiB)')
  console.log(
    '  NODE_ENV                    Environment (development/production)'
  )
  console.log('\nSSL/TLS Support:')
  console.log('  Use --ssl to enable HTTPS/WSS with auto-generated self-signed certificates')
  console.log('  Or provide custom certificates with --ssl-key and --ssl-cert')
  console.log('  Self-signed certificates will be saved in ./certs/ directory')
}

// Parse command line arguments
function parseArgs () {
  const args = process.argv.slice(2)
  const result = {
    help: false,
    ssl: false,
    sslKey: '',
    sslCert: '',
    port: '',
    host: ''
  }

  // options with a value, as "--name value" or "--name=value"
  /** @type {Record<string, 'port' | 'host' | 'sslKey' | 'sslCert'>} */
  const valued = { '--port': 'port', '--host': 'host', '--ssl-key': 'sslKey', '--ssl-cert': 'sslCert' }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg

    if (valued[name]) {
      if (eq > 0) {
        result[valued[name]] = arg.slice(eq + 1)
      } else if (i + 1 < args.length) {
        result[valued[name]] = args[++i]
      } else {
        console.error(`${name} needs a value`)
        process.exit(1)
      }
    } else if (arg === '--ssl' || arg === '--https') {
      result.ssl = true
    } else if (arg === '--help' || arg === '-h') {
      result.help = true
    } else {
      console.warn(`Ignoring unknown argument: ${arg} (see --help)`)
    }
  }

  // Check environment variables for SSL certificates
  if (!result.sslKey && process.env.SSL_KEY) {
    result.sslKey = process.env.SSL_KEY
  }
  if (!result.sslCert && process.env.SSL_CERT) {
    result.sslCert = process.env.SSL_CERT
  }

  // Both given: use them. Only one: an error, not a silent fallback to a
  // self-signed certificate or plain HTTP.
  if (!result.sslKey !== !result.sslCert) {
    console.error('Give both --ssl-key and --ssl-cert (or SSL_KEY and SSL_CERT), not just one.')
    process.exit(1)
  }
  if (result.sslKey && result.sslCert) {
    result.ssl = true
  }

  return result
}

// New function to get local network information
function getNetworkInfo () {
  const interfaces = os.networkInterfaces()
  const addresses = []

  for (const interfaceName in interfaces) {
    const networkInterface = interfaces[interfaceName]

    if (!networkInterface) continue
    for (const iface of networkInterface) {
      // Skip internal and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        addresses.push({
          interface: interfaceName,
          address: iface.address,
          netmask: iface.netmask
        })
      }
    }
  }

  return addresses
}

const args = parseArgs()

// Show help and exit if --help or -h was provided
if (args.help) {
  showHelp()
  process.exit(0)
}

// Create WebSocket servers - one for Yjs docs, one for streaming
// Max Yjs frame size. Kept at the ws default (100 MiB): a late joiner gets the
// whole classroom doc in one frame, and modules store pasted images in it
// (the whiteboard without a size cap), so a lower default could lock a class
// out of the fallback. Operators can lower it with YJS_MAX_PAYLOAD.
const yDocWss = new WebSocket.Server({
  noServer: true,
  maxPayload: number.parseInt(process.env.YJS_MAX_PAYLOAD || String(100 * 1024 * 1024))
})
const streamWss = new WebSocket.Server({
  noServer: true,
  maxPayload: 5 * 1024 * 1024 // 5MB max message size
})

// Priority: command line args > environment variables > defaults
const host = args.host || process.env.HOST || '0.0.0.0'
const port = number.parseInt(String(args.port || process.env.PORT || '1234'))

// SSL Configuration
let sslOptions = null
if (args.ssl) {
  try {
    if (args.sslKey && args.sslCert) {
      // Use provided certificates
      console.log('🔐 Loading custom SSL certificates...')
      if (!validateSSLCertificates(args.sslKey, args.sslCert)) {
        throw new Error(`SSL certificate files not found: ${args.sslKey}, ${args.sslCert}`)
      }
      const { key, cert } = loadSSLCertificates(args.sslKey, args.sslCert)
      sslOptions = { key, cert }
    } else {
      // Generate self-signed certificates
      console.log('🔐 Generating self-signed SSL certificates...')
      const { keyPath, certPath } = generateSelfSignedCert()
      const { key, cert } = loadSSLCertificates(keyPath, certPath)
      sslOptions = { key, cert }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown SSL error'
    console.error(`${error('SSL Setup Error:')} ${errorMessage}`)
    process.exit(1)
  }
}

// Plain HTTP answers a health check (readable from any origin)
/** @type {http.RequestListener} */
const requestHandler = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
  response.end('okay')
}

// Create server (HTTP or HTTPS based on SSL configuration)
const server = sslOptions
  ? https.createServer(sslOptions, requestHandler)
  : http.createServer(requestHandler)

// Set up the connections
yDocWss.on('connection', setupWSConnection)
streamWss.on('connection', setupStreamConnection)

// Set up stream heartbeat system (for video streaming)
setupStreamHeartbeat()

// Route WebSocket upgrades: /stream (and /stream/...) is the video relay,
// every other path is a Yjs room named after it.
server.on('upgrade', (request, socket, head) => {
  let pathname
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname
  } catch {
    // a malformed request target (e.g. "http://[") must not throw out of here
    socket.destroy()
    return
  }

  const wss = pathname === '/stream' || pathname.startsWith('/stream/') ? streamWss : yDocWss
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

server.listen(port, host, () => {
  const protocol = sslOptions ? 'https' : 'http'
  const wsProtocol = sslOptions ? 'wss' : 'ws'

  console.log(`\n${header('=== Unified WebSocket Server ===')}`)
  console.log(`${info('Server running at:')} ${success(`${protocol}://${host}:${port}`)}`)
  console.log(`${info('SSL/TLS:')} ${sslOptions ? success('Enabled ✅') : warning('Disabled')}`)
  console.log(
    `${info('Environment:')} ${success(process.env.NODE_ENV || 'development')}`
  )

  // Add detailed network information
  console.log(`\n${header('Local Network Information:')}`)
  const networkInfo = getNetworkInfo()

  if (networkInfo.length === 0) {
    console.log(warning('  No network interfaces detected'))
  } else {
    networkInfo.forEach((info, index) => {
      console.log(
        `\n  ${header(`Interface ${index + 1}:`)} ${success(info.interface)}`
      )
      console.log(`  ${header('IP Address:')} ${success(info.address)}`)
      console.log(
        `  ${header('HTTP Server:')} ${urlText(`${protocol}://${info.address}:${port}`)}`
      )
      console.log(
        `  ${header('Yjs WebSocket URL:')} ${urlText(`${wsProtocol}://${info.address}:${port}`)}`
      )
      console.log(
        `  ${header('Stream WebSocket URL:')} ${urlText(
          `${wsProtocol}://${info.address}:${port}/stream`
        )}`
      )
    })
  }

  console.log(
    `\n${header('To access from this machine:')}`
  )
  console.log(
    `  ${header('HTTP:')} ${highlight(` ${protocol}://localhost:${port} `)}`
  )
  console.log(
    `  ${header('Yjs WebSocket:')} ${highlight(` ${wsProtocol}://localhost:${port} `)}`
  )
  console.log(
    `  ${header('Stream WebSocket:')} ${highlight(` ${wsProtocol}://localhost:${port}/stream `)}`
  )

  if (sslOptions) {
    console.log(`\n${warning('⚠️  Using self-signed certificates:')}`)
    console.log(`${warning('   Browsers will show security warnings')}`)
    console.log(`${warning('   Click "Advanced" → "Proceed to localhost" to accept')}`)
  }

  console.log(`${header('==============================')}\n`)
})

// A server error is fatal (e.g. the port is in use): exit instead of staying
// alive without listening.
server.on('error', (err) => {
  console.error(`${error('Server error:')} ${err}`)
  process.exit(1)
})

yDocWss.on('error', (err) => {
  console.error(`${error('Yjs WebSocket server error:')} ${err}`)
})

streamWss.on('error', (err) => {
  console.error(`${error('Stream WebSocket server error:')} ${err}`)
})

// Exit on Ctrl+C and on SIGTERM (docker stop, Heroku). Clients reconnect on
// their own. As PID 1 in a container, node ignores SIGTERM without a handler.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${info(`${signal}: server shutting down...`)}`)
    process.exit(0)
  })
}
