import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, connect } from './helpers.js'
import { MSG_SYNC } from './protocol.js'

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
before(async () => { server = await startServer() })
after(() => server.stop())

const isSync = (/** @type {any} */ m) => typeof m !== 'string' && m[0] === MSG_SYNC

for (const [name, type] of [['pubsub', 2], ['targeted pubsub', 4], ['unknown', 7]]) {
  test(`${name} frames (type ${type}) reach the other peers byte for byte, not the sender`, async () => {
    const room = `/relay-${type}`
    const a = await connect(server.url(room))
    const b = await connect(server.url(room))
    const c = await connect(server.url(room))
    const other = await connect(server.url(`${room}-other`))

    // arbitrary payload, including bytes that would not parse as anything
    const frame = new Uint8Array([type, 0xff, 0x00, 0x80, 1, 2, 3, 0xfe])
    const same = (/** @type {any} */ m) => typeof m !== 'string' && m.length === frame.length && m.every((/** @type {number} */ v, /** @type {number} */ i) => v === frame[i])
    a.send(frame)

    assert.deepEqual(await b.next(same), frame)
    assert.deepEqual(await c.next(same), frame)
    await a.expectNone(same)
    await other.expectNone(same)

    await Promise.all([a, b, c, other].map(x => x.close()))
  })
}

test('/stream goes to the stream relay', async () => {
  const s = await connect(server.url('/stream'))
  s.sendJSON({ type: 'register-source', roomId: 'routing' })
  assert.equal((await s.nextJSON()).type, 'source-registered')
  await s.expectNone(isSync)
  await s.close()
})

for (const path of ['/', '/some-room', '/class/123']) {
  test(`${path} goes to Yjs`, async () => {
    const y = await connect(server.url(path))
    // the server opens every Yjs connection with sync step 1
    await y.next(isSync)
    await y.close()
  })
}

test('the HTTP endpoint answers', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'okay')
})
