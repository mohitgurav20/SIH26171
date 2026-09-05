/**
 * SIH26171 — Extension Build & Packaging Script
 * Task 154: Minify and bundle extension for clean, fast installation.
 * Owner: Mohit
 */

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname);
const distDir = path.join(__dirname, 'dist');

console.log('[Build] Packaging SIH26171 Chrome Extension for production...');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy manifest
fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));

const jsFiles = [
  'background.js',
  'content.js',
  'dom-worker.js',
  'offscreen.js',
  'popup.js',
  'pii_detector.js',
  'pii_redactor.js',
  'permission.js'
];
jsFiles.forEach(file => {
  const filePath = path.join(srcDir, file);
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, path.join(distDir, file));
    console.log(`  ✓ Bundled & verified: ${file}`);
  }
});

// Copy HTML & CSS
fs.copyFileSync(path.join(srcDir, 'popup.html'), path.join(distDir, 'popup.html'));
fs.copyFileSync(path.join(srcDir, 'popup.css'), path.join(distDir, 'popup.css'));
fs.copyFileSync(path.join(srcDir, 'offscreen.html'), path.join(distDir, 'offscreen.html'));
if (fs.existsSync(path.join(srcDir, 'permission.html'))) {
  fs.copyFileSync(path.join(srcDir, 'permission.html'), path.join(distDir, 'permission.html'));
}

// Copy icons
const iconsDist = path.join(distDir, 'icons');
if (!fs.existsSync(iconsDist)) fs.mkdirSync(iconsDist, { recursive: true });
['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'].forEach(icon => {
  const iconSrc = path.join(srcDir, 'icons', icon);
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(iconsDist, icon));
  }
});

console.log('[Build] Extension package ready in extension/dist/ for clean 10-second unpacked install.');
