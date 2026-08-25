const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

const newUI = `
      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button id="btnRewrite" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; border-radius:6px;">✨ Rewrite (Punchy)</button>
        <button id="btnTranscribe" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; border-radius:6px;">🎙️ Auto-Transcribe from Video</button>
      </div>
`;

code = code.replace(
  '<textarea id="script" placeholder="Your thyroid sits at the base of your neck. It runs on iodine — and most people never think about it."></textarea>',
  '<textarea id="script" placeholder="Your thyroid sits at the base of your neck. It runs on iodine — and most people never think about it."></textarea>' + newUI
);

fs.writeFileSync('index.html', code);
console.log("Patched index.html for Step 3 AI buttons");
