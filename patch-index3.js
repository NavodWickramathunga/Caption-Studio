const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

const newUI = `
      <div style="margin-bottom:10px; display:flex; gap:8px;">
        <input type="text" id="topicInput" placeholder="Topic: e.g. What happens if you eat garlic..." style="flex:1; padding:6px; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px;">
        <button id="btnGenerate" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;">✨ Magic Script</button>
      </div>
      <textarea id="script" placeholder="Your thyroid sits at the base of your neck. It runs on iodine — and most people never think about it."></textarea>
      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button id="btnRewrite" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;">✨ Rewrite (Punchy)</button>
        <button id="btnEmojify" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;">😊 Add Emojis</button>
        <button id="btnTranscribe" class="ghost" style="border:1px solid var(--vein); color:var(--vein); font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;">🎙️ Auto-Transcribe</button>
      </div>
`;

code = code.replace(
  /<textarea id="script".*<\/textarea>\s*<div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">\s*<button id="btnRewrite".*<\/button>\s*<button id="btnTranscribe".*<\/button>\s*<\/div>/s,
  newUI
);

fs.writeFileSync('index.html', code);
