const fs = require('fs');

const html = fs.readFileSync('voice-match.html', 'utf8');
const lines = html.split('\n');

const styleStart = lines.findIndex(l => l.includes('<style>'));
const styleEnd = lines.findIndex(l => l.includes('</style>'));

const scriptStart = lines.findIndex(l => l.includes('<script>'));
const scriptEnd = lines.findIndex(l => l.includes('</script>'));

const css = lines.slice(styleStart + 1, styleEnd).join('\n');
const js = lines.slice(scriptStart + 1, scriptEnd).join('\n');

const newHtml = [
  ...lines.slice(0, styleStart),
  '<link rel="stylesheet" href="voice-match.css">',
  ...lines.slice(styleEnd + 1, scriptStart),
  '<script src="voice-match.js" type="module"></script>',
  ...lines.slice(scriptEnd + 1)
].join('\n');

fs.writeFileSync('voice-match.css', css);
fs.writeFileSync('voice-match.js', js);
fs.writeFileSync('voice-match.html', newHtml);

console.log('Split voice-match complete.');
