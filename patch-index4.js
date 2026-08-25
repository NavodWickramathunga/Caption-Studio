const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

// Add the tab button
code = code.replace(
  '<button role="tab" id="modeFile" aria-selected="false">Load a file</button>',
  '<button role="tab" id="modeFile" aria-selected="false">Load a file</button>\n        <button role="tab" id="modePremium" aria-selected="false">Premium AI (ElevenLabs)</button>'
);

// Add the new panel
const premiumPanel = `
      <!-- premium elevenlabs -->
      <div id="premiumPanel" style="display:none">
        <p class="hint">Use ultra-realistic, deep neural voices (like the one in the video!). Requires a free ElevenLabs API key.</p>
        
        <div class="field" style="margin-bottom:10px;">
          <label for="elevenKey" style="display:flex; justify-content:space-between;">
            API Key <a href="https://elevenlabs.io" target="_blank" style="color:var(--vein); font-size:11px;">Get one free &rarr;</a>
          </label>
          <input type="password" id="elevenKey" placeholder="sk_..." style="width:100%; padding:6px; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px;">
        </div>
        
        <div class="field">
          <label for="elevenVoice">Select Voice</label>
          <select id="elevenVoice" style="width:100%; padding:6px; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px;">
            <option value="pNInz6obpgDQGcFmaJgB">Adam (Deep, engaging - EXACTLY like the video!)</option>
            <option value="ErXwobaYiN019PkySvjV">Antoni (Well-rounded narrator)</option>
            <option value="21m00Tcm4TlvDq8ikWAM">Rachel (Calm, professional)</option>
            <option value="AZnzlk1XvdvUeBnXmlld">Domi (Strong, narrative)</option>
            <option value="tx3xeHWmK08X04l8pQNT">Josh (Deep, narrative)</option>
          </select>
        </div>
        
        <div class="vo-actions" style="margin-top:15px;">
          <button id="btnGeneratePremium" class="primary">Generate AI Audio</button>
        </div>
        <div class="status" id="premiumStatus" role="status" aria-live="polite"></div>
      </div>
`;

code = code.replace(
  '      </div>\n    </section>\n    <section class="step">\n      <h2><i>3</i>Paste your script</h2>',
  '      </div>\n' + premiumPanel + '    </section>\n    <section class="step">\n      <h2><i>3</i>Paste your script</h2>'
);

fs.writeFileSync('index.html', code);
console.log("Patched index.html with ElevenLabs UI");
