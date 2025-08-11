/**
 * Generate a self-signed certificate for development/testing
 * @param {string} certDir - Directory to store certificates
 * @returns {Object} - Object containing key and cert paths
 */
export function generateSelfSignedCert(certDir?: string): any;
/**
 * Load SSL certificates from files
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {Object} - Object containing key and cert content
 */
export function loadSSLCertificates(keyPath: string, certPath: string): any;
/**
 * Check if SSL certificates exist and are valid
 * @param {string} keyPath - Path to private key file
 * @param {string} certPath - Path to certificate file
 * @returns {boolean} - True if certificates exist and are readable
 */
export function validateSSLCertificates(keyPath: string, certPath: string): boolean;
