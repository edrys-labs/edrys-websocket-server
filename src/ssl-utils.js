// SSL/TLS utility functions for HTTPS/WSS support
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

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

  // Check if certificates already exist
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('🔒 Using existing self-signed certificates')
    return { keyPath, certPath }
  }

  console.log('🔐 Generating self-signed SSL certificate...')

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
 * Create certificates using OpenSSL
 */
function createWithOpenSSL (keyPath, certPath) {
  // Create a more comprehensive certificate with SAN fields for better browser compatibility
  const opensslCmd = `openssl req -nodes -new -x509 -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/C=US/ST=Local/L=Local/O=Edrys/OU=WebSocket/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:0.0.0.0"`
  execSync(opensslCmd, { stdio: 'pipe' })
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
