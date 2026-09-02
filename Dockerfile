# Skool Downloader web service — runs the local web UI (src/server.ts) as a
# long-lived container. Base image bundles Chromium matching Playwright 1.58.
FROM mcr.microsoft.com/playwright:v1.58.0-noble

ENV NODE_ENV=production
WORKDIR /app

# yt-dlp needs ffmpeg for stream merging + `+faststart`; curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# The app runs straight from TS via tsx (a runtime dependency, not a devDep).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Bake the Linux yt-dlp binary so the first run doesn't reach out to GitHub.
RUN mkdir -p bin \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o bin/yt-dlp \
    && chmod +x bin/yt-dlp

EXPOSE 4471

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4471/api/auth || exit 1

CMD ["npm", "run", "skool-web"]
