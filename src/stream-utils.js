// Video relay on /stream: a source (the station) registers for a room and
// sends MediaRecorder chunks; viewers join the room and get them verbatim.
//
//   source → { type: 'register-source', roomId, sourceKey, mimeType }  ← source-registered
//   viewer → { type: 'join-room', roomId }                              ← source-available
//   server → source { type: 'viewer-joined' }   (restart: fresh init segment)
//   server → viewers { type: 'source-disconnected' }
//
// roomId must be the hex SHA-256 of sourceKey: viewers know the room id, only
// the source knows the key.

import { createHash, timingSafeEqual } from 'crypto'

/** @type {Set<any>} every connected stream socket */
const clients = new Set()
/** @type {Map<string, any>} roomId -> source socket */
const streamSources = new Map()
let frameCount = 0

// A viewer with more than this queued (it reads slower than the source
// records) is dropped instead of buffering without bound. Skipping chunks
// would corrupt its WebM stream; dropping makes it reconnect and re-join,
// and the source restarts with a fresh init segment.
const MAX_VIEWER_BUFFER = 8 * 1024 * 1024

// Every viewer-joined restarts the source's MediaRecorder for the whole room,
// so they are coalesced: at most one per room per interval, plus one trailing
// one so the last joiner still gets a fresh init segment.
const VIEWER_JOINED_INTERVAL = 1000
/** @type {Map<string, { last: number, timer: ReturnType<typeof setTimeout> | null }>} */
const restartRequests = new Map()

const STATS_INTERVAL = 60000
setInterval(() => {
  if (frameCount > 0) {
    console.log(`Streaming: ${(frameCount * 1000 / STATS_INTERVAL).toFixed(1)} chunks/s, ${clients.size} clients, ${streamSources.size} sources`)
    frameCount = 0
  }
}, STATS_INTERVAL).unref()

/**
 * @param {any} ws
 * @param {object} msg
 */
const sendJSON = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

/**
 * @param {string} roomId
 * @param {object} msg
 * @param {any} [except]
 */
const toRoom = (roomId, msg, except) => {
  clients.forEach(client => {
    if (client !== except && client.roomId === roomId) sendJSON(client, msg)
  })
}

/**
 * Sets up a WebSocket connection for streaming
 * @param {import('ws').WebSocket} socket
 */
export const setupStreamConnection = (socket) => {
  const ws = /** @type {any} */ (socket)
  clients.add(ws)
  ws.isAlive = true

  ws.on('message', (/** @type {any} */ message) => {
    // Any inbound traffic proves the socket is alive.
    ws.isAlive = true

    // Binary = media chunk (Buffer); string = JSON control message (ws 6).
    if (typeof message !== 'string') {
      if (ws.isSource) {
        try {
          handleBinaryFrame(ws, message)
        } catch (err) {
          console.error(`Stream relay error: ${err instanceof Error ? err.message : err}`)
        }
      }
      return
    }

    try {
      const data = JSON.parse(message)
      if (data === null || typeof data !== 'object') return
      if (data.type === 'register-source') handleRegisterSource(ws, data)
      else if (data.type === 'join-room') handleJoinRoom(ws, data)
    } catch (err) {
      // bad JSON, or a send that threw: never let it escape the listener
      console.error(`Stream message error: ${err instanceof Error ? err.message : err}`)
    }
  })

  // 'close' always follows 'error', so cleanup happens there only.
  ws.on('close', () => {
    clients.delete(ws)
    releaseSource(ws)
  })
  ws.on('error', (/** @type {Error} */ err) => {
    console.error(`Stream WebSocket error: ${err.message}`)
  })
  ws.on('pong', () => { ws.isAlive = true })
}

/**
 * @param {any} ws
 * @param {any} data
 */
function handleRegisterSource (ws, data) {
  if (!data.roomId) {
    sendJSON(ws, { type: 'error', message: 'Room ID is required to register as source' })
    return
  }
  const roomId = data.roomId

  // Viewers know the room id, so it can't prove who the source is: the
  // source proves it with the key the room id is the SHA-256 of.
  if (!isRoomKey(roomId, data.sourceKey)) {
    sendJSON(ws, { type: 'error', message: 'sourceKey does not match the room ID' })
    return
  }

  // Moving to another room: the old room no longer has this source.
  if (ws.roomId !== roomId) releaseSource(ws)

  // Last-writer-wins: a station that reconnects while its old socket still
  // lingers (network blip, fast reload) must take over, or it would record
  // into the void with no retry path. Terminate the stale socket; its close
  // handler is a no-op because the map will point at the new socket.
  const existing = streamSources.get(roomId)
  if (existing && existing !== ws && existing.readyState === 1) {
    console.log(`Replacing existing source for room: ${roomId}`)
    existing.terminate()
  }

  // Re-registration by the same socket just updates the mimeType (e.g. audio
  // track toggled).
  ws.isSource = true
  ws.roomId = roomId
  ws.mimeType = data.mimeType
  streamSources.set(roomId, ws)
  console.log(`Stream source registered for room: ${roomId} (${data.mimeType})`)

  sendJSON(ws, { type: 'source-registered', roomId })
  toRoom(roomId, { type: 'source-available', roomId, mimeType: data.mimeType }, ws)
}

/**
 * Whether `roomId` is the hex SHA-256 of `sourceKey`.
 * @param {unknown} roomId
 * @param {unknown} sourceKey
 */
export function isRoomKey (roomId, sourceKey) {
  if (typeof roomId !== 'string' || typeof sourceKey !== 'string') return false
  // Buffer.from(…, 'hex') stops at the first non-hex character: check the form first.
  if (!/^[0-9a-f]{64}$/.test(roomId)) return false
  const expected = createHash('sha256').update(sourceKey).digest()
  return timingSafeEqual(Buffer.from(roomId, 'hex'), expected)
}

/**
 * @param {any} ws
 * @param {any} data
 */
function handleJoinRoom (ws, data) {
  const roomId = data.roomId
  if (!roomId) {
    sendJSON(ws, { type: 'error', message: 'Room ID is required to join a room' })
    return
  }

  // a source that joins another room as a viewer stops being its room's source
  if (ws.roomId !== roomId) releaseSource(ws)
  ws.roomId = roomId

  const source = streamSources.get(roomId)
  if (!source) return
  if (source.readyState !== 1) {
    streamSources.delete(roomId)
    return
  }
  sendJSON(ws, { type: 'source-available', roomId, mimeType: source.mimeType })
  // Ask the source to restart its MediaRecorder so the viewer gets a fresh
  // init segment at t=0 with no timeline gap.
  requestRestart(roomId)
}

/**
 * Send viewer-joined to the room's source, throttled per room (see
 * VIEWER_JOINED_INTERVAL).
 * @param {string} roomId
 */
function requestRestart (roomId) {
  let entry = restartRequests.get(roomId)
  if (!entry) {
    entry = { last: 0, timer: null }
    restartRequests.set(roomId, entry)
  }
  if (entry.timer) return // a trailing one is already scheduled
  const e = entry
  const send = () => {
    e.last = Date.now()
    const source = streamSources.get(roomId)
    if (source) sendJSON(source, { type: 'viewer-joined', roomId })
  }
  const wait = e.last + VIEWER_JOINED_INTERVAL - Date.now()
  if (wait <= 0) {
    send()
  } else {
    e.timer = setTimeout(() => {
      e.timer = null
      send()
    }, wait)
  }
}

/**
 * Relay a binary media chunk to all viewers in the source's room.
 * @param {any} ws
 * @param {Buffer} chunk
 */
function handleBinaryFrame (ws, chunk) {
  const roomId = ws.roomId
  if (!roomId) return
  frameCount++

  clients.forEach(client => {
    if (client === ws || client.readyState !== 1 || client.roomId !== roomId) return
    if (client.bufferedAmount > MAX_VIEWER_BUFFER) {
      console.warn(`Dropping slow stream viewer in room ${roomId} (${client.bufferedAmount} bytes queued)`)
      client.terminate()
      return
    }
    client.send(chunk, { binary: true })
  })
}

/**
 * If `ws` is the registered source of its room, unregister it and tell the
 * room. A no-op when the map already points at another socket (takeover).
 * @param {any} ws
 */
function releaseSource (ws) {
  const roomId = ws.roomId
  if (!ws.isSource || !roomId || streamSources.get(roomId) !== ws) return
  console.log(`Stream source left room: ${roomId}`)
  streamSources.delete(roomId)
  ws.isSource = false
  const pending = restartRequests.get(roomId)
  if (pending && pending.timer) clearTimeout(pending.timer)
  restartRequests.delete(roomId)
  toRoom(roomId, { type: 'source-disconnected', roomId }, ws)
}

/**
 * Ping every stream socket each 5 s; one that did not answer since the last
 * ping is terminated ('close' then cleans up).
 */
export const setupStreamHeartbeat = () => {
  return setInterval(() => {
    clients.forEach(ws => {
      if (ws.isAlive === false) {
        ws.terminate()
        return
      }
      ws.isAlive = false
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    })
  }, 5000)
}
