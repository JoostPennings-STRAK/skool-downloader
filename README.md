# 🎓 Skool Downloader

A robust, platform-independent CLI tool to create local, offline backups of your [Skool.com](https://skool.com) courses. 

This tool downloads video content, localizes images, preserves course attachments, and generates a navigable, styled HTML structure that mirrors the online classroom.

> ### 🍴 This is a fork
> Forked from [`balmasi/skool-downloader`](https://github.com/balmasi/skool-downloader). On top of the original course/lesson backup it adds:
> - **Downloading videos out of community posts and their comment threads** (Skool-native, Loom, Vimeo, YouTube, Wistia) — from the CLI or a small local **web UI**.
> - A fix so the bundled `yt-dlp` runs without needing a system Python ≥ 3.10.
>
> Everything from upstream still works unchanged. Full list under [Fork changes](#-fork-changes).
> Some behaviour (the "which video did I probably want" guess) is tuned for a weekly coaching-feedback workflow — see that section.

## ✨ Features

- **🚀 Smart Binary Management:** Automatically downloads the correct `yt-dlp` and `ffmpeg` binaries for your OS (Windows, macOS, Linux) and architecture (Intel, Apple Silicon ARM, Linux ARM).
- **📹 High-Quality Video:** Downloads the highest available quality and applies `+faststart` for instant browser playback.
- **📄 Asset Localization:** Downloads all lesson images locally and rewrites HTML paths for true offline 100% viewing.
- **📎 Resource Preservation:** Automatically fetches course attachments (PDFs, DOCX, etc.) via Skool's API.
- **🎯 Single Lesson Mode:** Download a whole course or just a single lesson using a specific URL.
- **💬 Post & Thread Videos:** _(fork)_ Download videos from community posts and their nested comments — Skool-native or Loom/Vimeo/YouTube/Wistia embeds.
- **🌳 Visual Thread Picker:** _(fork)_ A local browser UI (`npm run skool-web`) renders the whole comment tree so you can pick exactly the video you want and play it back inline.
- **🛠 Interrupted Download Recovery:** Skips already downloaded files and includes a tool to regenerate the index page.

## 🛠 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

**Note:** `yt-dlp` is managed locally in the `bin/` folder — no system-wide install needed. `ffmpeg` must be available on your `PATH` (e.g. `brew install ffmpeg`); it's used to merge streams and for `+faststart`.

## 🚀 Getting Started

### 1. Installation

```bash
git clone https://github.com/JoostPennings-STRAK/skool-downloader.git
cd skool-downloader
npm install
```

### 2. Authentication

Skool uses secure authentication. This tool uses a manual login flow to capture your session safely.

```bash
npm run login
```
*A browser window will open. Log in to your Skool account. Once you see your dashboard, the script will save your session and close the browser.*

### Using NPX (upstream only)

The original package is on npm and can be run without a local checkout:

```bash
npx skool-downloader
```

Note this fetches **upstream** `balmasi/skool-downloader`, not this fork — the
post/thread and web-UI features below need a local clone (`npm run skool`).

### 3. Downloading a Course

To download an entire classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom/course-id
```

To download **all courses** in a community classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom
```

To download **multiple courses** interactively:

```bash
npm run skool
```
Then choose **Download multiple courses** and select the courses you want.

You can also run `npx skool-downloader` to enter the same interactive menu.

To download only a **single lesson**:

```bash
npm run skool "https://www.skool.com/your-community/classroom/course-id?md=lesson-id"
```

### Downloading videos from a post / thread

Community posts (the discussion feed, not the classroom) often contain videos —
in the post itself and in the comments. Point the tool at a post URL:

```bash
npm run skool "https://www.skool.com/your-community/my-post-slug"
```

It finds every video in the thread (native Skool videos plus Loom / Vimeo /
YouTube / Wistia embeds in comments). By default **nothing is pre-selected** —
you pick the one(s) you want. Exceptions: if the URL points at a comment
(`...?p=abc123`), or the tool spots the community owner's video reply sitting
under your own post/comment, that one starts selected.

Non-interactive options:

```bash
npm run skool post "<post-url>" --all          # download all of them
npm run skool post "<post-url>" --video 2,4    # download only #2 and #4
```

Output goes to `downloads/<Community>/Posts/<Post Title>/` (the post video as
`post-video.mp4`, comment videos under `comments/`), separate from courses.

### Web UI (browser)

For threads with lots of videos, a local browser UI shows the whole comment
tree so you can pick the right one visually:

```bash
npm run skool-web
```

This starts a local server (`http://localhost:4471`) and opens it in your
browser. Paste a thread URL, and you get the nested comments with **you** /
**coach** badges, a checkbox on every video, the tool's best guess highlighted,
and inline playback of anything you download.

The UI has three tabs:

- **Download** — the thread picker described above.
- **Library** — every `.mp4` under `downloads/`, newest first, with inline
  playback, a download button, and delete.
- **Settings** — import your Skool session by uploading/pasting a `cookies.txt`
  exported with the *"Get cookies.txt LOCALLY"* browser extension (needed when
  running headless / in Docker, where `npm run login` can't open a browser).

### Running as a service (Docker)

`Dockerfile` builds a long-lived container of the web UI (Playwright + Chromium
+ `ffmpeg` + `yt-dlp` baked in). Mount two volumes:

| Container path   | Purpose                                    |
|------------------|--------------------------------------------|
| `/app/downloads` | downloaded videos (shown in **Library**)   |
| `/app/.auth`     | `cookies.txt` + `storage_state.json`       |

```bash
docker build -t skool-downloader .
docker run -p 4471:4471 \
  -v "$PWD/downloads:/app/downloads" -v "$PWD/auth:/app/.auth" \
  skool-downloader
```

Then open the **Settings** tab once to import a `cookies.txt`. There is no
built-in authentication — put it behind a reverse proxy / VPN if it's not
localhost-only. `.gitea/workflows/build-deploy.yml` builds and deploys it to the
homelab on every push to `main`.

## 📁 Output Structure

The tool creates a `downloads/` folder with the following structure:
```text
downloads/
└── Community Name/
    ├── Course Name/
    │   ├── index.html (Master navigation page)
    │   └── 1-Module Name/
    │       ├── 1-Lesson Title/
    │       │   ├── index.html (The lesson page)
    │       │   ├── video.mp4
    │       │   ├── assets/ (Localized images)
    │       │   └── resources/ (Attachments)
    │       └── ...
    └── Posts/                        (fork: post/thread downloads)
        └── Post Title/
            ├── index.html            (thread overview + players)
            ├── .post.json            (every video found in the thread)
            ├── post-video.mp4        (the post's own video, if downloaded)
            └── comments/
                └── 02-Author-Video Title.mp4
```

## 🔧 Advanced

### Regenerating the Index
If you manually move files or skip lessons, you can regenerate the master `index.html` file based on the current contents of your `downloads/` folder:

```bash
npm run regenerate-index
```

## 🍴 Fork changes

Everything below is additive — the classroom/course flow is untouched.

### `v1.1.0` — Post & thread video downloads + web UI

- **`npm run skool <post-url>`** (or `npm run skool post <url>`) downloads videos
  from a community **post and its comment thread**, not just the classroom. It
  walks every nested comment and finds:
  - native Skool/Mux videos (HLS reconstructed from the page's own playback token),
  - Loom embeds (resolved via Loom's `transcoded-url` API, because yt-dlp's Loom
    extractor is currently broken),
  - Vimeo / YouTube / Wistia embeds (handed to yt-dlp).
- **Nothing is selected by default** — you usually want one video out of a thread.
  The tool pre-selects only when it's fairly sure: the URL points at a comment
  (`?p=…`), or the community **owner** posted a video reply inside your own
  post/comment (the coaching-feedback case). Override with `--all` / `--video 1,3`.
- **`npm run skool-web`** starts a local, dependency-free web server
  (`http://localhost:4471`, opens automatically) that shows the whole comment
  tree with **you** / **coach** badges, a checkbox per video, the best guess
  highlighted, live download progress, and inline playback of what you download.
  Nothing is hosted; it runs only while the command runs, only on your machine.
- Output lands in `downloads/<Community>/Posts/<Post Title>/`, kept separate from
  the course structure.

### yt-dlp binary fix

`yt-dlp-wrap` downloads the plain `yt-dlp` zipapp, which needs a system Python
≥ 3.10 (missing on stock macOS). The fork downloads the standalone
`yt-dlp_macos` / `yt-dlp_linux*` / `yt-dlp.exe` build instead, which bundles its
own Python. `ffmpeg` still needs to be on your `PATH`.

## 🛡 Disclaimer

This tool is for **personal backup and offline viewing purposes only**. Please respect the content creators' terms of service and intellectual property rights. Do not distribute downloaded content without permission.

## 📄 License

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** license. See `LICENSE` for the full legal code.
