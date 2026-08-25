const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

// The regex I used earlier ate Step 5 and 6! Let's append them back if they are missing.
if (!code.includes('Set the look')) {
  const missingSteps = `
    <section class="step">
      <h2><i>5</i>Set the look</h2>
      <div class="grid2">
        <div class="field">
          <label for="wps">Words on screen <b id="wpsVal">3</b></label>
          <input type="range" id="wps" min="1" max="5" step="1" value="3">
        </div>
        <div class="field">
          <label for="size">Text size <b id="sizeVal">8.5%</b></label>
          <input type="range" id="size" min="4" max="16" step="0.25" value="8.5">
        </div>
        <div class="field">
          <label for="pos">Height on frame <b id="posVal">72%</b></label>
          <input type="range" id="pos" min="10" max="92" step="1" value="72">
        </div>
        <div class="field">
          <label id="swLabel">Spoken word colour</label>
          <div class="swatches" id="swatches" role="group" aria-labelledby="swLabel"></div>
        </div>
      </div>
    </section>
    <section class="step">
      <h2><i>6</i>Export</h2>
      <div class="export-grid">
        <button id="expAss" class="primary big">Download .ass (FCP / ffmpeg)</button>
        <button id="expBurn" class="ghost big">Record video in browser</button>
        <button id="expSrt" class="ghost big">Download .srt</button>
        <button id="expJson" class="ghost big">Download .json</button>
      </div>
    </section>
  </div>
</main>
`;
  code = code.replace('</section>\n  </div>\n</main>', '</section>' + missingSteps);
}

// Add the requested UI to Step 4.
const step4UI = `
  <div class="tapbar-styles" style="margin-top:15px; padding-top:15px; border-top:1px solid var(--vein); display:flex; gap:20px; align-items:center;">
    <div style="display:flex; align-items:center; gap:8px;">
      <label style="font-size:12px; color:var(--ivory-dim);">Caption Animation:</label>
      <select id="captionAnimStyle" style="background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px; padding:4px; font-size:12px;">
        <option value="none">Standard</option>
        <option value="pop">Pop (Scale up)</option>
        <option value="bounce">Bounce</option>
        <option value="fade">Fade In</option>
      </select>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <label style="font-size:12px; color:var(--ivory-dim);">Highlight Color:</label>
      <input type="color" id="customHlColor" value="#FACC15" style="background:transparent; border:none; width:24px; height:24px; padding:0; cursor:pointer;">
    </div>
  </div>
`;

code = code.replace(
  '<div class="progress-line"><b id="tapProgress"></b></div>',
  step4UI + '\n  <div class="progress-line"><b id="tapProgress"></b></div>'
);

fs.writeFileSync('index.html', code);
console.log("Patched index.html for Step 4 UI and restored missing steps");
