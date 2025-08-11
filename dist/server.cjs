#!/usr/bin/env node
'use strict';

var WebSocket = require('ws');
var http = require('http');
var https = require('https');
var number = require('lib0/number');
var utils = require('./utils.cjs');
var fs = require('fs');
var path = require('path');
require('crypto');
var child_process = require('child_process');
var os = require('os');
var url = require('url');
require('yjs');
require('y-protocols/sync');
require('y-protocols/awareness');
require('lib0/encoding');
require('lib0/decoding');
require('lib0/map');
require('lib0/eventloop');
require('./callback.cjs');

function _interopNamespaceDefault(e) {
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var number__namespace = /*#__PURE__*/_interopNamespaceDefault(number);

// Store active connections
const clients = new Set();
// Store active stream sources
const streamSources = new Map(); // roomId -> source connection
let frameCount = 0;

// Track performance statistics
const performanceStats = {
  fps: 0,
  clients: 0,
  sources: 0,
  bytesTransferred: 0,
};

// Log performance stats periodically
const statsInterval = setInterval(() => {
  if (frameCount > 0) {
    performanceStats.fps = frameCount;
    performanceStats.clients = clients.size;
    performanceStats.sources = streamSources.size;
    console.log(`Streaming at ${frameCount} fps, ${clients.size} clients connected, ${streamSources.size} active sources`);
    frameCount = 0;
  }
}, 5000);

/**
 * Sets up a WebSocket connection for streaming
 * @param {import('ws').WebSocket} ws - WebSocket connection
 * @param {import('http').IncomingMessage} req - HTTP request
 */
const setupStreamConnection = (ws, req) => {
  console.log('Stream client connected');
  
  // Track client capabilities and network performance
  /** @type {any} */ (ws).clientInfo = {
    lastMessageTime: Date.now(),
    messagesSent: 0,
    bytesTransferred: 0,
    latency: 200, // Initial assumption
    dropped: 0
  };
  
  /** @type {any} */ (ws).isAlive = true;
  
  clients.add(ws);

  // Send server info to the new client
  ws.send(JSON.stringify({
    type: 'info',
    message: 'Connected to WebSocket streaming server',
    sources: Array.from(streamSources.keys()),
    clients: clients.size - 1 // Exclude self
  }));

  // Handle messages from clients
  ws.on('message', (message) => {
    try {
      // Handle potential Buffer or string messages
      const messageString = message instanceof Buffer ? 
        message.toString('utf-8') : message.toString();
      
      let data;
      try {
        data = JSON.parse(messageString);
      } catch (e) {
        console.error('Failed to parse message as JSON:', e);
        return;
      }
      
      if (data.type === 'register-source') {
        handleRegisterSource(ws, data, messageString);
      } 
      else if (data.type === 'join-room') {
        handleJoinRoom(ws, data);
      }
      else if (data.type === 'frame' && /** @type {any} */ (ws).isSource) {
        handleFrame(ws, data, messageString);
      } 
      else if (data.type === 'ping') {
        handlePing(ws, data);
      } 
      else if (data.type === 'pong-response') {
        handlePongResponse(ws, data);
      } 
      else if (data.type === 'stats') {
        handleStats(ws, data);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log('Stream client disconnected');
    handleDisconnect(ws);
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    handleDisconnect(ws);
  });

  // Set up ping/pong for connection health
  ws.on('pong', () => {
    /** @type {any} */ (ws).isAlive = true;
  });
};

/**
 * Handle source registration
 * @param {import('ws').WebSocket} ws
 * @param {any} data
 * @param {string} messageString
 */
function handleRegisterSource(ws, data, messageString) {
  // Require a roomId for registration
  if (!data.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room ID is required to register as source'
    }));
    return;
  }

  const roomId = data.roomId;
  
  // Check if this room already has a source
  if (streamSources.has(roomId)) {
    // If the source is still connected, reject new registration
    const existingSource = streamSources.get(roomId);
    if (existingSource.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Room ${roomId} already has an active source`
      }));
      return;
    } else {
      // If existing source is no longer connected, remove it
      streamSources.delete(roomId);
    }
  }
  
  // Register this client as the source for the room
  /** @type {any} */ (ws).isSource = true;
  /** @type {any} */ (ws).roomId = roomId;
  streamSources.set(roomId, ws);
  console.log(`Stream source registered for room: ${roomId}`);
  
  // Confirm successful registration
  ws.send(JSON.stringify({
    type: 'source-registered',
    roomId: roomId
  }));
  
  // Notify all clients in the same room that a source is available
  clients.forEach((client) => {
    if (client !== ws && 
        client.readyState === 1 &&
        /** @type {any} */ (client).roomId === roomId) {
      client.send(JSON.stringify({
        type: 'source-available',
        roomId: roomId
      }));
    }
  });
}

/**
 * Handle room joining
 * @param {import('ws').WebSocket} ws
 * @param {any} data
 */
function handleJoinRoom(ws, data) {
  // Client wants to join a specific room
  const roomId = data.roomId;
  if (!roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room ID is required to join a room'
    }));
    return;
  }
  
  /** @type {any} */ (ws).roomId = roomId;
  console.log(`Client joined room: ${roomId}`);
  
  // Notify the client if this room has a source
  if (streamSources.has(roomId)) {
    const source = streamSources.get(roomId);
    if (source.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'source-available',
        roomId: roomId
      }));
    } else {
      // Clean up dead sources
      streamSources.delete(roomId);
    }
  }
}

/**
 * Handle frame from source
 * @param {import('ws').WebSocket} ws
 * @param {any} data
 * @param {string} messageString
 */
function handleFrame(ws, data, messageString) {
  if (!data.data) {
    console.error('Missing frame data');
    return;
  }
  
  // Track frame rate
  frameCount++;
  
  // Only send frames to clients in the same room
  const roomClients = [...clients].filter(client => 
    client !== ws && 
    client.readyState === 1 &&
    /** @type {any} */ (client).roomId === /** @type {any} */ (ws).roomId
  );
  
  if (roomClients.length > 0) {
    // Sort clients by performance for more efficient delivery
    const sortedClients = roomClients.sort((a, b) => {
      return (/** @type {any} */ (a).clientInfo?.latency || 999) - 
             (/** @type {any} */ (b).clientInfo?.latency || 999);
    });
      
    // Use a slight delay between sends to avoid network congestion
    sortedClients.forEach((client, index) => {
      if (client.readyState === 1) {
        const clientInfo = /** @type {any} */ (client).clientInfo;
        const messageSize = messageString.length;
        
        // Send immediately to first few clients, delay others slightly
        setTimeout(() => {
          try {
            client.send(messageString);
            
            // Update client stats
            clientInfo.messagesSent++;
            clientInfo.bytesTransferred += messageSize;
            performanceStats.bytesTransferred += messageSize;
            clientInfo.lastMessageTime = Date.now();
          } catch (error) {
            clientInfo.dropped++;
            console.error('Error sending to client:', error);
          }
        }, Math.floor(index / 3) * 5); // Group clients in batches of 3 with 5ms delay between batches
      }
    });
  }
}

/**
 * Handle ping message
 * @param {import('ws').WebSocket} ws
 * @param {any} data
 */
function handlePing(ws, data) {
  // Respond to ping with pong and include server timestamp for latency calculation
  /** @type {any} */ (ws).clientInfo.lastMessageTime = Date.now();
  ws.send(JSON.stringify({ 
    type: 'pong',
    timestamp: Date.now(),
    clientTimestamp: data.timestamp
  }));
}

/**
 * Handle pong response
 * @param {import('ws').WebSocket} ws
 * @param {any} data
 */
function handlePongResponse(ws, data) {
  // Client confirms pong receipt - allows us to measure RTT
  const rtt = Date.now() - data.serverTimestamp;
  /** @type {any} */ (ws).clientInfo.latency = rtt / 2; // Estimate one-way latency as RTT/2
}

/**
 * Handle stats from client
 * @param {import('ws').WebSocket} ws
 * @param {any} data
 */
function handleStats(ws, data) {
  // Client reporting its performance stats
  if (/** @type {any} */ (ws).clientInfo) {
    /** @type {any} */ (ws).clientInfo.fps = data.fps;
    /** @type {any} */ (ws).clientInfo.bufferSize = data.bufferSize;
    /** @type {any} */ (ws).clientInfo.dropped = data.dropped || /** @type {any} */ (ws).clientInfo.dropped;
  }
}

/**
 * Handle client disconnection
 * @param {import('ws').WebSocket} ws
 */
function handleDisconnect(ws) {
  clients.delete(ws);
  
  // If this was a stream source, remove it and notify room clients
  if (/** @type {any} */ (ws).isSource && /** @type {any} */ (ws).roomId) {
    console.log(`Stream source disconnected from room: ${/** @type {any} */ (ws).roomId}`);
    streamSources.delete(/** @type {any} */ (ws).roomId);
    
    // Notify room clients that the source has disconnected
    clients.forEach((client) => {
      if (client.readyState === 1 && /** @type {any} */ (client).roomId === /** @type {any} */ (ws).roomId) {
        client.send(JSON.stringify({
          type: 'source-disconnected',
          roomId: /** @type {any} */ (ws).roomId
        }));
      }
    });
  }
}

/**
 * Set up heartbeat system for stream clients
 * @param {import('ws').Server} wss - WebSocket server
 */
const setupStreamHeartbeat = (wss) => {
  const pingInterval = setInterval(() => {
    let liveClients = 0;
    clients.forEach((ws) => {
      if (ws.isAlive === false) {
        handleDisconnect(ws);
        return ws.terminate();
      }
      
      ws.isAlive = false;
      liveClients++;
      
      try {
        // Send ping with timestamp for latency calculation
        ws.send(JSON.stringify({
          type: 'ping',
          timestamp: Date.now(),
          stats: {
            clients: clients.size,
            fps: performanceStats.fps
          }
        }));
        ws.ping();
      } catch (e) {
        // Client might be dead
        console.error("Failed to ping stream client", e);
        handleDisconnect(ws);
      }
    });
    
    performanceStats.clients = liveClients;
  }, 5000);

  return pingInterval;
};

/**
 * Clean up resources
 */
const cleanup = () => {
  clearInterval(statsInterval);
};

// SSL/TLS utility functions for HTTPS/WSS support

/**
 * Generate a self-signed certificate for development/testing
 * @param {string} certDir - Directory to store certificates
 * @returns {Object} - Object containing key and cert paths
 */
function generateSelfSignedCert(certDir = './certs') {
  // Ensure certificate directory exists
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  const keyPath = path.join(certDir, 'server-key.pem');
  const certPath = path.join(certDir, 'server-cert.pem');

  // Check if certificates already exist
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('🔒 Using existing self-signed certificates');
    return { keyPath, certPath }
  }

  console.log('🔐 Generating self-signed SSL certificate...');

  try {
    // Try to use OpenSSL if available
    createWithOpenSSL(keyPath, certPath);
  } catch (error) {
    //console.log('⚠️  OpenSSL not available, using Node.js crypto...')
    //createWithNodeCrypto(keyPath, certPath)
    console.log('❌ Cannot generate SSL certificates without OpenSSL');
    console.log('');
    console.log('🔧 Solutions:');
    console.log('   1. Install OpenSSL:');
    console.log('      • Linux: sudo apt-get install openssl');
    console.log('      • macOS: brew install openssl');
    console.log('      • Windows: Download from https://slproweb.com/products/Win32OpenSSL.html');
    console.log('');
    console.log('   2. Provide your own certificates in certs/ directory:');
    console.log('      • server-key.pem (private key)');
    console.log('      • server-cert.pem (certificate)');
    console.log('');
    console.log('   3. Run without --ssl flag to use HTTP instead:');
    console.log('      • Example: ./edrys-server --port 3210');
    console.log('');
    
    throw new Error('SSL certificate generation requires OpenSSL. Please install OpenSSL or provide existing certificates.')
  }

  console.log('✅ Self-signed certificate generated successfully');
  console.log(`   Key: ${keyPath}`);
  console.log(`   Cert: ${certPath}`);

  return { keyPath, certPath }
}

/**
 * Create certificates using OpenSSL
 */
function createWithOpenSSL(keyPath, certPath) {
  // Create a more comprehensive certificate with SAN fields for better browser compatibility
  const opensslCmd = `openssl req -nodes -new -x509 -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/C=US/ST=Local/L=Local/O=Edrys/OU=WebSocket/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:0.0.0.0"`;
  child_process.execSync(opensslCmd, { stdio: 'pipe' });
}

/**
 * Load SSL certificates from files
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {Object} - Object containing key and cert content
 */
function loadSSLCertificates(keyPath, certPath) {
  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    return { key, cert }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to load SSL certificates: ${errorMessage}`)
  }
}

/**
 * Check if SSL certificates exist and are valid
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {boolean} - True if certificates exist and are readable
 */
function validateSSLCertificates(keyPath, certPath) {
  try {
    fs.accessSync(keyPath, fs.constants.R_OK);
    fs.accessSync(certPath, fs.constants.R_OK);
    return true
  } catch {
    return false
  }
}

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  underscore: '\x1b[4m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgGreen: '\x1b[42m'};

// Helper functions for colored output
const info = (text) => `${colors.cyan}${text}${colors.reset}`;
const success = (text) => `${colors.green}${text}${colors.reset}`;
const warning = (text) => `${colors.yellow}${text}${colors.reset}`;
const error = (text) => `${colors.red}${text}${colors.reset}`;
const header = (text) =>
  `${colors.bright}${colors.magenta}${text}${colors.reset}`;
const highlight = (text) =>
  `${colors.bgGreen}${colors.black}${colors.bright}${text}${colors.reset}`;
const url_text = (text) =>
  `${colors.underscore}${colors.green}${text}${colors.reset}`;

// Display help information
function showHelp() {
  console.log('Unified WebSocket Server - For Yjs and Video Streaming');
  console.log('\nUsage:');
  console.log('  node server.js [options]');
  console.log('\nOptions:');
  console.log(
    '  --port, --port=NUMBER       Port to listen on (default: 1234 or $PORT env)'
  );
  console.log(
    '  --host, --host=STRING       Host to bind to (default: 0.0.0.0 or $HOST env)'
  );
  console.log(
    '  --ssl, --https              Enable HTTPS/WSS with self-signed certificate'
  );
  console.log(
    '  --ssl-key=PATH              Path to SSL private key file'
  );
  console.log(
    '  --ssl-cert=PATH             Path to SSL certificate file'
  );
  console.log('  --help, -h                  Show this help message');
  console.log('\nEnvironment Variables:');
  console.log('  PORT                        Alternative to --port');
  console.log('  HOST                        Alternative to --host');
  console.log('  SSL_KEY                     Path to SSL private key');
  console.log('  SSL_CERT                    Path to SSL certificate');
  console.log(
    '  NODE_ENV                    Environment (development/production)'
  );
  console.log('\nSSL/TLS Support:');
  console.log('  Use --ssl to enable HTTPS/WSS with auto-generated self-signed certificates');
  console.log('  Or provide custom certificates with --ssl-key and --ssl-cert');
  console.log('  Self-signed certificates will be saved in ./certs/ directory');
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    help: false,
    ssl: false,
    sslKey: '',
    sslCert: '',
    port: '',
    host: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--port' && i + 1 < args.length) {
      result.port = args[++i];
    } else if (arg === '--host' && i + 1 < args.length) {
      result.host = args[++i];
    } else if (arg.startsWith('--port=')) {
      result.port = arg.substring('--port='.length);
    } else if (arg.startsWith('--host=')) {
      result.host = arg.substring('--host='.length);
    } else if (arg === '--ssl' || arg === '--https') {
      result.ssl = true;
    } else if (arg.startsWith('--ssl-key=')) {
      result.sslKey = arg.substring('--ssl-key='.length);
    } else if (arg.startsWith('--ssl-cert=')) {
      result.sslCert = arg.substring('--ssl-cert='.length);
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
  }

  // Check environment variables for SSL certificates
  if (!result.sslKey && process.env.SSL_KEY) {
    result.sslKey = process.env.SSL_KEY;
  }
  if (!result.sslCert && process.env.SSL_CERT) {
    result.sslCert = process.env.SSL_CERT;
  }

  // If SSL key and cert are provided, enable SSL
  if (result.sslKey && result.sslCert) {
    result.ssl = true;
  }

  return result
}

// New function to get local network information
function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const interfaceName in interfaces) {
    const networkInterface = interfaces[interfaceName];

    if (!networkInterface) continue
    for (const iface of networkInterface) {
      // Skip internal and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        addresses.push({
          interface: interfaceName,
          address: iface.address,
          netmask: iface.netmask,
        });
      }
    }
  }

  return addresses
}

const args = parseArgs();

// Show help and exit if --help or -h was provided
if (args.help) {
  showHelp();
  process.exit(0);
}

// Create WebSocket servers - one for Yjs docs, one for streaming
const yDocWss = new WebSocket.Server({ noServer: true });
const streamWss = new WebSocket.Server({ 
  noServer: true,
  maxPayload: 5 * 1024 * 1024 // 5MB max message size  
});

// Priority: command line args > environment variables > defaults
const host = args.host || process.env.HOST || '0.0.0.0';
const port = number__namespace.parseInt(String(args.port || process.env.PORT || '1234'));

// SSL Configuration
let sslOptions = null;
if (args.ssl) {
  try {
    if (args.sslKey && args.sslCert) {
      // Use provided certificates
      console.log('🔐 Loading custom SSL certificates...');
      if (!validateSSLCertificates(args.sslKey, args.sslCert)) {
        throw new Error(`SSL certificate files not found: ${args.sslKey}, ${args.sslCert}`)
      }
      const { key, cert } = loadSSLCertificates(args.sslKey, args.sslCert);
      sslOptions = { key, cert };
    } else {
      // Generate self-signed certificates
      console.log('🔐 Generating self-signed SSL certificates...');
      const { keyPath, certPath } = generateSelfSignedCert();
      const { key, cert } = loadSSLCertificates(keyPath, certPath);
      sslOptions = { key, cert };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown SSL error';
    console.error(`${error('SSL Setup Error:')} ${errorMessage}`);
    process.exit(1);
  }
}

// Create HTTP server with CORS headers
const requestHandler = (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return
  }

  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('okay');
};

// Create server (HTTP or HTTPS based on SSL configuration)
const server = sslOptions 
  ? https.createServer(sslOptions, requestHandler)
  : http.createServer(requestHandler);

// Set up the connections
yDocWss.on('connection', utils.setupWSConnection);
streamWss.on('connection', setupStreamConnection);

// Set up stream heartbeat system (for video streaming)
const heartbeatInterval = setupStreamHeartbeat();

// Handle WebSocket upgrades with routing based on path
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url || '').pathname;
  
  // Route WebSocket connections based on path
  if (pathname && pathname.startsWith('/stream')) {
    streamWss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`${success('Stream WebSocket connection established')}`);
      streamWss.emit('connection', ws, request);
    });
  } else {
    // Default to Yjs WebSocket connections
    yDocWss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`${success('Yjs WebSocket connection established')}`);
      yDocWss.emit('connection', ws, request);
    });
  }
});

server.listen(port, host, () => {
  const protocol = sslOptions ? 'https' : 'http';
  const wsProtocol = sslOptions ? 'wss' : 'ws';
  
  console.log(`\n${header('=== Unified WebSocket Server ===')}`);
  console.log(`${info('Server running at:')} ${success(`${protocol}://${host}:${port}`)}`);
  console.log(`${info('SSL/TLS:')} ${sslOptions ? success('Enabled ✅') : warning('Disabled')}`);
  console.log(
    `${info('Environment:')} ${success(process.env.NODE_ENV || 'development')}`
  );

  // Add detailed network information
  console.log(`\n${header('Local Network Information:')}`);
  const networkInfo = getNetworkInfo();

  if (networkInfo.length === 0) {
    console.log(warning('  No network interfaces detected'));
  } else {
    networkInfo.forEach((info, index) => {
      console.log(
        `\n  ${header(`Interface ${index + 1}:`)} ${success(info.interface)}`
      );
      console.log(`  ${header('IP Address:')} ${success(info.address)}`);
      console.log(
        `  ${header('HTTP Server:')} ${url_text(`${protocol}://${info.address}:${port}`)}`
      );
      console.log(
        `  ${header('Yjs WebSocket URL:')} ${url_text(`${wsProtocol}://${info.address}:${port}`)}`
      );
      console.log(
        `  ${header('Stream WebSocket URL:')} ${url_text(
          `${wsProtocol}://${info.address}:${port}/stream`
        )}`
      );
    });
  }

  console.log(
    `\n${header('To access from this machine:')}`
  );
  console.log(
    `  ${header('HTTP:')} ${highlight(` ${protocol}://localhost:${port} `)}`
  );
  console.log(
    `  ${header('Yjs WebSocket:')} ${highlight(` ${wsProtocol}://localhost:${port} `)}`
  );
  console.log(
    `  ${header('Stream WebSocket:')} ${highlight(` ${wsProtocol}://localhost:${port}/stream `)}`
  );

  if (sslOptions) {
    console.log(`\n${warning('⚠️  Using self-signed certificates:')}`);
    console.log(`${warning('   Browsers will show security warnings')}`);
    console.log(`${warning('   Click "Advanced" → "Proceed to localhost" to accept')}`);
  }
  
  console.log(`${header('==============================')}\n`);
});

// Add error handlers
server.on('error', (err) => {
  console.error(`${error('Server error:')} ${err}`);
});

yDocWss.on('error', (err) => {
  console.error(`${error('Yjs WebSocket server error:')} ${err}`);
});

streamWss.on('error', (err) => {
  console.error(`${error('Stream WebSocket server error:')} ${err}`);
});

// Cleanup on server shutdown
process.on('SIGINT', () => {
  console.log(`\n${info('Server shutting down...')}`);
  cleanup();
  clearInterval(heartbeatInterval);
  yDocWss.close();
  streamWss.close();
  server.close();
  process.exit(0);
});
//# sourceMappingURL=server.cjs.map
