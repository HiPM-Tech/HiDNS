#!/usr/bin/env node

/**
 * Copy provider icon files from src to dist directory
 * This script ensures that static assets (icons) are available in the build output
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src', 'lib', 'dns', 'providers');
const DIST_DIR = path.join(__dirname, '..', 'dist', 'lib', 'dns', 'providers');

// Icon file extensions to copy
const ICON_EXTENSIONS = ['.svg', '.png', '.ico', '.jpg', '.jpeg'];

function copyIcons() {
  console.log('📦 Copying provider icons from src to dist...');
  
  // Check if src directory exists
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`❌ Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }
  
  // Create dist directory if it doesn't exist
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    console.log(`✓ Created dist directory: ${DIST_DIR}`);
  }
  
  // Read all provider directories
  const providers = fs.readdirSync(SRC_DIR).filter(name => {
    const fullPath = path.join(SRC_DIR, name);
    return fs.statSync(fullPath).isDirectory() && name !== 'legacy' && !name.startsWith('_');
  });
  
  let copiedCount = 0;
  
  // Copy icons for each provider
  for (const provider of providers) {
    const srcProviderDir = path.join(SRC_DIR, provider);
    const distProviderDir = path.join(DIST_DIR, provider);
    
    // Create provider directory in dist
    if (!fs.existsSync(distProviderDir)) {
      fs.mkdirSync(distProviderDir, { recursive: true });
    }
    
    // Find and copy icon files
    for (const ext of ICON_EXTENSIONS) {
      const iconName = `icon${ext}`;
      const srcIconPath = path.join(srcProviderDir, iconName);
      
      if (fs.existsSync(srcIconPath)) {
        const distIconPath = path.join(distProviderDir, iconName);
        fs.copyFileSync(srcIconPath, distIconPath);
        console.log(`  ✓ ${provider}/${iconName}`);
        copiedCount++;
      }
    }
  }
  
  console.log(`\n✅ Successfully copied ${copiedCount} icon file(s) to dist directory`);
}

/**
 * 数据快照（public suffix）随 dist 一起复制。
 * 与图标同理：运行时按文件路径读取，无法被 esbuild 内联。
 */
function copyAssets() {
  const assetsSrc = path.join(__dirname, '..', 'src', 'data');
  const assetsDist = path.join(__dirname, '..', 'dist', 'data');
  if (!fs.existsSync(assetsSrc)) {
    console.warn(`⚠ src/data not found, skipping: ${assetsSrc}`);
    return;
  }
  fs.mkdirSync(assetsDist, { recursive: true });
  for (const entry of fs.readdirSync(assetsSrc, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(assetsSrc, entry.name), path.join(assetsDist, entry.name));
  }
  console.log('📦 Copied src/data to dist/data');
}

// Run the copy function
try {
  copyIcons();
  copyAssets();
} catch (error) {
  console.error('❌ Failed to copy static assets:', error.message);
  process.exit(1);
}
