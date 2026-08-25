const fs = require('fs');
let code = fs.readFileSync('script.js', 'utf8');

// Append state variable initializations
code = code.replace(
  'const S = {',
  'const S = {\n  animStyle: "none", hlColor: "#FACC15",'
);

// Append event listeners for the new inputs
const newListeners = `
/* ============================================================
   Step 4 UI Events
   ============================================================ */
if (document.getElementById("captionAnimStyle")) {
  document.getElementById("captionAnimStyle").addEventListener("change", e => {
    S.animStyle = e.target.value;
  });
}
if (document.getElementById("customHlColor")) {
  document.getElementById("customHlColor").addEventListener("input", e => {
    S.hlColor = e.target.value;
  });
}
`;
code += "\n\n" + newListeners;

// Modify buildASS to apply styles
const buildAssSearch = `    L.push("Dialogue: 0," + assTime(w.start) + "," + assTime(w.end) +
           ",Karaoke,,0,0,0,,{\\\\pos(" + x + "," + y + ")}" + text);`;

const buildAssReplace = `    let fx = "";
    if (S.animStyle === "pop") fx = "\\\\fscx0\\\\fscy0\\\\t(0,150,\\\\fscx100\\\\fscy100)";
    if (S.animStyle === "bounce") fx = "\\\\fscx0\\\\fscy0\\\\t(0,100,\\\\fscx120\\\\fscy120)\\\\t(100,200,\\\\fscx100\\\\fscy100)";
    if (S.animStyle === "fade") fx = "\\\\fad(200,0)";
    
    L.push("Dialogue: 0," + assTime(w.start) + "," + assTime(w.end) +
           ",Karaoke,,0,0,0,,{\\\\pos(" + x + "," + y + ")" + fx + "}" + text);`;

code = code.replace(buildAssSearch, buildAssReplace);

fs.writeFileSync('script.js', code);
console.log("Patched script.js for UI events and ASS export styles");
