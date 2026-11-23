import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { startServer, sleep } from './helpers.js'
import { connectYDoc } from './protocol.js'

test('CALLBACK_URL gets the configured shared objects; unknown types are skipped', async () => {
  /** @type {Array<{ url: string, body: any }>} */
  const posts = []
  const hook = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      posts.push({ url: req.url || '', body: JSON.parse(body) })
      res.end()
    })
  })
  await new Promise(resolve => hook.listen(0, '127.0.0.1', () => resolve(undefined)))
  const hookPort = /** @type {import('net').AddressInfo} */ (hook.address()).port

  const server = await startServer({
    env: {
      CALLBACK_URL: `http://127.0.0.1:${hookPort}/hook?token=abc`,
      CALLBACK_OBJECTS: JSON.stringify({ notes: 'Text', meta: 'Map', bogus: 'NotAType' }),
      CALLBACK_DEBOUNCE_WAIT: '50',
      CALLBACK_DEBOUNCE_MAXWAIT: '100'
    }
  })
  try {
    const a = await connectYDoc(server.url('/cb-room'))
    a.doc.getText('notes').insert(0, 'hello')
    a.doc.getMap('meta').set('k', 1)

    const deadline = Date.now() + 3000
    while (!posts.some(p => p.body.data.notes?.content === 'hello' && p.body.data.meta?.content?.k === 1)) {
      if (Date.now() > deadline) throw new Error(`no matching callback; got ${JSON.stringify(posts)}\n${server.log()}`)
      await sleep(25)
    }
    const post = posts[posts.length - 1]
    assert.equal(post.url, '/hook?token=abc')
    assert.equal(post.body.room, 'cb-room')
    assert.deepEqual(post.body.data.notes, { type: 'Text', content: 'hello' })
    assert.equal(post.body.data.bogus, undefined)
    assert.equal(server.child.exitCode, null, 'server still running')

    await a.client.close()
  } finally {
    await server.stop()
    hook.close()
  }
})
