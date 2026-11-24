import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, connect, sleep, keyed, room } from './helpers.js'

const YJS_MAX = 64 * 1024

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
// a small Yjs limit keeps the test fast; the stream limit is the fixed 5 MiB
before(async () => { server = await startServer({ env: { YJS_MAX_PAYLOAD: String(YJS_MAX) } }) })
after(() => server.stop())

const isBinary = (/** @type {any} */ m) => typeof m !== 'string'
// ws 6 drops the socket on a protocol error (1006); newer ws sends 1009/1002
const CLOSED = [1006, 1009, 1002]
/** @param {import('./helpers.js').Client} c */
const closeCode = c => new Promise(resolve => c.ws.once('close', code => resolve(code)))

test('a Yjs frame over YJS_MAX_PAYLOAD closes the connection, one under it is relayed', async () => {
  const a = await connect(server.url('/limit'))
  const b = await connect(server.url('/limit'))

  const ok = new Uint8Array(YJS_MAX - 16).fill(1)
  ok[0] = 2 // pubsub, relayed verbatim
  a.send(ok)
  assert.equal((await b.next(m => isBinary(m) && m.length === ok.length)).length, ok.length)

  const tooBig = new Uint8Array(YJS_MAX + 1).fill(1)
  tooBig[0] = 2
  const closed = closeCode(a)
  a.send(tooBig)
  assert.ok(CLOSED.includes(/** @type {number} */ (await closed)))
  await b.expectNone(m => isBinary(m) && m.length === tooBig.length)

  await b.close()
})

for (const path of ['/malformed', '/stream']) {
  test(`a malformed frame on ${path} closes that connection only, the server stays up`, async () => {
    const bad = await connect(server.url(path))
    const other = await connect(server.url(path))
    const closed = closeCode(bad)
    // a frame with the reserved opcode 3, written raw to the socket
    const socket = /** @type {any} */ (bad.ws)._socket
    socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]))
    assert.ok(CLOSED.includes(/** @type {number} */ (await closed)))
    assert.equal(other.ws.readyState, 1)
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/`)).status, 200)
    await other.close()
  })
}

test('a stream frame over 5 MiB closes the connection', async () => {
  const s = await connect(server.url('/stream'))
  s.sendJSON({ type: 'register-source', ...keyed('limit') })
  await s.nextJSON('source-registered')
  const closed = closeCode(s)
  s.send(Buffer.alloc(5 * 1024 * 1024 + 1))
  assert.ok(CLOSED.includes(/** @type {number} */ (await closed)))
})

test('viewer-joined is coalesced per room: one at once, one trailing', async () => {
  const s = await connect(server.url('/stream'))
  s.sendJSON({ type: 'register-source', ...keyed('burst') })
  await s.nextJSON('source-registered')
  const isJoined = (/** @type {any} */ m) => typeof m === 'string' && JSON.parse(m).type === 'viewer-joined'

  const viewers = []
  const join = async () => {
    const v = await connect(server.url('/stream'))
    v.sendJSON({ type: 'join-room', roomId: room('burst') })
    viewers.push(v)
    await v.nextJSON('source-available')
  }

  await join()
  await s.next(isJoined)
  const first = Date.now()

  // a burst of joins right after: no restart now, one after the interval
  await join()
  await join()
  await join()
  await s.expectNone(isJoined, 300)
  await s.next(isJoined, 2000)
  assert.ok(Date.now() - first >= 900, 'the trailing viewer-joined waits for the interval')
  await s.expectNone(isJoined, 1300)

  await Promise.all([s, ...viewers].map(x => x.close()))
})

test('a viewer that does not keep up is dropped, the others get every chunk', async () => {
  const s = await connect(server.url('/stream'))
  s.sendJSON({ type: 'register-source', ...keyed('slow') })
  await s.nextJSON('source-registered')
  const fast = await connect(server.url('/stream'))
  const slow = await connect(server.url('/stream'))
  for (const v of [fast, slow]) {
    v.sendJSON({ type: 'join-room', roomId: room('slow') })
    await v.nextJSON('source-available')
  }

  // the slow viewer stops reading; its data backs up on the server
  const slowSocket = /** @type {any} */ (slow.ws)._socket
  slowSocket.pause()
  const slowClosed = closeCode(slow)

  const CHUNKS = 40
  const chunk = Buffer.alloc(2 * 1024 * 1024, 7)
  for (let i = 0; i < CHUNKS; i++) {
    s.send(chunk)
    await fast.next(isBinary, 5000)
  }

  slowSocket.resume()
  await slowClosed
  await sleep(50)
  const slowGot = slow.queue.filter(isBinary).length
  assert.ok(slowGot < CHUNKS, `slow viewer was dropped (got ${slowGot}/${CHUNKS})`)

  await s.close()
  await fast.close()
})
