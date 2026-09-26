# SVG Book Toolkit

Local tools for pulling page SVGs (and their image assets) off a site, packing them into a folder, and building a multi-page PDF. Everything runs on your machine. Nothing gets uploaded to a third-party service.

**Author:** Avrixfal · GitHub [@VoxyB89](https://github.com/VoxyB89)

---

## What’s in the box

| File | Role |
|------|------|
| `index.html` | Single UI with tabs: Batch downloader, Folder → PDF, Composite → PNG, and a short how-to |
| `server.js` | Local Node helper (CORS/cookie proxy + heavy PDF convert for big books) |
| `LICENSE` | Use terms — read it |
| `README.md` | This file |

---

## Quick start

1. Install [Node.js](https://nodejs.org/) if you don’t have it.
2. In this folder:

```bash
npm install pdf-lib sharp
node server.js
```

You should see something like:

```text
SVG Book Toolkit server  http://localhost:8788
```

3. Open `index.html` in Chrome or Edge (double-click is fine).
4. Leave the terminal open while you work.

Default server port is **8788**. Optional:

```bash
node server.js 9000
```

---

## Typical workflow

### 1. Download pages + assets

- Tab **Batch downloader**
- Paste one example SVG URL (the number that changes across pages becomes `{n}`)
- Set From / To
- Turn on “Download referenced images”
- If the site needs a login cookie, set the proxy to  
  `http://localhost:8788/proxy?url=`  
  and paste the Cookie header
- Start → download the ZIP

ZIP layout looks like:

```text
1.svg
135.svg
135/img/4.png
12/shade/1.png
```

SVGs sit at the root. Asset folders match the paths in the links.

### 2. Build a PDF

**Small folders**  
Tab **Folder → PDF** → Choose folder → Convert in browser.

**Large books (100+ pages, thousands of assets)**  
Same tab → fill in:

- Server: `http://localhost:8788`
- Absolute path to the unzipped folder on your PC

Then **Convert via local server**.  
The PDF is written **next to that folder** (e.g. `combined.pdf`). The page will show the path. Open it from Explorer.

> If you use **Internet Download Manager**, it can break browser downloads from localhost. Saving on disk avoids that. You can also turn off IDM’s browser integration for `localhost`.

### 3. One messy SVG → one PNG

Tab **Composite → PNG** is for a single SVG that points at external images. It resolves those refs and exports one PNG.

---

## Server endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Sanity check |
| GET | `/proxy?url=` | Forward request; optional `X-Inject-Cookie` header |
| POST | `/convert` | JSON `{ "folder", "pageSize", "dpi", "outputName" }` → writes PDF, returns `{ path, bytes }` |
| GET | `/open?path=` | Stream a PDF already on disk |

---

## Page size notes

For uniform A4 (and similar), pages are **stretched to fill the full page** so you don’t get white bars. That can slightly distort content that isn’t the same aspect ratio as the page. If you need letterboxing or crop-to-fill instead, say so in an issue on the official repo.

---

## Disclaimer (read this)

This toolkit is a **local convenience utility**. You are responsible for:

- only downloading content you’re allowed to access and keep;
- respecting site terms, copyright, and regional law;
- anything that happens to your accounts or devices when you use it.

The author is **not** responsible for misuse, bans, takedowns, or legal claims arising from how *you* use the software. See `LICENSE`.

---

## License

Proprietary. See the `LICENSE` file.

Short version: you may use what you download from the official source for yourself. You may not sell it, re-upload it, or redistribute it.

**Copyright © 2026 Avrixfal (GitHub: VoxyB89). All rights reserved.**

---

## Official source

Only download from the repository or release page under **VoxyB89**. Copies found elsewhere may be outdated or altered.
