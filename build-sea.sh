#!/bin/bash

echo "🌊 Edrys Server - Node.js SEA Builder (Webpack)"
echo "=============================================="

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "📥 Download from: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js v20+ required for SEA feature. Current: $(node --version)"
    echo "📥 Download latest from: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js $(node --version) detected"

# Check if we're in the edrys-websocket-server directory
if [ ! -f "package.json" ]; then
    echo "❌ package.json not found. Please run this in the edrys-websocket-server directory."
    exit 1
fi

# Check for --all argument to build for all platforms
if [ "$1" = "--all" ]; then
    echo "✅ Found cross-platform builder script"
    echo "🚀 Running cross-platform Node.js SEA build for all platforms..."
    echo ""
    
    # Run the cross-platform SEA builder
    node ./build-cross-platform.cjs
else
    echo "✅ Found SEA builder script"
    echo "🚀 Running Node.js SEA build for current platform..."
    echo "💡 Use --all to build for all platforms (Linux, Windows, macOS)"
    echo ""
    
    # Run the single-platform SEA builder
    node ./build-edrys-sea.cjs
fi

echo ""
echo "🌊 Build process completed!"