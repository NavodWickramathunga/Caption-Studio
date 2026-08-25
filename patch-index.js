const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

code = code.replace(
  '<h2><i>4</i>Check the timings</h2>',
  '<h2><i>4</i>Check the timings</h2> <button id="btnAiSync" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; margin-left:10px; border-radius:6px; cursor:pointer;" title="Uses Gemini to automatically sync words to the loaded video">✨ Auto-Sync</button>'
);

fs.writeFileSync('index.html', code);
console.log("Patched index.html");
