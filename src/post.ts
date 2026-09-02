import fs from 'fs-extra';
import path from 'path';
import { Scraper, type PostResult, type ThreadVideo } from './scraper.js';
import { Downloader } from './downloader.js';
import { createConsoleLogger, type Logger } from './logger.js';

const SKOOL_HLS_HOST = 'https://stream.video.skool.com';

export type VideoSelector = (
    videos: ThreadVideo[],
    context: { postTitle: string; preselectShortId?: string; suggestedVideoIndexes: number[] }
) => Promise<ThreadVideo[]>;

export type DownloadPostOptions = {
    url: string;
    outputDir?: string;
    logger?: Logger;
    /** Chooses which videos to download. Defaults to "all". */
    selectVideos?: VideoSelector;
    /** Skip the initial thread scrape by supplying an already-fetched result. */
    preloaded?: PostResult;
};

export type DownloadPostSummary = {
    groupName: string;
    postTitle: string;
    outputDir: string;
    totalVideos: number;
    selectedVideos: number;
    downloaded: number;
    failed: number;
    /** Downloaded video files, paths relative to the `downloads/` root. */
    files: string[];
};

function sanitizeName(value: string) {
    return value.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').trim();
}

function formatDuration(ms?: number) {
    if (!ms || ms <= 0) return '';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Loom's own extractor in yt-dlp breaks regularly. This asks Loom for the
 * signed, direct CDN mp4 URL, which is stable and needs no auth.
 */
async function resolveLoomDirectUrl(loomUrl: string): Promise<string | null> {
    const match = loomUrl.match(/loom\.com\/(?:share|embed)\/([0-9a-f]{32})/i);
    if (!match) return null;
    try {
        const resp = await fetch(
            `https://www.loom.com/api/campaigns/sessions/${match[1]}/transcoded-url`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        );
        if (!resp.ok) return null;
        const json: any = await resp.json();
        return typeof json?.url === 'string' ? json.url : null;
    } catch {
        return null;
    }
}

/**
 * Turns a discovered ThreadVideo into a concrete URL that yt-dlp can fetch.
 * Returns null when the source can't be resolved (caller links it instead).
 */
async function resolveVideoUrl(
    video: ThreadVideo,
    postUrl: string,
    scraper: Scraper,
    logger: Logger
): Promise<string | null> {
    if (video.kind === 'native') {
        if (video.playbackId && video.playbackToken) {
            return `${SKOOL_HLS_HOST}/${video.playbackId}.m3u8?token=${video.playbackToken}`;
        }
        if (video.nativeVideoId) {
            logger.info('    ℹ️ Resolving native video token via player interaction...');
            const link = await scraper.captureNativePostVideoLink(
                postUrl,
                video.nativeVideoId,
                video.commentShortId
            );
            return link || null;
        }
        return null;
    }

    // external
    if (!video.externalUrl) return null;
    if (video.provider === 'loom') {
        const direct = await resolveLoomDirectUrl(video.externalUrl);
        if (direct) return direct;
        logger.warn('    ⚠️ Loom direct URL unavailable, falling back to yt-dlp extractor.');
    }
    // yt-dlp handles vimeo / youtube / wistia / loom share URLs directly.
    return video.externalUrl;
}

function videoFileBase(video: ThreadVideo): string {
    if (video.source === 'post') {
        return 'post-video';
    }
    const label = sanitizeName(`${video.author} ${video.title}`).slice(0, 80);
    return `${String(video.index).padStart(2, '0')}-${label}`;
}

const PAGE_CSS = `
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Space Grotesk", "Segoe UI", sans-serif;
        background: linear-gradient(160deg, #fdfdfd 0%, #eff2fb 100%); color: #14161d; line-height: 1.7; }
    .page { max-width: 980px; margin: 48px auto 80px; padding: 0 22px; }
    .container { background: #fff; padding: 34px; border-radius: 20px; border: 1px solid rgba(20,22,29,0.05);
        box-shadow: 0 25px 45px rgba(15,23,42,0.18), 0 10px 20px rgba(15,23,42,0.08); }
    h1 { margin: 0 0 8px; font-size: clamp(1.8rem, 3vw, 2.6rem); }
    .meta { color: #5b6271; margin-bottom: 24px; }
    .post-body { font-size: 1.05rem; border-bottom: 1px solid rgba(20,22,29,0.08); padding-bottom: 8px; margin-bottom: 24px; }
    .video-item { margin: 28px 0; }
    .video-item h3 { margin: 0 0 4px; }
    .video-item .who { color: #5b6271; font-size: 0.95rem; margin-bottom: 10px; }
    video { width: 100%; border-radius: 14px; background: #000; box-shadow: 0 10px 24px rgba(15,23,42,0.2); }
    .badge { display: inline-block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 2px 8px; border-radius: 999px; background: #eef1fb; color: #3b4a86; margin-left: 8px; }
    a { color: #3b82f6; text-decoration: none; word-break: break-word; }
    a:hover { text-decoration: underline; }
`;

function buildIndexHtml(
    result: PostResult,
    rendered: Array<{ video: ThreadVideo; relPath?: string; linkUrl?: string }>
): string {
    const items = rendered
        .map(({ video, relPath, linkUrl }) => {
            const heading = video.source === 'post' ? 'Post video' : `Comment · ${video.author}`;
            const dur = formatDuration(video.durationMs);
            const player = relPath
                ? `<video controls preload="metadata" src="${relPath}"></video>`
                : `<p>Not downloaded — <a href="${linkUrl || video.externalUrl}" target="_blank">open original (${video.provider})</a></p>`;
            return `
            <div class="video-item">
                <h3>${heading}<span class="badge">${video.provider}</span></h3>
                <div class="who">${video.title}${dur ? ` · ${dur}` : ''}</div>
                ${player}
            </div>`;
        })
        .join('');

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${result.postTitle}</title>
    <style>${PAGE_CSS}</style>
</head>
<body>
    <div class="page">
        <div class="container">
            <h1>${result.postTitle}</h1>
            <div class="meta">${result.groupName} · <a href="${result.url}" target="_blank">view thread on Skool</a></div>
            <div class="post-body">${result.postContentHtml}</div>
            ${items}
        </div>
    </div>
</body>
</html>`;
}

/**
 * Downloads selected videos from a Skool community post/thread (the post itself
 * and any of its comments) into `downloads/<Group>/Posts/<Post Title>/`.
 */
export async function downloadPost(options: DownloadPostOptions): Promise<DownloadPostSummary> {
    const logger = options.logger ?? createConsoleLogger();
    const scraper = new Scraper(logger);
    const downloader = new Downloader(logger);

    try {
        let result = options.preloaded;
        if (result) {
            logger.info('🚀 Using already-loaded thread data...');
        } else {
            logger.info('🚀 Reading post/thread...');
            result = await scraper.extractPostData(options.url);
        }

        if (result.videos.length === 0) {
            throw new Error('No videos found in this post or its comments.');
        }
        logger.info(`✅ Found ${result.videos.length} video(s) in "${result.postTitle}".`);

        const select = options.selectVideos ?? (async (videos) => videos);
        const selected = await select(result.videos, {
            postTitle: result.postTitle,
            preselectShortId: result.preselectShortId,
            suggestedVideoIndexes: result.suggestedVideoIndexes
        });

        if (selected.length === 0) {
            logger.warn('No videos selected — nothing to download.');
            return {
                groupName: result.groupName,
                postTitle: result.postTitle,
                outputDir: '',
                totalVideos: result.videos.length,
                selectedVideos: 0,
                downloaded: 0,
                failed: 0,
                files: []
            };
        }

        const baseOutputDir =
            options.outputDir && options.outputDir !== 'undefined'
                ? options.outputDir
                : path.join(
                      process.cwd(),
                      'downloads',
                      sanitizeName(result.groupName),
                      'Posts',
                      sanitizeName(result.postTitle)
                  );
        await fs.ensureDir(baseOutputDir);
        logger.info(`📁 Saving to: ${baseOutputDir}`);

        let downloaded = 0;
        let failed = 0;
        const seenBase = new Map<string, number>();
        const rendered: Array<{ video: ThreadVideo; relPath?: string; linkUrl?: string }> = [];
        const downloadsRoot = path.join(process.cwd(), 'downloads');
        const files: string[] = [];

        for (const video of selected) {
            const label = `[${video.index}] ${video.source === 'post' ? 'post' : video.author}: ${video.title}`;
            logger.info(`\n  🎬 ${label}`);

            let targetUrl: string | null = null;
            try {
                targetUrl = await resolveVideoUrl(video, result.url, scraper, logger);
            } catch (err) {
                logger.warn(`    ⚠️ Could not resolve video source: ${String(err)}`);
            }

            if (!targetUrl) {
                logger.warn('    ⚠️ Skipping — no downloadable source. Linking original instead.');
                failed += 1;
                rendered.push({ video, linkUrl: video.externalUrl });
                continue;
            }

            const subDir = video.source === 'post' ? baseOutputDir : path.join(baseOutputDir, 'comments');
            let base = videoFileBase(video);
            const dupCount = seenBase.get(base) ?? 0;
            seenBase.set(base, dupCount + 1);
            if (dupCount > 0) base = `${base}-${dupCount + 1}`;

            try {
                await downloader.downloadVideo(targetUrl, subDir, base);
                downloaded += 1;
                const fullPath = path.join(subDir, `${base}.mp4`);
                rendered.push({
                    video,
                    relPath: path.relative(baseOutputDir, fullPath).split(path.sep).join('/')
                });
                const fromRoot = path.relative(downloadsRoot, fullPath);
                if (!fromRoot.startsWith('..')) files.push(fromRoot.split(path.sep).join('/'));
            } catch (err) {
                logger.warn(`    ⚠️ Download failed: ${String(err)}`);
                failed += 1;
                rendered.push({ video, linkUrl: video.externalUrl });
            }
        }

        await fs.writeFile(path.join(baseOutputDir, 'index.html'), buildIndexHtml(result, rendered));
        await fs.writeJson(
            path.join(baseOutputDir, '.post.json'),
            { ...result, selectedIndexes: selected.map((v) => v.index), updatedAt: new Date().toISOString() },
            { spaces: 2 }
        );

        logger.info(`\n✨ Done. ${downloaded} downloaded, ${failed} failed/linked.`);
        logger.info(`Check your files in: ${baseOutputDir}`);

        return {
            groupName: result.groupName,
            postTitle: result.postTitle,
            outputDir: baseOutputDir,
            totalVideos: result.videos.length,
            selectedVideos: selected.length,
            downloaded,
            failed,
            files
        };
    } finally {
        await scraper.close();
    }
}
