const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const https = require('node:https');

console.log('🌊 Building Edrys Server for ALL PLATFORMS using Node.js SEA + Webpack');
console.log('====================================================================');

// Platform configurations
const PLATFORMS = {
    'linux-x64': {
        name: 'Linux (x64)',
        nodeUrl: 'https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-x64.tar.xz',
        executable: 'edrys-server-linux-x64',
        startupScript: 'start-server.sh',
        startupContent: `#!/bin/bash
clear
echo "🎓 Edrys WebSocket Server (Standalone) - Linux x64"
echo "=================================================="
if command -v hostname >/dev/null 2>&1; then
    IP=$(hostname -I | awk '{print $1}' 2>/dev/null)
fi
if [ -z "$IP" ] && command -v ip >/dev/null 2>&1; then
    IP=$(ip route get 1 2>/dev/null | sed -n 's/.*src \\([0-9.]*\\).*/\\1/p')
fi
if [ -z "$IP" ] && command -v ifconfig >/dev/null 2>&1; then
    IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
fi
[ -z "$IP" ] && IP="localhost"
echo "🌐 Server IP: $IP"
echo "📡 WebSocket: ws://$IP:3210/"
echo "🎥 Streaming: ws://$IP:3210/stream"
echo "⛔ Press Ctrl+C to stop"
echo "=================================================="
./edrys-server-linux-x64 --port 3210`
    },
    'win-x64': {
        name: 'Windows (x64)',
        nodeUrl: 'https://nodejs.org/dist/v20.11.0/node-v20.11.0-win-x64.zip',
        executable: 'edrys-server-win-x64.exe',
        startupScript: 'start-server.bat',
        startupContent: `@echo off
cls
title Edrys WebSocket Server - Windows x64
echo 🎓 Edrys WebSocket Server (Standalone) - Windows x64
echo ==================================================
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do set IP=%%a
set IP=%IP: =%
echo 🌐 Server IP: %IP%
echo 📡 WebSocket: ws://%IP%:3210/
echo 🎥 Streaming: ws://%IP%:3210/stream
echo ⛔ Press Ctrl+C to stop
echo ==================================================
edrys-server-win-x64.exe --port 3210
pause`
    },
    'darwin-x64': {
        name: 'macOS (x64)',
        nodeUrl: 'https://nodejs.org/dist/v20.11.0/node-v20.11.0-darwin-x64.tar.gz',
        executable: 'edrys-server-macos-x64',
        startupScript: 'start-server.sh',
        startupContent: `#!/bin/bash
clear
echo "🎓 Edrys WebSocket Server (Standalone) - macOS x64"
echo "=================================================="
if command -v hostname >/dev/null 2>&1; then
    IP=$(hostname -I | awk '{print $1}' 2>/dev/null)
fi
if [ -z "$IP" ] && command -v ifconfig >/dev/null 2>&1; then
    IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
fi
[ -z "$IP" ] && IP="localhost"
echo "🌐 Server IP: $IP"
echo "📡 WebSocket: ws://$IP:3210/"
echo "🎥 Streaming: ws://$IP:3210/stream"
echo "⛔ Press Ctrl+C to stop"
echo "=================================================="
./edrys-server-macos-x64 --port 3210`
    }
};

// Utility function to run commands
function runCommand(command, description) {
    console.log(`\n🔨 ${description}...`);
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.log(`❌ ${description} failed:`, error.message);
                if (stderr) console.log('Error details:', stderr);
                reject(error);
            } else {
                console.log(`✅ ${description} completed`);
                if (stdout) console.log(stdout);
                resolve(stdout);
            }
        });
    });
}

// Download file function
function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Downloading ${url}...`);
        const file = fs.createWriteStream(destination);
        
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirects
                downloadFile(response.headers.location, destination).then(resolve).catch(reject);
                return;
            }
            
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                console.log(`✅ Downloaded to ${destination}`);
                resolve();
            });
            
            file.on('error', reject);
        }).on('error', reject);
    });
}

// Find entry point
function findEntryPoint() {
    const candidates = ['dist/server.cjs', 'src/server.js', 'server.js'];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            console.log(`✅ Found entry point: ${candidate}`);
            return candidate;
        }
    }
    console.log('❌ No server entry point found!');
    process.exit(1);
}

// Create webpack configuration
function createWebpackConfig(entryPoint, outputFile) {
    const webpackConfig = `
const path = require('path');

module.exports = {
    entry: './${entryPoint}',
    mode: 'production',
    target: 'node',
    output: {
        filename: '${outputFile}',
        path: path.resolve(__dirname, 'sea-build'),
        clean: true
    },
    externals: {
        // Keep these as external if they cause issues
        // 'sqlite3': 'commonjs sqlite3',
        // 'sharp': 'commonjs sharp'
    },
    optimization: {
        minimize: false, // Keep readable for debugging
    },
    resolve: {
        extensions: ['.js', '.cjs', '.mjs', '.json']
    },
    module: {
        rules: [
            {
                test: /\\.node$/,
                use: 'node-loader'
            }
        ]
    },
    plugins: [
        // Remove source-map-support banner as it's not available in SEA
    ],
    node: {
        __dirname: false,
        __filename: false
    }
};
`;
    
    // Use .cjs extension to force CommonJS mode
    fs.writeFileSync('webpack.sea.config.cjs', webpackConfig);
    console.log('✅ Created webpack.sea.config.cjs');
}

// Extract Node.js binary from archive
async function extractNodeBinary(platform, archivePath) {
    const tempDir = `temp-${platform}`;
    
    if (platform === 'win-x64') {
        // Windows ZIP file
        await runCommand(`unzip -q "${archivePath}" -d "${tempDir}"`, `Extracting ${platform} archive`);
        const extractedDir = fs.readdirSync(tempDir)[0];
        const nodePath = path.join(tempDir, extractedDir, 'node.exe');
        return nodePath;
    } else {
        // Linux/macOS TAR files
        const isXz = archivePath.endsWith('.tar.xz');
        const extractCmd = isXz 
            ? `tar -xf "${archivePath}" -C "${tempDir}"`
            : `tar -xzf "${archivePath}" -C "${tempDir}"`;
        
        await runCommand(extractCmd, `Extracting ${platform} archive`);
        const extractedDir = fs.readdirSync(tempDir)[0];
        const nodePath = path.join(tempDir, extractedDir, 'bin', 'node');
        return nodePath;
    }
}

// Build executable for a specific platform
async function buildExecutableForPlatform(bundledScript, platform, platformConfig) {
    console.log(`\n🏗️  Building SEA executable for ${platformConfig.name}...`);
    
    const tempDir = `temp-${platform}`;
    const archiveName = `node-${platform}.${platform === 'win-x64' ? 'zip' : (platform === 'linux-x64' ? 'tar.xz' : 'tar.gz')}`;
    
    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Download Node.js binary for this platform
        await downloadFile(platformConfig.nodeUrl, archiveName);
        
        // Extract Node.js binary
        const nodeBinaryPath = await extractNodeBinary(platform, archiveName);
        
        // Create platform-specific SEA config
        const configName = `sea-config-${platform}.json`;
        const blobName = `edrys-server-${platform}.blob`;
        
        const seaConfig = {
            main: `sea-build/${bundledScript}`,
            output: blobName,
            disableExperimentalSEAWarning: true
        };
        
        fs.writeFileSync(configName, JSON.stringify(seaConfig, null, 2));
        console.log(`  📄 Created ${configName}`);
        
        // Generate blob using current Node.js (should work cross-platform)
        await runCommand(`node --experimental-sea-config ${configName}`, `Generating SEA blob for ${platform}`);
        console.log(`  📦 Generated ${blobName}`);
        
        // Copy the platform-specific Node.js executable
        fs.copyFileSync(nodeBinaryPath, platformConfig.executable);
        console.log(`  📋 Copied ${platform} Node.js executable to ${platformConfig.executable}`);
        
        // Install postject if needed
        try {
            await runCommand('npx postject --help', 'Checking postject');
        } catch (error) {
            console.log('  📦 Installing postject...');
            try {
                await runCommand('npm install -g postject', 'Installing postject globally');
            } catch (globalError) {
                console.log('  ⚠️  Global install failed, trying locally...');
                await runCommand('npm install postject', 'Installing postject locally');
            }
        }
        
        // Inject blob using postject
        const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
        const injectCmd = `npx postject ${platformConfig.executable} NODE_SEA_BLOB ${blobName} --sentinel-fuse ${sentinel}`;
        
        await runCommand(injectCmd, `Injecting SEA blob for ${platform}`);
        
        // Make executable on Unix systems
        if (platform !== 'win-x64') {
            fs.chmodSync(platformConfig.executable, '755');
        }
        
        const stats = fs.statSync(platformConfig.executable);
        const sizeMB = Math.round(stats.size / 1024 / 1024);
        console.log(`  ✅ Created ${platformConfig.executable} (${sizeMB}MB)`);
        
        // Cleanup temporary files for this platform
        [configName, blobName, archiveName].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });
        
        // Cleanup temp directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        
        return platformConfig.executable;
        
    } catch (error) {
        // Cleanup on error
        [configName, blobName, archiveName].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });
        
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        
        throw error;
    }
}

// Create distribution packages for all platforms
function createDistributions(executables) {
    console.log('\n📁 Creating distribution packages for all platforms...');
    
    const distributions = [];
    
    Object.entries(PLATFORMS).forEach(([platform, config]) => {
        const executable = executables[platform];
        if (!executable || !fs.existsSync(executable)) {
            console.log(`⚠️  Skipping ${platform} - executable not found`);
            return;
        }
        
        const outputDir = `edrys-executable-${platform}`;
        
        // Create output directory
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
        fs.mkdirSync(outputDir, { recursive: true });
        
        // Move executable
        fs.renameSync(executable, path.join(outputDir, executable));
        
        // Create startup script
        fs.writeFileSync(path.join(outputDir, config.startupScript), config.startupContent);
        if (config.startupScript.endsWith('.sh')) {
            fs.chmodSync(path.join(outputDir, config.startupScript), '755');
        }
        
        // Copy certificates if they exist
        if (fs.existsSync('certs')) {
            const certsDest = path.join(outputDir, 'certs');
            fs.mkdirSync(certsDest, { recursive: true });
            fs.readdirSync('certs').forEach(cert => {
                fs.copyFileSync(path.join('certs', cert), path.join(certsDest, cert));
            });
        }
        
        // Create platform-specific README
        const readme = `🌊 EDRYS WEBSOCKET SERVER - ${config.name.toUpperCase()} STANDALONE EXECUTABLE
===============================================

✨ BUILT WITH NODE.JS SINGLE EXECUTABLE APPLICATIONS (SEA) + WEBPACK
✅ NO NODE.JS INSTALLATION REQUIRED
🚀 COMPLETELY STANDALONE & PORTABLE

QUICK START:
-----------
${platform === 'win-x64' ? 
'Double-click: start-server.bat' : 
'Run: ./start-server.sh (make sure it\'s executable: chmod +x start-server.sh)'}

Or run directly:
${platform === 'win-x64' ? `${executable} --port 3210` : `./${executable} --port 3210`}

SERVER DETAILS:
-----------------
• WebSocket Server: ws://YOUR-IP:3210/
• Video Streaming: ws://YOUR-IP:3210/stream

FEATURES:
--------
✅ No Node.js needed
✅ No internet required (after setup)
✅ Works on local WiFi network
✅ Completely offline-capable
💾 Session persistence (documents persist during server runtime)
🔄 Multiple document rooms supported
👥 Real-time collaborative editing
🎥 Video streaming capabilities

CLASSROOM SETUP:
---------------
1. Run the startup script
2. Modify the classroom communication settings
3. Share the new classroom URL with students
4. If using HTTPS, share the server URL with students (https://YOUR-IP:3210/)
5. At first run, the server URL should be opened in the browser to accept the self-signed certificate

TROUBLESHOOTING:
---------------
• Ensure all devices on same WiFi network
• Allow firewall access if prompted
${platform === 'win-x64' ? 
'• Allow .exe through Windows Defender if prompted' :
`• If permission denied: chmod +x ${executable}`}
${platform === 'darwin-x64' ? 
'• On macOS: Right-click executable > Open (first time only)' : ''}

PLATFORM: ${config.name}
Built with Node.js v20.11.0 SEA + Webpack technology
Support: https://github.com/edrys-labs/edrys-websocket-server`;
        
        fs.writeFileSync(path.join(outputDir, 'README.txt'), readme);
        
        distributions.push(outputDir);
        console.log(`  ✅ Created ${outputDir}/`);
    });
    
    return distributions;
}

// Main build process
async function buildAll() {
    try {
        // Step 1: Install dependencies if needed
        if (fs.existsSync('package.json') && !fs.existsSync('node_modules')) {
            await runCommand('npm install --production', 'Installing dependencies');
        }
        
        // Step 2: Build project if needed
        if (fs.existsSync('package.json')) {
            try {
                await runCommand('npm run build', 'Building project');
            } catch (error) {
                console.log('⚠️  No build script found or build failed, continuing...');
            }
        }
        
        // Step 3: Find entry point
        const entryPoint = findEntryPoint();
        const bundledScript = 'edrys-server-bundled.cjs';
        
        // Step 4: Install webpack if needed
        console.log('\n📦 Ensuring webpack is available...');
        
        let webpackAvailable = false;
        
        if (fs.existsSync('package.json')) {
            const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            if (deps.webpack) {
                console.log('  ✅ Webpack found in package.json dependencies');
                webpackAvailable = true;
            }
        }
        
        if (!webpackAvailable && fs.existsSync('node_modules/.bin/webpack')) {
            console.log('  ✅ Webpack found in node_modules');
            webpackAvailable = true;
        }
        
        if (!webpackAvailable) {
            console.log('  ⚠️  Webpack not found, installing...');
            await runCommand('npm install --save-dev webpack webpack-cli node-loader', 'Installing webpack and dependencies');
            console.log('  ✅ Webpack installation completed');
        } else {
            console.log('  ✅ Webpack is already available');
        }
        
        // Step 5: Create webpack config and bundle
        createWebpackConfig(entryPoint, bundledScript);
        
        // Create sea-build directory
        if (!fs.existsSync('sea-build')) {
            fs.mkdirSync('sea-build');
        }
        
        await runCommand('npx webpack --config webpack.sea.config.cjs', 'Bundling with webpack');
        
        // Step 6: Build SEA executables for all platforms
        console.log('\n🌍 Building executables for all platforms...');
        const executables = {};
        
        for (const [platform, config] of Object.entries(PLATFORMS)) {
            try {
                const executable = await buildExecutableForPlatform(bundledScript, platform, config);
                executables[platform] = executable;
                console.log(`✅ ${config.name} executable completed`);
            } catch (error) {
                console.log(`❌ Failed to build ${config.name}:`, error.message);
                // Continue with other platforms
            }
        }
        
        // Step 7: Create distribution packages
        const distributions = createDistributions(executables);
        
        console.log(`\n🎉 SUCCESS! Cross-platform executables created!`);
        console.log('📦 Ready for distribution on all platforms!');
        
        // Show final results
        console.log('\n📋 Created distributions:');
        distributions.forEach(dist => {
            const files = fs.readdirSync(dist);
            console.log(`\n📁 ${dist}/`);
            files.forEach(file => {
                const filePath = path.join(dist, file);
                const stats = fs.statSync(filePath);
                if (stats.isFile()) {
                    const size = stats.size > 1024 * 1024 ? 
                        `${Math.round(stats.size / 1024 / 1024)}MB` : 
                        `${Math.round(stats.size / 1024)}KB`;
                    console.log(`  📄 ${file} (${size})`);
                } else {
                    console.log(`  📁 ${file}/`);
                }
            });
        });
        
        console.log('\n🚀 To distribute:');
        console.log('   1. Zip each platform folder separately');
        console.log('   2. Send appropriate platform package to users');
        console.log('   3. Recipients extract and run the startup script');
        console.log('   4. No Node.js installation required on target machines!');
        
        // Cleanup
        console.log('\n🧹 Cleaning up build files...');
        ['webpack.sea.config.cjs', 'sea-build'].forEach(item => {
            if (fs.existsSync(item)) {
                if (fs.statSync(item).isDirectory()) {
                    fs.rmSync(item, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(item);
                }
            }
        });
        
    } catch (err) {
        console.log('❌ Build failed:', err.message);
        process.exit(1);
    }
}

// Run the build
buildAll();
