const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const lines = html.split('\n');

const styleStart = lines.findIndex(l => l.includes('<style>'));
const styleEnd = lines.findIndex(l => l.includes('</style>'));

const scriptStart = lines.findIndex(l => l.includes('<script>'));
const scriptEnd = lines.findIndex(l => l.includes('</script>'));

const css = lines.slice(styleStart + 1, styleEnd).join('\n');
const js = lines.slice(scriptStart + 1, scriptEnd).join('\n');

const newHtml = [
  ...lines.slice(0, styleStart),
  '<link rel="stylesheet" href="style.css">',
  ...lines.slice(styleEnd + 1, scriptStart),
  '<script src="script.js" type="module"></script>',
  ...lines.slice(scriptEnd + 1)
].join('\n');

fs.writeFileSync('style.css', css);
fs.writeFileSync('script.js', js);
fs.writeFileSync('index.html', newHtml);

console.log('Split complete.');
