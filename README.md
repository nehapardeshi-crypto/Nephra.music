# nephra.music

Static one-page site for NEPHRA (V2 — directory index + destination pages).

## Structure
- `index.html` — entry; hash routes `#/videos`, `#/releases`, `#/playlists`, `#/shows`, `#/press`, `#/contact`, `#/about`
- `js/data.js` — **all editable content** (videos, playlists, past events, releases, press, rider, socials)
- `js/*.babel` — React views (compiled in-browser by Babel standalone)
- `js/ds-bundle.js` — NEPHRA design-system components
- `styles.css` + `tokens/` — fonts, colours, type, spacing
- `assets/` — logos, web photos, full-res press photos, press deck PDF

## Deploy
No build step. Push to GitHub and enable **GitHub Pages** (Settings → Pages → branch `main`, root), or connect the repo to Netlify / Vercel / Cloudflare Pages as a static site. Point `nephra.music` DNS at the host.

Note: `.babel` files are transpiled in the browser. For best performance, a developer can later precompile them with Vite/esbuild.
