// Store active connections
const clients = new Set();
// Store active stream sources
const streamSources = new Map(); // roomId -> source connection
let frameCount = 0;

// Log throughput periodically
const statsInterval = setInterval(() => {
  if (frameCount > 0) {
    console.log(`Streaming at ${frameCount / 5} chunks/s, ${clients.size} clients connected, ${streamSources.size} active sources`);
    frameCount = 0;
  }
}, 5000);

/**
 * Sets up a WebSocket connection for streaming
 * @param {import('ws').WebSocket} ws - WebSocket connection
 * @param {import('http').IncomingMessage} req - HTTP request
 */
export const setupStreamConnection = (ws, req) => {
  clients.add(ws);
  console.log(`Stream client connected (total=${clients.size}, sources=${streamSources.size})`);

  /** @type {any} */ (ws).isAlive = true;

  // Handle messages from clients
  ws.on('message', (message) => {
    try {
      // Any inbound traffic proves the socket is alive.
      /** @type {any} */ (ws).isAlive = true;

      // Binary = media chunk (Buffer); string = JSON control message.
      if (typeof message !== 'string') {
        if (/** @type {any} */ (ws).isSource) handleBinaryFrame(ws, message);
        return;
      }

      let data;
      try {
        data = JSON.parse(message);
      } catch (e) {
        console.error('Failed to parse message as JSON:', e);
        return;
      }

      if (data.type === 'register-source') {
        handleRegisterSource(ws, data);
      }
      else if (data.type === 'join-room') {
        handleJoinRoom(ws, data);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
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
 */
function handleRegisterSource(ws, data) {
  // Require a roomId for registration
  if (!data.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room ID is required to register as source'
    }));
    return;
  }

  const roomId = data.roomId;

  // Last-writer-wins: a station that reconnects while its old socket still
  // lingers (network blip, fast reload) must take over, or it would record
  // into the void with no retry path. Terminate the stale socket; its close
  // handler is a no-op because the map will point at the new socket.
  const existing = streamSources.get(roomId);
  if (existing && existing !== ws && existing.readyState === 1) {
    console.log(`Replacing existing source for room: ${roomId}`);
    existing.terminate();
  }

  // Register this client as the source for the room. Re-registration by the
  // same socket just updates the mimeType (e.g. audio track toggled).
  /** @type {any} */ (ws).isSource = true;
  /** @type {any} */ (ws).roomId = roomId;
  /** @type {any} */ (ws).mimeType = data.mimeType;
  streamSources.set(roomId, ws);
  console.log(`Stream source registered for room: ${roomId} (${data.mimeType})`);

  // Confirm successful registration
  ws.send(JSON.stringify({ type: 'source-registered', roomId: roomId }));

  // Notify all clients in the same room that a source is available
  clients.forEach((client) => {
    if (client !== ws &&
        client.readyState === 1 &&
        /** @type {any} */ (client).roomId === roomId) {
      client.send(JSON.stringify({ type: 'source-available', roomId: roomId, mimeType: data.mimeType }));
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
        roomId: roomId,
        mimeType: /** @type {any} */ (source).mimeType,
      }));
      // Ask the source to restart its MediaRecorder so the viewer gets a fresh
      // init segment at t=0 with no timeline gap.
      source.send(JSON.stringify({ type: 'viewer-joined', roomId: roomId }));
    } else {
      streamSources.delete(roomId);
    }
  }
}

/**
 * Relay a binary media chunk to all clients in the source's room.
 * @param {import('ws').WebSocket} ws
 * @param {any} chunk
 */
function handleBinaryFrame(ws, chunk) {
  const roomId = /** @type {any} */ (ws).roomId;
  if (!roomId) return;

  frameCount++;

  clients.forEach((client) => {
    if (client === ws ||
        client.readyState !== 1 ||
        /** @type {any} */ (client).roomId !== roomId) {
      return;
    }
    try {
      client.send(chunk, { binary: true });
    } catch (error) {
      console.error('Error sending to client:', error);
    }
  });
}

/**
 * Handle client disconnection
 * @param {import('ws').WebSocket} ws
 */
function handleDisconnect(ws) {
  clients.delete(ws);
  console.log(`[ws] disconnect isSource=${!!(/** @type {any} */ (ws).isSource)} room=${/** @type {any} */ (ws).roomId} → clients=${clients.size} sources=${streamSources.size}`);

  // If this was a stream source, remove it ONLY if the map still points to this
  // exact socket.
  const roomId = /** @type {any} */ (ws).roomId;
  if (/** @type {any} */ (ws).isSource && roomId && streamSources.get(roomId) === ws) {
    console.log(`Stream source disconnected from room: ${roomId}`);
    streamSources.delete(roomId);

    // Notify room clients that the source has disconnected
    clients.forEach((client) => {
      if (client.readyState === 1 && /** @type {any} */ (client).roomId === roomId) {
        client.send(JSON.stringify({
          type: 'source-disconnected',
          roomId: roomId
        }));
      }
    });
  }
}

/**
 * Set up heartbeat system for stream clients
 * @param {import('ws').Server} wss - WebSocket server
 */
export const setupStreamHeartbeat = (wss) => {
  const pingInterval = setInterval(() => {
    clients.forEach((ws) => {
      if (ws.isAlive === false) {
        handleDisconnect(ws);
        return ws.terminate();
      }

      ws.isAlive = false;

      try {
        ws.ping();
      } catch (e) {
        // Client might be dead
        console.error("Failed to ping stream client", e);
        handleDisconnect(ws);
      }
    });
  }, 5000);

  return pingInterval;
};

/**
 * Clean up resources
 */
export const cleanup = () => {
  clearInterval(statsInterval);
};
