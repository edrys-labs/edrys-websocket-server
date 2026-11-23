// Minimal Yjs / awareness client side of the y-websocket protocol, in the two
// awareness formats the server speaks:
//   edrys-provider:  [1][channel][varUint8Array(update)]
//   plain y-websocket / y-generic: [1][varUint8Array(update)]

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { connect } from './helpers.js'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const CHANNEL_MAIN = 0
export const CHANNEL_APP = 1

/**
 * A Yjs client: keeps a local Y.Doc in sync with the server.
 *
 * @param {string} url
 */
export async function connectYDoc (url) {
  const client = await connect(url)
  const doc = new Y.Doc()
  const send = (/** @type {Uint8Array} */ m) => client.send(m)

  client.ws.on('message', (/** @type {any} */ data) => {
    if (typeof data === 'string') return
    const decoder = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(decoder) !== MSG_SYNC) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'server')
    if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder))
  })
  doc.on('update', (update, origin) => {
    if (origin === 'server') return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    send(encoding.toUint8Array(encoder))
  })
  // sync step 1: ask the server for what we are missing
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(encoding.toUint8Array(encoder))

  return { client, doc }
}

/**
 * Awareness update announcing `state` for a fresh client id.
 *
 * @param {any} state
 */
export function makeAwareness (state) {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  awareness.setLocalState(state)
  const result = {
    clientID: awareness.clientID,
    update: awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])
  }
  // an Awareness runs a timer until destroyed, which keeps the test process alive
  awareness.destroy()
  return result
}

/**
 * @param {Uint8Array} update
 * @param {number} channel
 */
export function edrysAwarenessFrame (update, channel) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS)
  encoding.writeVarUint(encoder, channel)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

/** @param {Uint8Array} update */
export function plainAwarenessFrame (update) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

/** @param {any} m */
export const isAwareness = m => typeof m !== 'string' && m[0] === MSG_AWARENESS

/**
 * Parse an edrys-format awareness frame.
 *
 * @param {Uint8Array} m
 * @return {{ channel: number, update: Uint8Array }}
 */
export function parseEdrysAwareness (m) {
  const decoder = decoding.createDecoder(m)
  decoding.readVarUint(decoder)
  const channel = decoding.readVarUint(decoder)
  const update = decoding.readVarUint8Array(decoder)
  if (decoding.hasContent(decoder)) throw new Error('not an edrys awareness frame')
  return { channel, update }
}

/**
 * Parse a plain-format awareness frame.
 *
 * @param {Uint8Array} m
 */
export function parsePlainAwareness (m) {
  const decoder = decoding.createDecoder(m)
  decoding.readVarUint(decoder)
  const update = decoding.readVarUint8Array(decoder)
  if (decoding.hasContent(decoder)) throw new Error('not a plain awareness frame')
  return update
}

/**
 * Client ids with a (non-null) state after applying `update` to a fresh
 * Awareness, i.e. who the update says is present.
 *
 * @param {Uint8Array} update
 * @return {Map<number, any>}
 */
export function statesIn (update) {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  awareness.setLocalState(null)
  awarenessProtocol.applyAwarenessUpdate(awareness, update, 'test')
  const states = new Map(awareness.getStates())
  awareness.destroy()
  return states
}

/**
 * Client ids an update marks as removed (state null).
 *
 * @param {Uint8Array} update
 * @return {Array<number>}
 */
export function removedIn (update) {
  const decoder = decoding.createDecoder(update)
  const removed = []
  const len = decoding.readVarUint(decoder)
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // clock
    const state = JSON.parse(decoding.readVarString(decoder))
    if (state === null) removed.push(clientID)
  }
  return removed
}
