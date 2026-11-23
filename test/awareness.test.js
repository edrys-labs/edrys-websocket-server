import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, connect } from './helpers.js'
import {
  CHANNEL_MAIN, CHANNEL_APP, makeAwareness, edrysAwarenessFrame, plainAwarenessFrame,
  isAwareness, parseEdrysAwareness, parsePlainAwareness, statesIn, removedIn
} from './protocol.js'

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
before(async () => { server = await startServer() })
after(() => server.stop())

/**
 * Edrys-format awareness frame on `channel` that mentions `clientID`.
 *
 * @param {number} channel
 * @param {number} clientID
 */
const edrysFrameFor = (channel, clientID) => (/** @type {any} */ m) => {
  if (!isAwareness(m)) return false
  try {
    const { channel: c, update } = parseEdrysAwareness(m)
    return c === channel && (statesIn(update).has(clientID) || removedIn(update).includes(clientID))
  } catch { return false }
}

test('an awareness update is broadcast on the channel it was sent on', async () => {
  const a = await connect(server.url('/aw-broadcast'))
  const b = await connect(server.url('/aw-broadcast'))

  const main = makeAwareness({ user: 'a' })
  a.send(edrysAwarenessFrame(main.update, CHANNEL_MAIN))
  const gotMain = parseEdrysAwareness(await b.next(edrysFrameFor(CHANNEL_MAIN, main.clientID)))
  assert.deepEqual(statesIn(gotMain.update).get(main.clientID), { user: 'a' })

  const app = makeAwareness({ cursor: 3 })
  a.send(edrysAwarenessFrame(app.update, CHANNEL_APP))
  const gotApp = parseEdrysAwareness(await b.next(edrysFrameFor(CHANNEL_APP, app.clientID)))
  assert.deepEqual(statesIn(gotApp.update).get(app.clientID), { cursor: 3 })

  await a.close()
  await b.close()
})

test('main and app channels are separate states', async () => {
  const a = await connect(server.url('/aw-separate'))
  const app = makeAwareness({ cursor: 1 })
  a.send(edrysAwarenessFrame(app.update, CHANNEL_APP))
  await a.next(edrysFrameFor(CHANNEL_APP, app.clientID)) // the echo: the server applied it

  // a joiner is seeded with the app state only; main is still empty
  const c = await connect(server.url('/aw-separate'))
  const seed = parseEdrysAwareness(await c.next(isAwareness))
  assert.equal(seed.channel, CHANNEL_APP)
  assert.ok(statesIn(seed.update).has(app.clientID))
  await c.expectNone(isAwareness)

  await a.close()
  await c.close()
})

test('a joiner is seeded on both channels', async () => {
  const a = await connect(server.url('/aw-seed'))
  const main = makeAwareness({ user: 'a' })
  const app = makeAwareness({ cursor: 7 })
  a.send(edrysAwarenessFrame(main.update, CHANNEL_MAIN))
  a.send(edrysAwarenessFrame(app.update, CHANNEL_APP))
  await a.next(edrysFrameFor(CHANNEL_MAIN, main.clientID))
  await a.next(edrysFrameFor(CHANNEL_APP, app.clientID))

  const c = await connect(server.url('/aw-seed'))
  await c.next(edrysFrameFor(CHANNEL_MAIN, main.clientID))
  await c.next(edrysFrameFor(CHANNEL_APP, app.clientID))

  await a.close()
  await c.close()
})

test('a plain y-websocket client is detected and re-seeded in its format', async () => {
  const a = await connect(server.url('/aw-plain'))
  const main = makeAwareness({ user: 'a' })
  const app = makeAwareness({ cursor: 2 })
  a.send(edrysAwarenessFrame(main.update, CHANNEL_MAIN))
  a.send(edrysAwarenessFrame(app.update, CHANNEL_APP))
  await a.next(edrysFrameFor(CHANNEL_MAIN, main.clientID))
  await a.next(edrysFrameFor(CHANNEL_APP, app.clientID))

  const p = await connect(server.url('/aw-plain'))
  // the seed on connect is in edrys format, before the server knows better
  await p.next(edrysFrameFor(CHANNEL_MAIN, main.clientID))
  await p.next(edrysFrameFor(CHANNEL_APP, app.clientID))

  const plain = makeAwareness({ user: 'plain' })
  p.send(plainAwarenessFrame(plain.update))

  // re-seed of the main channel, plain format
  const reseed = parsePlainAwareness(await p.next(isAwareness))
  assert.ok(statesIn(reseed).has(main.clientID))

  // the edrys client sees the plain client's state on the main channel
  await a.next(edrysFrameFor(CHANNEL_MAIN, plain.clientID))

  // from now on the plain client gets no app-channel frames
  const app2 = makeAwareness({ cursor: 9 })
  a.send(edrysAwarenessFrame(app2.update, CHANNEL_APP))
  await a.next(edrysFrameFor(CHANNEL_APP, app2.clientID))
  await p.expectNone(m => {
    if (!isAwareness(m)) return false
    try { return statesIn(parsePlainAwareness(m)).has(app2.clientID) } catch { return true }
  })

  await a.close()
  await p.close()
})

test('a disconnect removes the client from both channels', async () => {
  const a = await connect(server.url('/aw-leave'))
  const b = await connect(server.url('/aw-leave'))
  const main = makeAwareness({ user: 'a' })
  const app = makeAwareness({ cursor: 5 })
  // the server tracks which client ids a connection controls; here a
  // announces one id per channel
  a.send(edrysAwarenessFrame(main.update, CHANNEL_MAIN))
  a.send(edrysAwarenessFrame(app.update, CHANNEL_APP))
  await b.next(edrysFrameFor(CHANNEL_MAIN, main.clientID))
  await b.next(edrysFrameFor(CHANNEL_APP, app.clientID))

  await a.close()

  const isRemoval = (/** @type {number} */ channel, /** @type {number} */ id) => (/** @type {any} */ m) => {
    if (!edrysFrameFor(channel, id)(m)) return false
    return removedIn(parseEdrysAwareness(m).update).includes(id)
  }
  await b.next(isRemoval(CHANNEL_MAIN, main.clientID))
  await b.next(isRemoval(CHANNEL_APP, app.clientID))

  await b.close()
})
