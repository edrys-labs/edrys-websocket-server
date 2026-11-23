import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, connect } from './helpers.js'

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
before(async () => { server = await startServer() })
after(() => server.stop())

const stream = () => connect(server.url('/stream'))
const isBinary = (/** @type {any} */ m) => typeof m !== 'string'

/**
 * @param {string} roomId
 * @param {string} [mimeType]
 */
async function source (roomId, mimeType = 'video/webm') {
  const s = await stream()
  s.sendJSON({ type: 'register-source', roomId, mimeType })
  assert.deepEqual(await s.nextJSON('source-registered'), { type: 'source-registered', roomId })
  return s
}

/** @param {string} roomId */
async function viewer (roomId) {
  const v = await stream()
  v.sendJSON({ type: 'join-room', roomId })
  return v
}

test('register-source and join-room need a roomId', async () => {
  const s = await stream()
  s.sendJSON({ type: 'register-source' })
  assert.equal((await s.nextJSON('error')).message, 'Room ID is required to register as source')
  s.sendJSON({ type: 'join-room' })
  assert.equal((await s.nextJSON('error')).message, 'Room ID is required to join a room')
  await s.close()
})

test('a viewer joining a room with a source gets source-available, the source gets viewer-joined', async () => {
  const s = await source('join', 'video/webm;codecs=vp8')
  const v = await viewer('join')
  assert.deepEqual(await v.nextJSON('source-available'), { type: 'source-available', roomId: 'join', mimeType: 'video/webm;codecs=vp8' })
  assert.deepEqual(await s.nextJSON('viewer-joined'), { type: 'viewer-joined', roomId: 'join' })
  await s.close()
  await v.close()
})

test('a source registering after the viewer joined announces itself', async () => {
  const v = await viewer('late-source')
  await v.expectNone()
  const s = await source('late-source')
  assert.equal((await v.nextJSON('source-available')).mimeType, 'video/webm')
  await s.close()
  await v.close()
})

test('binary chunks reach only viewers of the same room, unchanged', async () => {
  const s = await source('chunks')
  const v1 = await viewer('chunks')
  const v2 = await viewer('chunks')
  const elsewhere = await viewer('chunks-other')
  await v1.nextJSON('source-available')
  await v2.nextJSON('source-available')

  const chunk = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 255])
  s.send(chunk)
  assert.deepEqual(await v1.next(isBinary), new Uint8Array(chunk))
  assert.deepEqual(await v2.next(isBinary), new Uint8Array(chunk))
  await elsewhere.expectNone(isBinary)
  await s.expectNone(isBinary)

  await Promise.all([s, v1, v2, elsewhere].map(x => x.close()))
})

test('binary from a non-source is ignored', async () => {
  const v1 = await viewer('not-a-source')
  const v2 = await viewer('not-a-source')
  v1.send(Buffer.from([1, 2, 3]))
  await v2.expectNone(isBinary)
  await v1.close()
  await v2.close()
})

test('a second source takes over the room without a source-disconnected', async () => {
  const s1 = await source('takeover')
  const v = await viewer('takeover')
  await v.nextJSON('source-available')

  const closed = new Promise(resolve => s1.ws.once('close', resolve))
  const s2 = await source('takeover', 'video/mp4')
  await closed // the old source is terminated
  assert.equal((await v.nextJSON('source-available')).mimeType, 'video/mp4')
  await v.expectNone(m => typeof m === 'string' && JSON.parse(m).type === 'source-disconnected')

  s2.send(Buffer.from([9, 9]))
  assert.deepEqual(await v.next(isBinary), new Uint8Array([9, 9]))

  await s2.close()
  await v.close()
})

test('a source leaving sends source-disconnected to its room', async () => {
  const s = await source('leave')
  const v = await viewer('leave')
  await v.nextJSON('source-available')
  await s.close()
  assert.deepEqual(await v.nextJSON('source-disconnected'), { type: 'source-disconnected', roomId: 'leave' })
  await v.close()
})
