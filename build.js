// Build step: precompile the site's JSX so browsers never load @babel/standalone
// or transpile at runtime (that alone was most of the Lighthouse TBT/LCP penalty).
// Reads index.html + js/*.babel, emits a static dist/ with plain <script> tags.
const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const STATIC_DIRS = ["assets", "tokens"];
const STATIC_FILES = ["styles.css", "sitemap.xml", "robots.txt"];
const PLAIN_JS = ["js/ds-bundle.js", "js/data.js"];
const BABEL_FILES = ["js/Shell.babel", "js/Media.babel", "js/Kit.babel", "js/Tree.babel"];

function compile(source, filename) {
  const { code } = babel.transform(source, {
    filename,
    presets: [["@babel/preset-react", { runtime: "classic" }]],
    comments: false,
  });
  return code;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(DIST);
fs.mkdirSync(path.join(DIST, "js"), { recursive: true });

for (const dir of STATIC_DIRS) copyDir(path.join(ROOT, dir), path.join(DIST, dir));
for (const f of STATIC_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
for (const f of PLAIN_JS) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
// Ship a tiny stub instead of the ~25KB design-tool edit-mode overlay (js/tweaks-panel.babel),
// which never activates outside that tool's iframe host and would otherwise load for every visitor.
fs.copyFileSync(path.join(ROOT, "js/tweaks-panel.prod.js"), path.join(DIST, "js/tweaks-panel.js"));

for (const f of BABEL_FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const out = compile(src, f);
  const outName = f.replace(/\.babel$/, ".js");
  fs.writeFileSync(path.join(DIST, outName), out);
}

// index.html: swap dev/babel-standalone CDN tags for prod builds, point .babel
// scripts at their compiled .js siblings, and compile the inline App script
// (kept as JSX in source so the tweaks-panel EDITMODE marker stays editable).
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

html = html.replace(
  /<script src="https:\/\/unpkg\.com\/react@18\.3\.1\/umd\/react\.development\.js"[^>]*><\/script>/,
  '<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" integrity="sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z" crossorigin="anonymous"></script>'
);
html = html.replace(
  /<script src="https:\/\/unpkg\.com\/react-dom@18\.3\.1\/umd\/react-dom\.development\.js"[^>]*><\/script>/,
  '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" integrity="sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1" crossorigin="anonymous"></script>'
);
html = html.replace(/<script src="https:\/\/unpkg\.com\/@babel\/standalone[^>]*><\/script>\n/, "");
html = html.replace(/<script type="text\/babel" src="(\.\/js\/[^"]+)\.babel"><\/script>/g, '<script src="$1.js"></script>');

const inlineMatch = html.match(/<script type="text\/babel">\n([\s\S]*?)\n<\/script>\n<\/body>/);
if (!inlineMatch) throw new Error("Could not find inline App script in index.html");
const compiledInline = compile(inlineMatch[1], "index.html-inline.jsx");
html = html.replace(inlineMatch[0], `<script>\n${compiledInline}\n</script>\n</body>`);

fs.writeFileSync(path.join(DIST, "index.html"), html);
console.log("Built dist/ (JSX precompiled, React production builds, no runtime Babel).");
