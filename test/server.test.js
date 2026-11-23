// Process-level behavior of server.js: routing, signals, errors, output, TLS.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { startServer, connect, get } from './helpers.js'
import { MSG_SYNC } from './protocol.js'

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server
before(async () => { server = await startServer() })
after(() => server.stop())

const isSync = (/** @type {any} */ m) => typeof m !== 'string' && m[0] === MSG_SYNC

/** @param {import('child_process').ChildProcess} child */
const exited = child => new Promise(resolve => {
  if (child.exitCode !== null) resolve(child.exitCode)
  else child.once('exit', code => resolve(code))
})

/** @param {number} ms */
const timeout = ms => new Promise((resolve, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))

for (const p of ['/stream', '/stream/', '/stream?x=1']) {
  test(`${p} goes to the stream relay`, async () => {
    const s = await connect(server.url(p))
    s.sendJSON({ type: 'register-source', roomId: `route${p}` })
    assert.equal((await s.nextJSON()).type, 'source-registered')
    await s.close()
  })
}

for (const p of ['/streamlab', '/streaming-class', '/x/stream']) {
  test(`${p} is a Yjs room, not the stream relay`, async () => {
    const y = await connect(server.url(p))
    await y.next(isSync)
    await y.close()
  })
}

test('a malformed request target on upgrade does not take the server down', async () => {
  await new Promise((resolve, reject) => {
    const sock = net.connect(server.port, '127.0.0.1', () => {
      sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    })
    sock.on('close', resolve)
    sock.on('error', resolve)
    setTimeout(() => { sock.destroy(); reject(new Error('socket not closed')) }, 2000)
  })
  assert.equal(server.child.exitCode, null)
  assert.equal((await get(`${server.base}/`)).body, 'okay')
})

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
  test(`${signal} shuts down cleanly (exit code 0)`, async () => {
    const s = await startServer()
    s.child.kill(signal)
    assert.equal(await Promise.race([exited(s.child), timeout(3000)]), 0)
  })
}

test('a port that is already in use makes the server exit with an error', async () => {
  const child = spawn(process.execPath, ['src/server.js', '--port', String(server.port), '--host', '127.0.0.1'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'ignore'
  })
  const code = await Promise.race([exited(child), timeout(3000)]).catch(e => { child.kill('SIGKILL'); throw e })
  assert.notEqual(code, 0)
})

test('NO_COLOR turns off ANSI colors', async () => {
  // startServer always sets NO_COLOR=1
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(server.log(), /\x1b\[/)
})

test('a source that re-registers in another room releases the old one', async () => {
  const s = await connect(server.url('/stream'))
  s.sendJSON({ type: 'register-source', roomId: 'move-a' })
  await s.nextJSON('source-registered')
  const va = await connect(server.url('/stream'))
  va.sendJSON({ type: 'join-room', roomId: 'move-a' })
  await va.nextJSON('source-available')

  s.sendJSON({ type: 'register-source', roomId: 'move-b' })
  await s.nextJSON('source-registered')
  assert.deepEqual(await va.nextJSON('source-disconnected'), { type: 'source-disconnected', roomId: 'move-a' })

  // a new viewer of the old room finds no source
  const va2 = await connect(server.url('/stream'))
  va2.sendJSON({ type: 'join-room', roomId: 'move-a' })
  await va2.expectNone(m => typeof m === 'string' && JSON.parse(m).type === 'source-available')

  await Promise.all([s, va, va2].map(x => x.close()))
})

// --- TLS ------------------------------------------------------------------

const hasOpenSSL = (() => { try { execFileSync('openssl', ['version']); return true } catch { return false } })()

/** @param {string} dir @param {number} days @param {string} subj */
function makeCert (dir, days, subj) {
  fs.mkdirSync(path.join(dir, 'certs'), { recursive: true })
  execFileSync('openssl', ['req', '-nodes', '-new', '-x509', '-days', String(days), '-subj', subj,
    '-keyout', path.join(dir, 'certs', 'server-key.pem'), '-out', path.join(dir, 'certs', 'server-cert.pem')], { stdio: 'ignore' })
}

/** @param {string} dir */
const certOf = dir => new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'certs', 'server-cert.pem')))
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edrys-ws-tls-'))

test('--ssl generates a self-signed certificate and serves https and wss', { skip: !hasOpenSSL && 'no openssl' }, async () => {
  const dir = tmpDir()
  const s = await startServer({ args: ['--ssl'], cwd: dir, https: true })
  try {
    assert.equal((await get(`${s.base}/`)).body, 'okay')
    const y = await connect(s.url('/tls-room'))
    await y.next(isSync)
    await y.close()

    const cert = certOf(dir)
    assert.ok(new Date(cert.validTo).getTime() > Date.now() + 300 * 24 * 3600 * 1000)
    assert.ok(cert.subjectAltName?.includes('DNS:localhost'))
    assert.ok(!cert.subjectAltName?.includes('0.0.0.0'))
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--ssl renews its own self-signed certificate when it is about to expire', { skip: !hasOpenSSL && 'no openssl' }, async () => {
  const dir = tmpDir()
  makeCert(dir, 1, '/C=US/ST=Local/L=Local/O=Edrys/OU=WebSocket/CN=localhost')
  const s = await startServer({ args: ['--ssl'], cwd: dir, https: true })
  try {
    assert.ok(new Date(certOf(dir).validTo).getTime() > Date.now() + 300 * 24 * 3600 * 1000, 'renewed')
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--ssl does not overwrite a certificate someone else put in certs/', { skip: !hasOpenSSL && 'no openssl' }, async () => {
  const dir = tmpDir()
  makeCert(dir, 1, '/O=Some University/CN=lab.example.org')
  const before = fs.readFileSync(path.join(dir, 'certs', 'server-cert.pem'), 'utf8')
  const s = await startServer({ args: ['--ssl'], cwd: dir, https: true })
  try {
    assert.equal(fs.readFileSync(path.join(dir, 'certs', 'server-cert.pem'), 'utf8'), before)
    assert.match(s.log(), /expire/i)
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
