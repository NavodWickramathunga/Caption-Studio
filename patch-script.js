const fs = require('fs');
let content = fs.readFileSync('script.js', 'utf8');

// We will add an inline timing editor.
const editorHTML = `
  const p = document.createElement("div");
  p.className = "time-editor";
  p.style.display = "none";
  document.body.appendChild(p);

  let editingIdx = -1;
  function openTimeEditor(idx, buttonEl) {
    editingIdx = idx;
    const w = S.words[idx];
    const rect = buttonEl.getBoundingClientRect();
    
    p.innerHTML = \`
      <div style="font-size:11px; margin-bottom:5px; color:var(--ivory-dim)">Editing: "\${w.text}"</div>
      <label style="display:flex; gap:5px; align-items:center; margin-bottom:5px">
        Start: <input type="number" step="0.01" id="editStart" value="\${w.start !== null ? w.start.toFixed(2) : ''}" style="width:60px; font:inherit; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px; padding:2px">
      </label>
      <label style="display:flex; gap:5px; align-items:center; margin-bottom:5px">
        End: <input type="number" step="0.01" id="editEnd" value="\${w.end !== null ? w.end.toFixed(2) : ''}" style="width:60px; font:inherit; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px; padding:2px">
      </label>
      <div style="display:flex; gap:5px; justify-content:space-between">
         <button id="editSave" style="padding:4px 8px; font-size:11px; background:var(--vein-deep); border:0; color:white; border-radius:4px; cursor:pointer">Save</button>
         <button id="editCancel" style="padding:4px 8px; font-size:11px; background:transparent; border:1px solid var(--line); color:white; border-radius:4px; cursor:pointer">Cancel</button>
      </div>
    \`;
    p.style.display = "block";
    p.style.position = "absolute";
    p.style.left = rect.left + "px";
    p.style.top = (rect.bottom + window.scrollY + 5) + "px";
    p.style.background = "var(--panel)";
    p.style.border = "1px solid var(--vein)";
    p.style.padding = "10px";
    p.style.borderRadius = "8px";
    p.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
    p.style.zIndex = "1000";

    document.getElementById("editSave").onclick = () => {
      const s = parseFloat(document.getElementById("editStart").value);
      const e = parseFloat(document.getElementById("editEnd").value);
      if(!isNaN(s)) S.words[editingIdx].start = s;
      if(!isNaN(e)) S.words[editingIdx].end = e;
      p.style.display = "none";
      renderChips();
    };
    document.getElementById("editCancel").onclick = () => {
      p.style.display = "none";
    };
  }
`;

// Insert our editorHTML into the file right before renderChips
content = content.replace("function renderChips() {", editorHTML + "\nfunction renderChips() {");

// Change the click behavior in renderChips
// From: resyncFrom(i)
// To: if (ev.altKey) { resyncFrom(i); } else { openTimeEditor(i, b); }
content = content.replace(/resyncFrom\(i\);/g, "if (ev.altKey) { resyncFrom(i); } else { openTimeEditor(i, b); }");
content = content.replace(/b\.title = "Re-record from(.*)"/g, "b.title = \"Click to edit time · Alt-click to re-record from '$1'\"")

fs.writeFileSync('script.js', content);
console.log('script.js patched for inline time editing');
