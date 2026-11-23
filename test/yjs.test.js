import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, sleep } from './helpers.js'
import { connectYDoc } from './protocol.js'

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
before(async () => { server = await startServer() })
after(() => server.stop())

/**
 * @param {() => boolean} cond
 * @param {number} [timeout]
 */
async function until (cond, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(20)
  }
}

test('two clients in a room converge', async () => {
  const a = await connectYDoc(server.url('/converge'))
  const b = await connectYDoc(server.url('/converge'))

  a.doc.getText('t').insert(0, 'hello')
  await until(() => b.doc.getText('t').toString() === 'hello')

  b.doc.getMap('m').set('k', 42)
  await until(() => a.doc.getMap('m').get('k') === 42)

  await a.client.close()
  await b.client.close()
})

test('a late joiner gets the existing state from the server', async () => {
  const a = await connectYDoc(server.url('/late'))
  a.doc.getText('t').insert(0, 'before you came')
  // a is still connected, so the room (and its server-side doc) stays alive
  await sleep(100)

  const c = await connectYDoc(server.url('/late'))
  await until(() => c.doc.getText('t').toString() === 'before you came')

  await a.client.close()
  await c.client.close()
})

test('a room nobody is in anymore starts empty again', async () => {
  const a = await connectYDoc(server.url('/emptied'))
  a.doc.getText('t').insert(0, 'gone when everyone leaves')
  await sleep(100)
  await a.client.close()
  await sleep(100)

  const b = await connectYDoc(server.url('/emptied'))
  await sleep(200)
  assert.equal(b.doc.getText('t').toString(), '')
  await b.client.close()
})

test('rooms are isolated from each other', async () => {
  const a = await connectYDoc(server.url('/iso-a'))
  const b = await connectYDoc(server.url('/iso-b'))

  a.doc.getText('t').insert(0, 'only in a')
  await sleep(200)
  assert.equal(b.doc.getText('t').toString(), '')

  await a.client.close()
  await b.client.close()
})

test('the room name ignores the query string', async () => {
  const a = await connectYDoc(server.url('/query?token=1'))
  const b = await connectYDoc(server.url('/query?token=2'))

  a.doc.getText('t').insert(0, 'same room')
  await until(() => b.doc.getText('t').toString() === 'same room')

  await a.client.close()
  await b.client.close()
})
