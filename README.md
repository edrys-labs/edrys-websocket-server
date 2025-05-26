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

The server exposes two WebSocket endpoints:

* `ws://hostname:port/` - For Yjs document collaboration
* `ws://hostname:port/stream` - For video streaming

## Client Usage

### For Yjs document collaboration:

```js
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const doc = new Y.Doc()
const wsProvider = new WebsocketProvider('ws://localhost:1234', 'my-roomname', doc)

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

## License

[The MIT License](./LICENSE) © Kevin Jahns

Fork maintained by: [edrys-labs](https://github.com/edrys-labs)
