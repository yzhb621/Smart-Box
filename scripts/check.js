const fs = require('fs');
const path = require('path');
const vm = require('vm');
let checked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }); checked++; }
    else if (file.endsWith('.html')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) { new vm.Script(match[1], { filename: file }); checked++; }
      }
    }
  }
}
['api', 'server/src', 'public', 'sim/public'].forEach(walk);
console.log(`Syntax checked ${checked} JavaScript files and inline scripts.`);
