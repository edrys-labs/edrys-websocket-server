// Store active connections
const clients = new Set();
// Store active stream sources
const streamSources = new Map(); // roomId -> source connection
let lastFrameTime = 0;
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
export const setupStreamConnection = (ws, req) => {
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
  const now = Date.now();
  if (now - lastFrameTime > 5000) {
    lastFrameTime = now;
  }
  
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
export const setupStreamHeartbeat = (wss) => {
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
export const cleanup = () => {
  clearInterval(statsInterval);
};
