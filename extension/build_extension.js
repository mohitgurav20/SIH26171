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

// Simple whitespace & comment minifier
function minifyJS(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1') // remove comments
    .replace(/\n\s*\n/g, '\n') // collapse blank lines
    .trim();
}

const jsFiles = ['background.js', 'content.js', 'dom-worker.js', 'offscreen.js', 'popup.js'];
jsFiles.forEach(file => {
  const filePath = path.join(srcDir, file);
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const minified = minifyJS(raw);
    fs.writeFileSync(path.join(distDir, file), minified, 'utf8');
    console.log(`  ✓ Bundled & optimized: ${file}`);
  }
});

// Copy HTML & CSS
fs.copyFileSync(path.join(srcDir, 'popup.html'), path.join(distDir, 'popup.html'));
fs.copyFileSync(path.join(srcDir, 'popup.css'), path.join(distDir, 'popup.css'));
fs.copyFileSync(path.join(srcDir, 'offscreen.html'), path.join(distDir, 'offscreen.html'));

// Copy icons
const iconsDist = path.join(distDir, 'icons');
if (!fs.existsSync(iconsDist)) fs.mkdirSync(iconsDist, { recursive: true });
['icon16.png', 'icon48.png', 'icon128.png'].forEach(icon => {
  const iconSrc = path.join(srcDir, 'icons', icon);
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(iconsDist, icon));
  }
});

console.log('[Build] Extension package ready in extension/dist/ for clean 10-second unpacked install.');
