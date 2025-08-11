#!/usr/bin/env node

import WebSocket from 'ws'
import http from 'http'
import https from 'https'
import * as number from 'lib0/number'
import { setupWSConnection } from './utils.js'
import { setupStreamConnection, setupStreamHeartbeat, cleanup } from './stream-utils.js'
import { generateSelfSignedCert, loadSSLCertificates, validateSSLCertificates } from './ssl-utils.js'
import os from 'os'
import url from 'url'

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
}

// Helper functions for colored output
const info = (text) => `${colors.cyan}${text}${colors.reset}`
const success = (text) => `${colors.green}${text}${colors.reset}`
const warning = (text) => `${colors.yellow}${text}${colors.reset}`
const error = (text) => `${colors.red}${text}${colors.reset}`
const header = (text) =>
  `${colors.bright}${colors.magenta}${text}${colors.reset}`
const highlight = (text) =>
  `${colors.bgGreen}${colors.black}${colors.bright}${text}${colors.reset}`
const url_text = (text) =>
  `${colors.underscore}${colors.green}${text}${colors.reset}`

// Display help information
function showHelp() {
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
    '  --ssl-key=PATH              Path to SSL private key file'
  )
  console.log(
    '  --ssl-cert=PATH             Path to SSL certificate file'
  )
  console.log('  --help, -h                  Show this help message')
  console.log('\nEnvironment Variables:')
  console.log('  PORT                        Alternative to --port')
  console.log('  HOST                        Alternative to --host')
  console.log('  SSL_KEY                     Path to SSL private key')
  console.log('  SSL_CERT                    Path to SSL certificate')
  console.log(
    '  NODE_ENV                    Environment (development/production)'
  )
  console.log('\nSSL/TLS Support:')
  console.log('  Use --ssl to enable HTTPS/WSS with auto-generated self-signed certificates')
  console.log('  Or provide custom certificates with --ssl-key and --ssl-cert')
  console.log('  Self-signed certificates will be saved in ./certs/ directory')
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)
  const result = {
    help: false,
    ssl: false,
    sslKey: '',
    sslCert: '',
    port: '',
    host: '',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--port' && i + 1 < args.length) {
      result.port = args[++i]
    } else if (arg === '--host' && i + 1 < args.length) {
      result.host = args[++i]
    } else if (arg.startsWith('--port=')) {
      result.port = arg.substring('--port='.length)
    } else if (arg.startsWith('--host=')) {
      result.host = arg.substring('--host='.length)
    } else if (arg === '--ssl' || arg === '--https') {
      result.ssl = true
    } else if (arg.startsWith('--ssl-key=')) {
      result.sslKey = arg.substring('--ssl-key='.length)
    } else if (arg.startsWith('--ssl-cert=')) {
      result.sslCert = arg.substring('--ssl-cert='.length)
    } else if (arg === '--help' || arg === '-h') {
      result.help = true
    }
  }

  // Check environment variables for SSL certificates
  if (!result.sslKey && process.env.SSL_KEY) {
    result.sslKey = process.env.SSL_KEY
  }
  if (!result.sslCert && process.env.SSL_CERT) {
    result.sslCert = process.env.SSL_CERT
  }

  // If SSL key and cert are provided, enable SSL
  if (result.sslKey && result.sslCert) {
    result.ssl = true
  }

  return result
}

// New function to get local network information
function getNetworkInfo() {
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
          netmask: iface.netmask,
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
const yDocWss = new WebSocket.Server({ noServer: true })
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

// Create HTTP server with CORS headers
const requestHandler = (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  response.writeHead(200, { 'Content-Type': 'text/plain' })
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
const heartbeatInterval = setupStreamHeartbeat(streamWss)

// Handle WebSocket upgrades with routing based on path
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url || '').pathname
  
  // Route WebSocket connections based on path
  if (pathname && pathname.startsWith('/stream')) {
    streamWss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`${success('Stream WebSocket connection established')}`)
      streamWss.emit('connection', ws, request)
    })
  } else {
    // Default to Yjs WebSocket connections
    yDocWss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`${success('Yjs WebSocket connection established')}`)
      yDocWss.emit('connection', ws, request)
    })
  }
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
        `  ${header('HTTP Server:')} ${url_text(`${protocol}://${info.address}:${port}`)}`
      )
      console.log(
        `  ${header('Yjs WebSocket URL:')} ${url_text(`${wsProtocol}://${info.address}:${port}`)}`
      )
      console.log(
        `  ${header('Stream WebSocket URL:')} ${url_text(
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

// Add error handlers
server.on('error', (err) => {
  console.error(`${error('Server error:')} ${err}`)
})

yDocWss.on('error', (err) => {
  console.error(`${error('Yjs WebSocket server error:')} ${err}`)
})

streamWss.on('error', (err) => {
  console.error(`${error('Stream WebSocket server error:')} ${err}`)
})

// Cleanup on server shutdown
process.on('SIGINT', () => {
  console.log(`\n${info('Server shutting down...')}`)
  cleanup()
  clearInterval(heartbeatInterval)
  yDocWss.close()
  streamWss.close()
  server.close()
  process.exit(0)
})
