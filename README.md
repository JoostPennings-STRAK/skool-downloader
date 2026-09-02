# 🎓 Skool Downloader

A robust, platform-independent CLI tool to create local, offline backups of your [Skool.com](https://skool.com) courses. 

This tool downloads video content, localizes images, preserves course attachments, and generates a navigable, styled HTML structure that mirrors the online classroom.

## ✨ Features

- **🚀 Smart Binary Management:** Automatically downloads the correct `yt-dlp` and `ffmpeg` binaries for your OS (Windows, macOS, Linux) and architecture (Intel, Apple Silicon ARM, Linux ARM).
- **📹 High-Quality Video:** Downloads the highest available quality and applies `+faststart` for instant browser playback.
- **📄 Asset Localization:** Downloads all lesson images locally and rewrites HTML paths for true offline 100% viewing.
- **📎 Resource Preservation:** Automatically fetches course attachments (PDFs, DOCX, etc.) via Skool's API.
- **🎯 Single Lesson Mode:** Download a whole course or just a single lesson using a specific URL.
- **🛠 Interrupted Download Recovery:** Skips already downloaded files and includes a tool to regenerate the index page.

## 🛠 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

**Note:** No system-wide installation of `yt-dlp` or `ffmpeg` is required. The tool manages these locally in the `bin/` folder.

## 🚀 Getting Started

### 1. Installation

```bash
git clone https://github.com/balmasi/skool-downloader.git
cd skool-downloader
npm install
```

### 2. Authentication

Skool uses secure authentication. This tool uses a manual login flow to capture your session safely.

```bash
npm run login
```
*A browser window will open. Log in to your Skool account. Once you see your dashboard, the script will save your session and close the browser.*

### 3. Using NPX

This package is published on npm, so you can run the CLI without installing anything locally:

```bash
npx skool-downloader
```

If you prefer to stay completely local (and allow offline development), run `npm install` once and use `npm run skool` as shown below.

If you prefer to stay completely local (and allow offline development), run `npm install` once and use `npm run skool` as shown below.

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
and inline playback of anything you download. Nothing is hosted — it only runs
while the command is running, and only on your machine.

## 📁 Output Structure

The tool creates a `downloads/` folder with the following structure:
```text
downloads/
└── Community Name/
    └── Course Name/
        ├── index.html (Master navigation page)
        └── 1-Module Name/
            ├── 1-Lesson Title/
            │   ├── index.html (The lesson page)
            │   ├── video.mp4
            │   ├── assets/ (Localized images)
            │   └── resources/ (Attachments)
            └── ...
```

## 🔧 Advanced

### Regenerating the Index
If you manually move files or skip lessons, you can regenerate the master `index.html` file based on the current contents of your `downloads/` folder:

```bash
npm run regenerate-index
```

## 🛡 Disclaimer

This tool is for **personal backup and offline viewing purposes only**. Please respect the content creators' terms of service and intellectual property rights. Do not distribute downloaded content without permission.

## 📄 License

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** license. See `LICENSE` for the full legal code.
