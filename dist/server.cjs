#!/usr/bin/env node
'use strict';

var WebSocket = require('ws');
var http = require('http');
var https = require('https');
var number = require('lib0/number');
var utils = require('./utils.cjs');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var child_process = require('child_process');
var os = require('os');
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

// Video relay on /stream: a source (the station) registers for a room and
// sends MediaRecorder chunks; viewers join the room and get them verbatim.
//
//   source → { type: 'register-source', roomId, mimeType }  ← source-registered
//   viewer → { type: 'join-room', roomId }                   ← source-available
//   server → source { type: 'viewer-joined' }   (restart: fresh init segment)
//   server → viewers { type: 'source-disconnected' }

/** @type {Set<any>} every connected stream socket */
const clients = new Set();
/** @type {Map<string, any>} roomId -> source socket */
const streamSources = new Map();
let frameCount = 0;

// A viewer with more than this queued (it reads slower than the source
// records) is dropped instead of buffering without bound. Skipping chunks
// would corrupt its WebM stream; dropping makes it reconnect and re-join,
// and the source restarts with a fresh init segment.
const MAX_VIEWER_BUFFER = 8 * 1024 * 1024;

// Every viewer-joined restarts the source's MediaRecorder for the whole room,
// so they are coalesced: at most one per room per interval, plus one trailing
// one so the last joiner still gets a fresh init segment.
const VIEWER_JOINED_INTERVAL = 1000;
/** @type {Map<string, { last: number, timer: ReturnType<typeof setTimeout> | null }>} */
const restartRequests = new Map();

const STATS_INTERVAL = 60000;
setInterval(() => {
  if (frameCount > 0) {
    console.log(`Streaming: ${(frameCount * 1000 / STATS_INTERVAL).toFixed(1)} chunks/s, ${clients.size} clients, ${streamSources.size} sources`);
    frameCount = 0;
  }
}, STATS_INTERVAL).unref();

/**
 * @param {any} ws
 * @param {object} msg
 */
const sendJSON = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

/**
 * @param {string} roomId
 * @param {object} msg
 * @param {any} [except]
 */
const toRoom = (roomId, msg, except) => {
  clients.forEach(client => {
    if (client !== except && client.roomId === roomId) sendJSON(client, msg);
  });
};

/**
 * Sets up a WebSocket connection for streaming
 * @param {import('ws').WebSocket} socket
 */
const setupStreamConnection = (socket) => {
  const ws = /** @type {any} */ (socket);
  clients.add(ws);
  ws.isAlive = true;

  ws.on('message', (/** @type {any} */ message) => {
    // Any inbound traffic proves the socket is alive.
    ws.isAlive = true;

    // Binary = media chunk (Buffer); string = JSON control message (ws 6).
    if (typeof message !== 'string') {
      if (ws.isSource) {
        try {
          handleBinaryFrame(ws, message);
        } catch (err) {
          console.error(`Stream relay error: ${err instanceof Error ? err.message : err}`);
        }
      }
      return
    }

    try {
      const data = JSON.parse(message);
      if (data === null || typeof data !== 'object') return
      if (data.type === 'register-source') handleRegisterSource(ws, data);
      else if (data.type === 'join-room') handleJoinRoom(ws, data);
    } catch (err) {
      // bad JSON, or a send that threw: never let it escape the listener
      console.error(`Stream message error: ${err instanceof Error ? err.message : err}`);
    }
  });

  // 'close' always follows 'error', so cleanup happens there only.
  ws.on('close', () => {
    clients.delete(ws);
    releaseSource(ws);
  });
  ws.on('error', (/** @type {Error} */ err) => {
    console.error(`Stream WebSocket error: ${err.message}`);
  });
  ws.on('pong', () => { ws.isAlive = true; });
};

/**
 * @param {any} ws
 * @param {any} data
 */
function handleRegisterSource (ws, data) {
  if (!data.roomId) {
    sendJSON(ws, { type: 'error', message: 'Room ID is required to register as source' });
    return
  }
  const roomId = data.roomId;

  // Moving to another room: the old room no longer has this source.
  if (ws.roomId !== roomId) releaseSource(ws);

  // Last-writer-wins: a station that reconnects while its old socket still
  // lingers (network blip, fast reload) must take over, or it would record
  // into the void with no retry path. Terminate the stale socket; its close
  // handler is a no-op because the map will point at the new socket.
  const existing = streamSources.get(roomId);
  if (existing && existing !== ws && existing.readyState === 1) {
    console.log(`Replacing existing source for room: ${roomId}`);
    existing.terminate();
  }

  // Re-registration by the same socket just updates the mimeType (e.g. audio
  // track toggled).
  ws.isSource = true;
  ws.roomId = roomId;
  ws.mimeType = data.mimeType;
  streamSources.set(roomId, ws);
  console.log(`Stream source registered for room: ${roomId} (${data.mimeType})`);

  sendJSON(ws, { type: 'source-registered', roomId });
  toRoom(roomId, { type: 'source-available', roomId, mimeType: data.mimeType }, ws);
}

/**
 * @param {any} ws
 * @param {any} data
 */
function handleJoinRoom (ws, data) {
  const roomId = data.roomId;
  if (!roomId) {
    sendJSON(ws, { type: 'error', message: 'Room ID is required to join a room' });
    return
  }

  // a source that joins another room as a viewer stops being its room's source
  if (ws.roomId !== roomId) releaseSource(ws);
  ws.roomId = roomId;

  const source = streamSources.get(roomId);
  if (!source) return
  if (source.readyState !== 1) {
    streamSources.delete(roomId);
    return
  }
  sendJSON(ws, { type: 'source-available', roomId, mimeType: source.mimeType });
  // Ask the source to restart its MediaRecorder so the viewer gets a fresh
  // init segment at t=0 with no timeline gap.
  requestRestart(roomId);
}

/**
 * Send viewer-joined to the room's source, throttled per room (see
 * VIEWER_JOINED_INTERVAL).
 * @param {string} roomId
 */
function requestRestart (roomId) {
  let entry = restartRequests.get(roomId);
  if (!entry) {
    entry = { last: 0, timer: null };
    restartRequests.set(roomId, entry);
  }
  if (entry.timer) return // a trailing one is already scheduled
  const e = entry;
  const send = () => {
    e.last = Date.now();
    const source = streamSources.get(roomId);
    if (source) sendJSON(source, { type: 'viewer-joined', roomId });
  };
  const wait = e.last + VIEWER_JOINED_INTERVAL - Date.now();
  if (wait <= 0) {
    send();
  } else {
    e.timer = setTimeout(() => {
      e.timer = null;
      send();
    }, wait);
  }
}

/**
 * Relay a binary media chunk to all viewers in the source's room.
 * @param {any} ws
 * @param {Buffer} chunk
 */
function handleBinaryFrame (ws, chunk) {
  const roomId = ws.roomId;
  if (!roomId) return
  frameCount++;

  clients.forEach(client => {
    if (client === ws || client.readyState !== 1 || client.roomId !== roomId) return
    if (client.bufferedAmount > MAX_VIEWER_BUFFER) {
      console.warn(`Dropping slow stream viewer in room ${roomId} (${client.bufferedAmount} bytes queued)`);
      client.terminate();
      return
    }
    client.send(chunk, { binary: true });
  });
}

/**
 * If `ws` is the registered source of its room, unregister it and tell the
 * room. A no-op when the map already points at another socket (takeover).
 * @param {any} ws
 */
function releaseSource (ws) {
  const roomId = ws.roomId;
  if (!ws.isSource || !roomId || streamSources.get(roomId) !== ws) return
  console.log(`Stream source left room: ${roomId}`);
  streamSources.delete(roomId);
  ws.isSource = false;
  const pending = restartRequests.get(roomId);
  if (pending && pending.timer) clearTimeout(pending.timer);
  restartRequests.delete(roomId);
  toRoom(roomId, { type: 'source-disconnected', roomId }, ws);
}

/**
 * Ping every stream socket each 5 s; one that did not answer since the last
 * ping is terminated ('close' then cleans up).
 */
const setupStreamHeartbeat = () => {
  return setInterval(() => {
    clients.forEach(ws => {
      if (ws.isAlive === false) {
        ws.terminate();
        return
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    });
  }, 5000)
};

// SSL/TLS utility functions for HTTPS/WSS support

// Subject of the certificates this server makes; used to tell them apart
// from certificates someone put into certs/ themselves.
const SUBJECT = '/C=US/ST=Local/L=Local/O=Edrys/OU=WebSocket/CN=localhost';
const DAYS = 365;
// Renew a self-signed certificate this long before it expires.
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

/**
 * Generate a self-signed certificate for development/testing
 * @param {string} certDir - Directory to store certificates
 * @returns {Object} - Object containing key and cert paths
 */
function generateSelfSignedCert (certDir = './certs') {
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  const keyPath = path.join(certDir, 'server-key.pem');
  const certPath = path.join(certDir, 'server-cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const cert = readCert(certPath);
    const validTo = cert ? new Date(cert.validTo) : null;
    if (!cert || !validTo || validTo.getTime() - Date.now() > RENEW_BEFORE_MS) {
      console.log('🔒 Using existing certificates in ' + certDir);
      return { keyPath, certPath }
    }
    const when = `${validTo.getTime() < Date.now() ? 'expired' : 'expires'} on ${validTo.toISOString().slice(0, 10)}`;
    if (!isOurs(cert)) {
      // someone else's certificate: never overwrite it
      console.warn(`⚠️  The certificate in ${certPath} ${when}. It was not created by this server, so it is not renewed: replace it.`);
      return { keyPath, certPath }
    }
    console.log(`🔁 Renewing the self-signed certificate (it ${when})...`);
  } else {
    console.log('🔐 Generating self-signed SSL certificate...');
  }

  try {
    // Try to use OpenSSL if available
    createWithOpenSSL(keyPath, certPath);
  } catch (error) {
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
 * @param {string} certPath
 * @return {crypto.X509Certificate|null}
 */
function readCert (certPath) {
  try {
    return new crypto.X509Certificate(fs.readFileSync(certPath))
  } catch {
    return null
  }
}

/**
 * Whether this server created the certificate (self-signed, our subject).
 * @param {crypto.X509Certificate} cert
 */
function isOurs (cert) {
  const fields = SUBJECT.split('/').filter(Boolean);
  return cert.subject === cert.issuer && fields.every(f => cert.subject.split('\n').includes(f))
}

/**
 * Create a self-signed certificate with OpenSSL (no shell involved).
 * @param {string} keyPath
 * @param {string} certPath
 */
function createWithOpenSSL (keyPath, certPath) {
  child_process.execFileSync('openssl', [
    'req', '-nodes', '-new', '-x509',
    '-keyout', keyPath, '-out', certPath,
    '-days', String(DAYS),
    '-subj', SUBJECT,
    // SANs so browsers accept it for localhost once the warning is clicked away
    '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1'
  ], { stdio: 'pipe' });
}

/**
 * Load SSL certificates from files
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {Object} - Object containing key and cert content
 */
function loadSSLCertificates (keyPath, certPath) {
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
function validateSSLCertificates (keyPath, certPath) {
  try {
    fs.accessSync(keyPath, fs.constants.R_OK);
    fs.accessSync(certPath, fs.constants.R_OK);
    return true
  } catch {
    return false
  }
}

// ANSI colors, only on a terminal and not with NO_COLOR (https://no-color.org)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
/** @param {...string} codes */
const paint = (...codes) => (/** @type {string} */ text) =>
  useColor ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;

const info = paint('36'); // cyan
const success = paint('32'); // green
const warning = paint('33'); // yellow
const error = paint('31'); // red
const header = paint('1', '35'); // bright magenta
const highlight = paint('42', '30', '1'); // bright black on green
const urlText = paint('4', '32'); // underlined green

// Display help information
function showHelp () {
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
  console.log('  YJS_MAX_PAYLOAD             Max Yjs message size in bytes (default: 100 MiB)');
  console.log(
    '  NODE_ENV                    Environment (development/production)'
  );
  console.log('\nSSL/TLS Support:');
  console.log('  Use --ssl to enable HTTPS/WSS with auto-generated self-signed certificates');
  console.log('  Or provide custom certificates with --ssl-key and --ssl-cert');
  console.log('  Self-signed certificates will be saved in ./certs/ directory');
}

// Parse command line arguments
function parseArgs () {
  const args = process.argv.slice(2);
  const result = {
    help: false,
    ssl: false,
    sslKey: '',
    sslCert: '',
    port: '',
    host: ''
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
function getNetworkInfo () {
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
          netmask: iface.netmask
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
// Max Yjs frame size. Kept at the ws default (100 MiB): a late joiner gets the
// whole classroom doc in one frame, and modules store pasted images in it
// (the whiteboard without a size cap), so a lower default could lock a class
// out of the fallback. Operators can lower it with YJS_MAX_PAYLOAD.
const yDocWss = new WebSocket.Server({
  noServer: true,
  maxPayload: number__namespace.parseInt(process.env.YJS_MAX_PAYLOAD || String(100 * 1024 * 1024))
});
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

// Plain HTTP answers a health check (readable from any origin)
/** @type {http.RequestListener} */
const requestHandler = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
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
setupStreamHeartbeat();

// Route WebSocket upgrades: /stream (and /stream/...) is the video relay,
// every other path is a Yjs room named after it.
server.on('upgrade', (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch {
    // a malformed request target (e.g. "http://[") must not throw out of here
    socket.destroy();
    return
  }

  const wss = pathname === '/stream' || pathname.startsWith('/stream/') ? streamWss : yDocWss;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
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
        `  ${header('HTTP Server:')} ${urlText(`${protocol}://${info.address}:${port}`)}`
      );
      console.log(
        `  ${header('Yjs WebSocket URL:')} ${urlText(`${wsProtocol}://${info.address}:${port}`)}`
      );
      console.log(
        `  ${header('Stream WebSocket URL:')} ${urlText(
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

// A server error is fatal (e.g. the port is in use): exit instead of staying
// alive without listening.
server.on('error', (err) => {
  console.error(`${error('Server error:')} ${err}`);
  process.exit(1);
});

yDocWss.on('error', (err) => {
  console.error(`${error('Yjs WebSocket server error:')} ${err}`);
});

streamWss.on('error', (err) => {
  console.error(`${error('Stream WebSocket server error:')} ${err}`);
});

// Exit on Ctrl+C and on SIGTERM (docker stop, Heroku). Clients reconnect on
// their own. As PID 1 in a container, node ignores SIGTERM without a handler.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${info(`${signal}: server shutting down...`)}`);
    process.exit(0);
  });
}
//# sourceMappingURL=server.cjs.map
