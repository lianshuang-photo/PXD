#!/bin/bash
set -e

echo "Building UXP Plugin..."

# Run vite build
npm run build

# Copy public assets
if [ -d "public" ]; then
  echo "Copying public assets..."
  cp -r public/* dist/
fi

# Copy manifest
echo "Copying manifest.json..."
cp manifest.json dist/

echo "✓ Build complete! Plugin is ready in ./dist/"
echo "Load the 'dist' folder in Photoshop to test the plugin."
