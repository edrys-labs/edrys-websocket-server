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
node dist/server.cjs --port 3210
```

#### SSL/TLS Support (HTTPS/WSS)

For secure connections (required when your app is hosted on HTTPS), enable SSL/TLS:

```bash
# Enable SSL with auto-generated self-signed certificates
node dist/server.cjs --ssl --port 3210

# Or use custom certificates
node dist/server.cjs --ssl-key /path/to/private.key --ssl-cert /path/to/certificate.crt --port 3210
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

// For stream source (sender)
ws.onopen = () => {
  // Register as a video source for a specific room
  ws.send(JSON.stringify({
    type: 'register-source',
    roomId: 'my-room-id'
  }))
  
  // Send video frames (example)
  function sendFrame(frameData) {
    ws.send(JSON.stringify({
      type: 'frame',
      data: frameData
    }))
  }
}

// For stream viewer (receiver)
ws.onopen = () => {
  // Join a specific room to receive video
  ws.send(JSON.stringify({
    type: 'join-room',
    roomId: 'my-room-id'
  }))
}

// Handle incoming messages
ws.onmessage = (event) => {
  const data = JSON.parse(event.data)
  
  if (data.type === 'source-available') {
    console.log('A video source is available in this room')
  } else if (data.type === 'frame') {
    // Handle incoming video frame
    displayFrame(data.data)
  }
}
```

## Video Streaming Protocol

The streaming WebSocket endpoint uses a simple JSON-based protocol:

### Message Types:

1. **Register as a stream source**
   ```json
   {
     "type": "register-source",
     "roomId": "unique-room-identifier"
   }
   ```

2. **Join a room to receive video**
   ```json
   {
     "type": "join-room",
     "roomId": "unique-room-identifier"
   }
   ```

3. **Send a video frame**
   ```json
   {
     "type": "frame",
     "data": "base64-encoded-frame-data"
   }
   ```

4. **Ping/pong for latency measurement**
   ```json
   {
     "type": "ping",
     "timestamp": 1620000000000
   }
   ```

5. **Client statistics**
   ```json
   {
     "type": "stats",
     "fps": 30,
     "bufferSize": 2,
     "dropped": 0
   }
   ```

## Configuration Options

### Command Line Arguments

```bash
# Basic server options
node dist/server.cjs [options]

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
node dist/server.cjs
```

### SSL/TLS Certificate Management

#### Self-Signed Certificates (Development)

For development and testing, the server can automatically generate self-signed certificates:

```bash
# Auto-generate self-signed certificates
node dist/server.cjs --ssl
```

Self-signed certificates will be saved in the `./certs/` directory and reused on subsequent starts.

**Browser Security Warnings:** Self-signed certificates will trigger security warnings in browsers. Users need to:
1. Click "Advanced" when the security warning appears
2. Click "Proceed to localhost" (or your domain)
3. Accept the certificate risk

### Standalone Executable

A standalone executable is available that includes all dependencies and doesn't require Node.js installation on the target machine:

```bash
# Build the standalone executable for the current platform
./build-sea.sh

or

# Build for all platforms (Linux, macOS, Windows)
./buid-sea.sh --all 

# Run the standalone executable
cd edrys-executable
./edrys-server --ssl --port 1234
```

The standalone executable supports all the same command-line options as the Node.js version.

## License

[The MIT License](./LICENSE) © Kevin Jahns

Fork maintained by: [edrys-labs](https://github.com/edrys-labs)
