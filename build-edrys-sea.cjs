const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

console.log('🌊 Building Edrys Server using Node.js SEA + Webpack');
console.log('====================================================');

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

// Build executable for current platform
async function buildExecutable(bundledScript) {
    const isWindows = process.platform === 'win32';
    const executableName = `edrys-server${isWindows ? '.exe' : ''}`;
    const configName = 'sea-config.json';
    const blobName = 'edrys-server.blob';
    
    console.log(`\n🏗️  Building SEA executable...`);
    
    // Step 1: Create SEA config
    const seaConfig = {
        main: `sea-build/${bundledScript}`,
        output: blobName,
        disableExperimentalSEAWarning: true
    };
    
    fs.writeFileSync(configName, JSON.stringify(seaConfig, null, 2));
    console.log(`  📄 Created ${configName}`);
    
    // Step 2: Generate blob
    try {
        await runCommand(`node --experimental-sea-config ${configName}`, 'Generating SEA blob');
        console.log(`  📦 Generated ${blobName}`);
        
        // Step 3: Copy Node.js executable
        const nodeExecutable = process.execPath;
        fs.copyFileSync(nodeExecutable, executableName);
        console.log(`  📋 Copied Node.js executable to ${executableName}`);
        
        // Step 4: Install postject if needed
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
        
        // Step 5: Inject blob using postject
        const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
        const injectCmd = `npx postject ${executableName} NODE_SEA_BLOB ${blobName} --sentinel-fuse ${sentinel}`;
        
        await runCommand(injectCmd, 'Injecting SEA blob');
        
        // Cleanup temporary files
        [configName, blobName].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });
        
        // Make executable on Unix systems
        if (!isWindows) {
            fs.chmodSync(executableName, '755');
        }
        
        const stats = fs.statSync(executableName);
        const sizeMB = Math.round(stats.size / 1024 / 1024);
        console.log(`  ✅ Created ${executableName} (${sizeMB}MB)`);
        
        return executableName;
        
    } catch (error) {
        // Cleanup on error
        [configName, blobName].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });
        throw error;
    }
}

// Create startup script and README
function createDistribution(executable) {
    console.log('\n📁 Creating distribution package...');
    
    const outputDir = 'edrys-executable';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Move executable
    if (fs.existsSync(executable)) {
        fs.renameSync(executable, path.join(outputDir, executable));
    }
    
    const isWindows = process.platform === 'win32';
    
    if (isWindows) {
        // Windows startup script
        const windowsScript = `@echo off
cls
title Edrys WebSocket Server
echo 🎓 Edrys WebSocket Server (Standalone)
echo ======================================
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do set IP=%%a
set IP=%IP: =%
echo 🌐 Server IP: %IP%
echo 📡 WebSocket: ws://%IP%:3210/
echo 🎥 Streaming: ws://%IP%:3210/stream
echo ⛔ Press Ctrl+C to stop
echo ======================================
${executable} --port 3210
pause`;
        
        fs.writeFileSync(path.join(outputDir, 'start-server.bat'), windowsScript);
    } else {
        // Unix startup script
        const unixScript = `#!/bin/bash
clear
echo "🎓 Edrys WebSocket Server (Standalone)"
echo "===================================="
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
echo "===================================="
./${executable} --port 3210`;
        
        fs.writeFileSync(path.join(outputDir, 'start-server.sh'), unixScript);
        fs.chmodSync(path.join(outputDir, 'start-server.sh'), '755');
    }
    
    // README
    const readme = `🌊 EDRYS WEBSOCKET SERVER - STANDALONE EXECUTABLE
===============================================

✨ BUILT WITH NODE.JS SINGLE EXECUTABLE APPLICATIONS (SEA) + WEBPACK
✅ NO NODE.JS INSTALLATION REQUIRED
🚀 COMPLETELY STANDALONE & PORTABLE

QUICK START:
-----------
${isWindows ? 
'Double-click: start-server.bat' : 
'Run: ./start-server.sh'}

Or run directly:
${isWindows ? `${executable} --port 3210` : `./${executable} --port 3210`}

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
${isWindows ? 
'• Allow .exe through Windows Defender if prompted' :
'• If permission denied: chmod +x ' + executable}

Built with Node.js ${process.version} SEA + Webpack technology
Support: https://github.com/edrys-labs/edrys-websocket-server`;
    
    fs.writeFileSync(path.join(outputDir, 'README.txt'), readme);
    
    return outputDir;
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
        
        // Check if webpack is already installed by looking for it in node_modules or package.json
        let webpackAvailable = false;
        
        // First check if webpack is in devDependencies or dependencies
        if (fs.existsSync('package.json')) {
            const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            if (deps.webpack) {
                console.log('  ✅ Webpack found in package.json dependencies');
                webpackAvailable = true;
            }
        }
        
        // Also check if webpack exists in node_modules
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
        
        // Step 6: Build SEA executable
        const executable = await buildExecutable(bundledScript);
        
        // Step 7: Create distribution package
        const outputDir = createDistribution(executable);
        
        console.log(`\n🎉 SUCCESS! Standalone executable created!`);
        console.log(`📁 Output directory: ${outputDir}/`);
        console.log('📦 Ready for distribution!');
        
        // Show final directory contents
        const files = fs.readdirSync(outputDir);
        console.log('\n📋 Final contents:');
        files.forEach(file => {
            const filePath = path.join(outputDir, file);
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
        
        console.log('\n🚀 To distribute:');
        console.log(`   1. Zip the entire '${outputDir}' folder`);
        console.log('   2. Recipients just extract and run the startup script');
        console.log('   3. No Node.js installation required on target machines!');
        
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