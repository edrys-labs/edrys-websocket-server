# edrys-websocket-server

> WebSocket server for [edrys-Lite](https://github.com/edrys-labs/edrys-Lite) to create a connection between peers and share video streams.

> This project is a modified version of [y-websocket-server](https://github.com/yjs/y-websocket-server) by Kevin Jahns.

The WebSocket server provides two main functions:
1. A backend for [y-websocket](https://github.com/yjs/y-websocket) to handle Yjs document collaboration
2. A video streaming server to enable real-time video sharing between peers

## Quick Start

### Install dependencies

```
npm install
```

### Start the unified WebSocket server

This repository implements a server that handles both Yjs document collaboration and video streaming in a single process. [(source code)](./src/)

Start the server:

```
node src/server.js --port 3210
```

#### SSL/TLS Support (HTTPS/WSS)

For secure connections (required when your app is hosted on HTTPS), enable SSL/TLS:

```bash
# Enable SSL with auto-generated self-signed certificates
node src/server.js --ssl --port 3210

# Or use custom certificates
node src/server.js --ssl-key /path/to/private.key --ssl-cert /path/to/certificate.crt --port 3210
```

**Important for HTTPS-hosted applications:** Browsers enforce mixed content security policies that prevent HTTPS websites from connecting to non-secure WebSocket servers (ws://). You **must** use secure WebSocket connections (wss://) when your application is served over HTTPS.

The server exposes two WebSocket endpoints:

* `ws://hostname:port/` or `wss://hostname:port/` - For Yjs document collaboration  
* `ws://hostname:port/stream` or `wss://hostname:port/stream` - For video streaming

## Client Usage

### For Yjs document collaboration:

```js
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const doc = new Y.Doc()
// Use wss:// for secure connections when your app is served over HTTPS
const wsProvider = new WebsocketProvider('wss://localhost:1234', 'my-roomname', doc)

wsProvider.on('status', event => {
  console.log(event.status) // logs "connected" or "disconnected"
})
```

### For video streaming:

```js
// Connect to the streaming endpoint
const ws = new WebSocket('ws://localhost:1234/stream')

// For stream source (sender): the room id is the SHA-256 of a secret key,
// and only the room id is given to viewers
const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const sourceKey = hex(crypto.getRandomValues(new Uint8Array(32)))
const roomId = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceKey))))

ws.onopen = () => {
  // Register as the video source of this room
  ws.send(JSON.stringify({
    type: 'register-source',
    roomId,
    sourceKey,
    mimeType: 'video/webm;codecs="vp8"'
  }))

  // Then send MediaRecorder chunks as binary messages
  recorder.ondataavailable = (e) => ws.send(e.data)
}

// For stream viewer (receiver)
ws.onopen = () => {
  // Join the room the source handed out
  ws.send(JSON.stringify({
    type: 'join-room',
    roomId
  }))
}

// Handle incoming messages: JSON control messages, binary media chunks
ws.onmessage = (event) => {
  if (typeof event.data !== 'string') {
    appendToSourceBuffer(event.data)
  } else if (JSON.parse(event.data).type === 'source-available') {
    console.log('A video source is available in this room')
  }
}
```

## Video Streaming Protocol

The streaming WebSocket endpoint relays MediaRecorder output (WebM/VP8[/Opus]
chunks) from one source per room to all viewers in that room. Media chunks are
sent as binary WebSocket messages; control messages are JSON text frames:

### Message Types:

1. **Register as a stream source** (station → server). Viewers know the room
   id, so the source proves itself with a secret `sourceKey`: `roomId` must be
   the lowercase hex SHA-256 of `sourceKey`, otherwise the server answers
   `{ "type": "error", "message": "sourceKey does not match the room ID" }`.
   Only the room id is handed to viewers. Among holders of the key,
   registration is last-writer-wins: a re-registration for the same room (a
   reconnecting station) replaces the previous source and terminates its socket.
   ```json
   {
     "type": "register-source",
     "roomId": "<hex sha256 of sourceKey>",
     "sourceKey": "<random secret, e.g. 32 bytes hex>",
     "streamName": "Camera 1",
     "mimeType": "video/webm;codecs=\"vp8,opus\""
   }
   ```

2. **Join a room to receive video** (viewer → server)
   ```json
   {
     "type": "join-room",
     "roomId": "unique-room-identifier"
   }
   ```

3. **Source available** (server → viewer, on join or registration). The viewer
   must create its MediaSource SourceBuffer with exactly this mimeType.
   ```json
   {
     "type": "source-available",
     "roomId": "unique-room-identifier",
     "mimeType": "video/webm;codecs=\"vp8,opus\""
   }
   ```

4. **Viewer joined** (server → source). The source restarts its MediaRecorder
   so the new viewer receives a fresh init segment at t=0.
   ```json
   {
     "type": "viewer-joined",
     "roomId": "unique-room-identifier"
   }
   ```

5. **Source disconnected** (server → viewers)
   ```json
   {
     "type": "source-disconnected",
     "roomId": "unique-room-identifier"
   }
   ```

## Configuration Options

### Command Line Arguments

```bash
# Basic server options
node src/server.js [options]

Options:
  --port=NUMBER        Port to listen on (default: 1234)
  --host=STRING        Host to bind to (default: 0.0.0.0)
  --help, -h          Show help message

# SSL/TLS options
  --ssl, --https      Enable HTTPS/WSS with self-signed certificates
  --ssl-key=PATH      Path to SSL private key file
  --ssl-cert=PATH     Path to SSL certificate file
```

### Environment Variables

You can also configure the server using environment variables:

```bash
# Basic configuration
export PORT=3210
export HOST=0.0.0.0
export NODE_ENV=production

# SSL certificate paths
export SSL_KEY=/path/to/private.key
export SSL_CERT=/path/to/certificate.crt

# Start server
node src/server.js
```

### SSL/TLS Certificate Management

#### Self-Signed Certificates (Development)

For development and testing, the server can automatically generate self-signed certificates:

```bash
# Auto-generate self-signed certificates
node src/server.js --ssl
```

Self-signed certificates will be saved in the `./certs/` directory and reused on subsequent starts.

**Browser Security Warnings:** Self-signed certificates will trigger security warnings in browsers. Users need to:
1. Click "Advanced" when the security warning appears
2. Click "Proceed to localhost" (or your domain)
3. Accept the certificate risk

### Standalone Executable

Pre-built standalone executables for Linux, macOS and Windows are on the [GitHub Releases](../../releases) page. They embed Node.js, so the target machine needs no Node.js installation.

| Zip | Platform | Executable |
|-----|----------|------------|
| `edrys-server-linux-x64.zip` | Linux x64 | `edrys-server-linux-x64` |
| `edrys-server-linux-arm64.zip` | Linux arm64 (e.g. Raspberry Pi 4/5, 64-bit OS) | `edrys-server-linux-arm64` |
| `edrys-server-macos-arm64.zip` | macOS, Apple Silicon | `edrys-server-macos-arm64` |
| `edrys-server-macos-x64.zip` | macOS, Intel | `edrys-server-macos-x64` |
| `edrys-server-win-x64.zip` | Windows x64 | `edrys-server-win-x64.exe` |

Each zip holds one folder with the executable, a start script (`start-server.sh` / `start-server.bat`, port 3210) and a `README.txt`. The executables take the same options as `node src/server.js`.

```bash
cd edrys-executable-linux-x64
./start-server.sh                        # or: ./edrys-server-linux-x64 --port 3210
```

The macOS executables are signed ad hoc but not notarized: on first start, right-click the executable and choose *Open*, or run `xattr -d com.apple.quarantine edrys-server-macos-*`.

To build them yourself (Node.js 20+; downloads the official Node.js binaries and checks them against the release's `SHASUMS256.txt`):

```bash
npm run build:sea                        # this platform
npm run build:sea -- --all               # all five
npm run build:sea -- --platform win-x64  # one or more
```

The output goes to `edrys-executable-<platform>/`. Windows and Linux executables can be built on any OS; macOS executables have to be built on macOS, because they must be signed with `codesign` to start there. The embedded Node.js version is `NODE_VERSION` in [`build-sea.mjs`](build-sea.mjs). `TEST_EXEC=edrys-executable-linux-x64/edrys-server-linux-x64 npm test` runs the test suite against an executable.

> **Note:** The `--ssl` / `--https` flag requires **OpenSSL** to be installed on the target machine (used to generate self-signed certificates). On Linux install it with `sudo apt-get install openssl`, on macOS with `brew install openssl`. If you already have certificate files, you can skip this requirement by passing `--ssl-key` and `--ssl-cert` directly.

## Releasing

`npm version <version>` and `git push --follow-tags` on `main`. The tag (without a `v`) starts two workflows: [`publish.yml`](.github/workflows/publish.yml) checks that it matches `package.json`, builds `dist/` and publishes to npm (a pre-release version like `1.2.0-dev.0` under the `next` tag, any other under `latest`); [`release.yml`](.github/workflows/release.yml) builds the standalone executables (macOS ones on a macOS runner), runs the test suite against them and creates the GitHub release.

## License

[MIT](LICENSE) © Kevin Jahns, edrys-labs
