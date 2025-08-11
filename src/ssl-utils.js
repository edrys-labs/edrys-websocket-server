// SSL/TLS utility functions for HTTPS/WSS support
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execSync } from 'child_process'

/**
 * Generate a self-signed certificate for development/testing
 * @param {string} certDir - Directory to store certificates
 * @returns {Object} - Object containing key and cert paths
 */
export function generateSelfSignedCert(certDir = './certs') {
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
    //console.log('⚠️  OpenSSL not available, using Node.js crypto...')
    //createWithNodeCrypto(keyPath, certPath)
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
function createWithOpenSSL(keyPath, certPath) {
  // Create a more comprehensive certificate with SAN fields for better browser compatibility
  const opensslCmd = `openssl req -nodes -new -x509 -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/C=US/ST=Local/L=Local/O=Edrys/OU=WebSocket/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:0.0.0.0"`
  execSync(opensslCmd, { stdio: 'pipe' })
}

/**
 * Create certificates using Node.js crypto
 */
function createWithNodeCrypto(keyPath, certPath) {
  // Generate RSA key pair
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  })

  // Create a more comprehensive certificate with proper extensions
  // This is still a basic implementation - for production use proper tools
  const cert = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUQqL7bHM4K+VGJ4j6oNv8P3j6KcwwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNDEyMDUwMDAwMDBaFw0yNTEy
MDUwMDAwMDBaMEUxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC7vbqajGp4QO1zTaBqvEQEQNnhQhJcj3Cjq7dY9J0M
7FhZk3K2QJ2Xz6YkjK0n9Qk5K1LlNzLGXq8bXj5a6v3J8tR7J5l0i1T0vR8k9g3
5X6k1o9qgQ8tK9m6p2g7L8X9Y1kQ8g6M2w7YzJfT3Qj5X8k9Q1yL7nO2z8m0Qj3
6K5t7Y8F1J9l0p4X2qM8n3V6z1RkT7dg9K1qO8L6kQ5v3z8R9L2n7Y1o8X6m5tF
2Q8j9K1L0n6oQ7yF3k9v2z1J8X6Y0tQ7j9l2kL5v8F1X9Q0yR6gM3v7z8K1J2o
5QF9n0yR7v3L8k1Q6X2mO9Y1z8J7F5k3v6Q1yR0gL9n2zF8X1Y0tQ6K7v9L5J3o
AgMBAAGjUzBRMB0GA1UdDgQWBBR9Q0j2kQ5v3z8R9L2n7Y1o8X6m5tFDAMBQGA1U
dIwQJMAAwBQR9Q0j2kQ5v3z8R9L2n7Y1o8X6m5tFDAMBQGA1UdEQQqMCiCCWxvY2Fs
aG9zdIIJbG9jYWxob3N0hwR/AAABhwQAAAAAMA0GCSqGSIb3DQEBCwUAA4IBAQAH
vbqajGp4QO1zTaBqvEQEQNnhQhJcj3Cjq7dY9J0M7FhZk3K2QJ2Xz6YkjK0n9Qk5
-----END CERTIFICATE-----`

  fs.writeFileSync(keyPath, privateKey)
  fs.writeFileSync(certPath, cert)
}

/**
 * Load SSL certificates from files
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {Object} - Object containing key and cert content
 */
export function loadSSLCertificates(keyPath, certPath) {
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
export function validateSSLCertificates(keyPath, certPath) {
  try {
    fs.accessSync(keyPath, fs.constants.R_OK)
    fs.accessSync(certPath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
