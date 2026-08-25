const fs = require('fs');
let code = fs.readFileSync('script.js', 'utf8');

const newJs = `
if ($("btnGenerate")) {
  $("btnGenerate").addEventListener("click", async () => {
    const topic = $("topicInput").value.trim();
    if (!topic) return alert("Enter a topic first!");
    const btn = $("btnGenerate");
    const orig = btn.textContent;
    btn.textContent = "⏳ Generating...";
    btn.disabled = true;
    try {
      const res = await fetch("/api/generate-script", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({topic})
      });
      const data = await res.json();
      scriptEl.value = data.script;
      parseScript();
    } catch(e) { alert(e.message); }
    btn.textContent = orig; btn.disabled = false;
  });
}

if ($("btnEmojify")) {
  $("btnEmojify").addEventListener("click", async () => {
    const script = scriptEl.value.trim();
    if (!script) return alert("Paste or generate a script first!");
    const btn = $("btnEmojify");
    const orig = btn.textContent;
    btn.textContent = "⏳ Adding...";
    btn.disabled = true;
    try {
      const res = await fetch("/api/emojify", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({script})
      });
      const data = await res.json();
      scriptEl.value = data.script;
      parseScript();
    } catch(e) { alert(e.message); }
    btn.textContent = orig; btn.disabled = false;
  });
}
`;

code += "\n\n" + newJs;
fs.writeFileSync('script.js', code);
