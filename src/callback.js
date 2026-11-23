// Optional HTTP callback (y-websocket compatible): when CALLBACK_URL is set,
// the shared objects named in CALLBACK_OBJECTS are POSTed as JSON to it
// (debounced) whenever a room's document changes.
//
//   CALLBACK_URL=https://example.org/hook
//   CALLBACK_OBJECTS='{"prosemirror":"XmlFragment","settings":"Map"}'

import http from 'http'
import https from 'https'
import * as number from 'lib0/number'

const CALLBACK_URL = process.env.CALLBACK_URL ? new URL(process.env.CALLBACK_URL) : null
const CALLBACK_TIMEOUT = number.parseInt(process.env.CALLBACK_TIMEOUT || '5000')
const CALLBACK_OBJECTS = process.env.CALLBACK_OBJECTS ? JSON.parse(process.env.CALLBACK_OBJECTS) : {}

export const isCallbackSet = !!CALLBACK_URL

/**
 * @param {import('./utils.js').WSSharedDoc} doc
 */
export const callbackHandler = (doc) => {
  if (!CALLBACK_URL) return
  /** @type {{ room: string, data: Record<string, { type: string, content: any }> }} */
  const dataToSend = { room: doc.name, data: {} }
  for (const [name, type] of Object.entries(CALLBACK_OBJECTS)) {
    const content = getContent(name, type, doc)
    if (content === null) {
      console.warn(`Callback: unknown shared type "${type}" for "${name}" in CALLBACK_OBJECTS, skipped`)
      continue
    }
    dataToSend.data[name] = { type, content: content.toJSON() }
  }
  callbackRequest(CALLBACK_URL, CALLBACK_TIMEOUT, dataToSend)
}

/**
 * @param {URL} url
 * @param {number} timeout
 * @param {Object} data
 */
const callbackRequest = (url, timeout, data) => {
  const body = JSON.stringify(data)
  // http or https as the URL says; keeps the port and the query string
  const req = (url.protocol === 'https:' ? https : http).request(url, {
    timeout,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  })
  req.on('timeout', () => {
    console.warn('Callback request timed out.')
    req.destroy()
  })
  req.on('error', (e) => {
    console.error('Callback request error.', e)
  })
  req.end(body)
}

/**
 * @param {string} objName
 * @param {string} objType
 * @param {import('./utils.js').WSSharedDoc} doc
 * @return {{ toJSON: () => any } | null}
 */
const getContent = (objName, objType, doc) => {
  switch (objType) {
    case 'Array': return doc.getArray(objName)
    case 'Map': return doc.getMap(objName)
    case 'Text': return doc.getText(objName)
    case 'XmlFragment': return doc.getXmlFragment(objName)
    case 'XmlElement': return doc.getXmlElement(objName)
    default: return null
  }
}
