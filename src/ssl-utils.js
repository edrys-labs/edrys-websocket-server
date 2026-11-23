// SSL/TLS utility functions for HTTPS/WSS support
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'

// Subject of the certificates this server makes; used to tell them apart
// from certificates someone put into certs/ themselves.
const SUBJECT = '/C=US/ST=Local/L=Local/O=Edrys/OU=WebSocket/CN=localhost'
const DAYS = 365
// Renew a self-signed certificate this long before it expires.
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000

/**
 * Generate a self-signed certificate for development/testing
 * @param {string} certDir - Directory to store certificates
 * @returns {Object} - Object containing key and cert paths
 */
export function generateSelfSignedCert (certDir = './certs') {
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true })
  }

  const keyPath = path.join(certDir, 'server-key.pem')
  const certPath = path.join(certDir, 'server-cert.pem')

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const cert = readCert(certPath)
    const validTo = cert ? new Date(cert.validTo) : null
    if (!cert || !validTo || validTo.getTime() - Date.now() > RENEW_BEFORE_MS) {
      console.log('🔒 Using existing certificates in ' + certDir)
      return { keyPath, certPath }
    }
    const when = `${validTo.getTime() < Date.now() ? 'expired' : 'expires'} on ${validTo.toISOString().slice(0, 10)}`
    if (!isOurs(cert)) {
      // someone else's certificate: never overwrite it
      console.warn(`⚠️  The certificate in ${certPath} ${when}. It was not created by this server, so it is not renewed: replace it.`)
      return { keyPath, certPath }
    }
    console.log(`🔁 Renewing the self-signed certificate (it ${when})...`)
  } else {
    console.log('🔐 Generating self-signed SSL certificate...')
  }

  try {
    // Try to use OpenSSL if available
    createWithOpenSSL(keyPath, certPath)
  } catch (error) {
    console.log('❌ Cannot generate SSL certificates without OpenSSL')
    console.log('')
    console.log('🔧 Solutions:')
    console.log('   1. Install OpenSSL:')
    console.log('      • Linux: sudo apt-get install openssl')
    console.log('      • macOS: brew install openssl')
    console.log('      • Windows: Download from https://slproweb.com/products/Win32OpenSSL.html')
    console.log('')
    console.log('   2. Provide your own certificates in certs/ directory:')
    console.log('      • server-key.pem (private key)')
    console.log('      • server-cert.pem (certificate)')
    console.log('')
    console.log('   3. Run without --ssl flag to use HTTP instead:')
    console.log('      • Example: ./edrys-server --port 3210')
    console.log('')

    throw new Error('SSL certificate generation requires OpenSSL. Please install OpenSSL or provide existing certificates.')
  }

  console.log('✅ Self-signed certificate generated successfully')
  console.log(`   Key: ${keyPath}`)
  console.log(`   Cert: ${certPath}`)

  return { keyPath, certPath }
}

/**
 * @param {string} certPath
 * @return {crypto.X509Certificate|null}
 */
function readCert (certPath) {
  try {
    return new crypto.X509Certificate(fs.readFileSync(certPath))
  } catch {
    return null
  }
}

/**
 * Whether this server created the certificate (self-signed, our subject).
 * @param {crypto.X509Certificate} cert
 */
function isOurs (cert) {
  const fields = SUBJECT.split('/').filter(Boolean)
  return cert.subject === cert.issuer && fields.every(f => cert.subject.split('\n').includes(f))
}

/**
 * Create a self-signed certificate with OpenSSL (no shell involved).
 * @param {string} keyPath
 * @param {string} certPath
 */
function createWithOpenSSL (keyPath, certPath) {
  execFileSync('openssl', [
    'req', '-nodes', '-new', '-x509',
    '-keyout', keyPath, '-out', certPath,
    '-days', String(DAYS),
    '-subj', SUBJECT,
    // SANs so browsers accept it for localhost once the warning is clicked away
    '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1'
  ], { stdio: 'pipe' })
}

/**
 * Load SSL certificates from files
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {Object} - Object containing key and cert content
 */
export function loadSSLCertificates (keyPath, certPath) {
  try {
    const key = fs.readFileSync(keyPath, 'utf8')
    const cert = fs.readFileSync(certPath, 'utf8')
    return { key, cert }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`Failed to load SSL certificates: ${errorMessage}`)
  }
}

/**
 * Check if SSL certificates exist and are valid
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {boolean} - True if certificates exist and are readable
 */
export function validateSSLCertificates (keyPath, certPath) {
  try {
    fs.accessSync(keyPath, fs.constants.R_OK)
    fs.accessSync(certPath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
