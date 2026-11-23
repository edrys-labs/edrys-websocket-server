// Shared helpers for the integration tests: start the real server as a child
// process (the same way edrys-module-tests does) and talk to it over real
// WebSockets.

import { spawn } from 'child_process'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @return {Promise<number>} */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.unref()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {net.AddressInfo} */ (srv.address())
    srv.close(() => resolve(port))
  })
})

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Start `node src/server.js --port <free> --host 127.0.0.1` and wait until it
 * answers HTTP.
 *
 * @param {{ entry?: string, env?: Record<string, string> }} [opts]
 */
export async function startServer (opts = {}) {
  const port = await freePort()
  let output = ''
  // TEST_ENTRY=dist/server.cjs runs the suite against the built bundle (what Docker runs)
  const entry = opts.entry || process.env.TEST_ENTRY || 'src/server.js'
  const child = spawn(process.execPath, [entry, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', ...opts.env }
  })
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })

  const deadline = Date.now() + 10000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${output}`)
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      break
    } catch {}
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`server did not answer on port ${port}:\n${output}`)
    }
    await sleep(50)
  }

  return {
    port,
    /** @param {string} p */
    url: p => `ws://127.0.0.1:${port}${p}`,
    log: () => output,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
}

/**
 * A WebSocket client that queues every message it receives, so tests can wait
 * for a matching message without racing the socket.
 */
export class Client {
  /** @param {WebSocket} ws */
  constructor (ws) {
    this.ws = ws
    /** @type {Array<Uint8Array|string>} */
    this.queue = []
    /** @type {Array<{ match: (m: any) => boolean, resolve: (m: any) => void }>} */
    this.waiters = []
    ws.on('message', (/** @type {any} */ data) => {
      const msg = typeof data === 'string' ? data : new Uint8Array(data)
      const i = this.waiters.findIndex(w => w.match(msg))
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg)
      else this.queue.push(msg)
    })
  }

  /**
   * Resolve with (and remove) the first queued or future message `match`
   * accepts.
   *
   * @param {(m: any) => boolean} [match]
   * @param {number} [timeout]
   * @return {Promise<any>}
   */
  next (match = () => true, timeout = 2000) {
    const i = this.queue.findIndex(match)
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (/** @type {any} */ m) => { clearTimeout(timer); resolve(m) }
      }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error('timed out waiting for a message'))
      }, timeout)
      this.waiters.push(waiter)
    })
  }

  /** Next JSON (text) message, optionally of a given `type`. @param {string} [type] */
  async nextJSON (type) {
    const msg = await this.next(m => typeof m === 'string' && (type === undefined || JSON.parse(m).type === type))
    return JSON.parse(msg)
  }

  /**
   * Wait `ms` and fail if a message `match` accepts arrived meanwhile.
   *
   * @param {(m: any) => boolean} [match]
   * @param {number} [ms]
   */
  async expectNone (match = () => true, ms = 200) {
    await sleep(ms)
    const m = this.queue.find(match)
    if (m !== undefined) throw new Error(`unexpected message: ${typeof m === 'string' ? m : Array.from(m).join(',')}`)
  }

  /** @param {any} data */
  send (data) { this.ws.send(data) }
  /** @param {object} obj */
  sendJSON (obj) { this.ws.send(JSON.stringify(obj)) }

  close () {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise(resolve => {
      this.ws.once('close', resolve)
      this.ws.close()
    })
  }
}

/**
 * @param {string} url
 * @return {Promise<Client>}
 */
export function connect (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    // attach the queue before 'open' so nothing sent on connect is lost
    const client = new Client(ws)
    ws.once('open', () => resolve(client))
    ws.once('error', reject)
  })
}

export { sleep }
