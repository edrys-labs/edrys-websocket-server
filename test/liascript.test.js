// What LiaScript's WebSocket sync backend (y-generic WebSocketTransport)
// relies on. See LiaScript src/typescript/sync/WebSocket/index.ts and
// src/typescript/sync/Base/security.ts.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import { startServer, connect } from './helpers.js'
import { connectYDoc, MSG_SYNC, makeAwareness, plainAwarenessFrame, isAwareness, parsePlainAwareness, statesIn } from './protocol.js'

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
before(async () => { server = await startServer() })
after(() => server.stop())

const sameBytes = (/** @type {Uint8Array} */ expected) => (/** @type {any} */ m) =>
  typeof m !== 'string' && m.length === expected.length && m.every((/** @type {number} */ v, /** @type {number} */ i) => v === expected[i])

test('password rooms: encrypted text frames are relayed verbatim to the other peers', async () => {
  const a = await connect(server.url('/lia-encrypted'))
  const b = await connect(server.url('/lia-encrypted'))
  await a.next(m => typeof m !== 'string' && m[0] === MSG_SYNC) // server hello
  await b.next(m => typeof m !== 'string' && m[0] === MSG_SYNC)

  // what security.ts puts on the wire: AES output as ASCII (SimpleCrypto is
  // hex salt + iv followed by base64), so the first byte is never 0/1/2/4
  for (const text of ['3f9a0c21d4e5b6a7U2FsdGVkX1+abc/def==', 'U2FsdGVkX19xyz', '+/09AZaz']) {
    const frame = new TextEncoder().encode(text)
    a.send(frame)
    assert.deepEqual(await b.next(sameBytes(frame)), frame)
    await a.expectNone(sameBytes(frame), 100)
  }

  await a.close()
  await b.close()
})

test("the raw [0,0,1,0] SyncStep1 on connect gets the server's document back", async () => {
  // someone already edited the room
  const writer = await connectYDoc(server.url('/lia-pull'))
  writer.doc.getText('t').insert(0, 'from the room')

  const lia = await connect(server.url('/lia-pull'))
  lia.send(new Uint8Array([0, 0, 1, 0]))

  // the answer is a SyncStep2 (sync message subtype 1) carrying the content
  const doc = new Y.Doc()
  for (;;) {
    const m = await lia.next(x => typeof x !== 'string' && x[0] === MSG_SYNC)
    const decoder = decoding.createDecoder(m)
    decoding.readVarUint(decoder)
    if (decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep2) continue
    decoding.readVarUint(decoder)
    Y.applyUpdate(doc, decoding.readVarUint8Array(decoder))
    if (doc.getText('t').toString() === 'from the room') break
  }

  await writer.client.close()
  await lia.close()
})

test('plain y-websocket awareness from a LiaScript client reaches another plain client', async () => {
  const a = await connect(server.url('/lia-aw'))
  const b = await connect(server.url('/lia-aw'))
  const ida = makeAwareness({ name: 'a' })
  const idb = makeAwareness({ name: 'b' })
  b.send(plainAwarenessFrame(idb.update)) // b announces itself: now known as plain
  a.send(plainAwarenessFrame(ida.update))

  await b.next(m => {
    if (!isAwareness(m)) return false
    try { return statesIn(parsePlainAwareness(m)).has(ida.clientID) } catch { return false }
  })

  await a.close()
  await b.close()
})
