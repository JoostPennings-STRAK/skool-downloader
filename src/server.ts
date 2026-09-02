import http from 'http';
import { exec } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { Scraper, type PostResult } from './scraper.js';
import { downloadPost } from './post.js';
import { getAuthStatus, importCookiesTxt } from './auth.js';
import type { Logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
const BASE_PORT = 4471;

/** Remembers the last scrape per thread URL so downloading skips a re-scrape. */
const threadCache = new Map<string, PostResult>();

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(payload);
}

async function readText(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: http.IncomingMessage): Promise<any> {
    const text = await readText(req);
    if (!text) return {};
    return JSON.parse(text);
}

async function handleThread(res: http.ServerResponse, url: string) {
    const scraper = new Scraper({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
    try {
        const result = await scraper.extractPostData(url);
        threadCache.set(result.url, result);
        threadCache.set(url, result);
        send(res, 200, {
            url: result.url,
            postTitle: result.postTitle,
            groupName: result.groupName,
            preselectShortId: result.preselectShortId,
            suggestedVideoIndexes: result.suggestedVideoIndexes,
            videos: result.videos,
            tree: result.threadTree
        });
    } catch (err) {
        send(res, 400, { error: String(err instanceof Error ? err.message : err) });
    } finally {
        await scraper.close();
    }
}

async function handleDownload(res: http.ServerResponse, body: any) {
    const { url, indexes } = body ?? {};
    if (typeof url !== 'string' || !Array.isArray(indexes) || indexes.length === 0) {
        send(res, 400, { error: 'Expected { url, indexes: number[] }' });
        return;
    }
    const wanted = new Set<number>(indexes.map(Number));

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const emit = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    const streamLogger: Logger = {
        info: (m) => emit({ type: 'log', line: m }),
        warn: (m) => emit({ type: 'log', line: `⚠️ ${m}` }),
        error: (m, e) => emit({ type: 'log', line: `❌ ${m}${e ? ` ${String(e)}` : ''}` }),
        debug: () => {}
    };

    try {
        const summary = await downloadPost({
            url,
            logger: streamLogger,
            preloaded: threadCache.get(url),
            selectVideos: async (videos) => videos.filter((v) => wanted.has(v.index))
        });
        emit({ type: 'done', summary });
    } catch (err) {
        emit({ type: 'error', error: String(err instanceof Error ? err.message : err) });
    } finally {
        res.end();
    }
}

/** Resolves a `downloads/`-relative path, or null if it escapes the root. */
function resolveInDownloads(rel: string): string | null {
    const target = path.resolve(DOWNLOADS_DIR, rel);
    if (target !== DOWNLOADS_DIR && !target.startsWith(DOWNLOADS_DIR + path.sep)) return null;
    return target;
}

/** Serves a downloaded file for in-page preview or download. Confined to ./downloads. */
function handleFile(req: http.IncomingMessage, res: http.ServerResponse, rel: string, asAttachment: boolean) {
    const target = resolveInDownloads(rel);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        send(res, 404, { error: 'Not found' });
        return;
    }
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.mp4' ? 'video/mp4' : ext === '.html' ? 'text/html' : 'application/octet-stream';
    const size = fs.statSync(target).size;
    const headers: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
    };
    if (asAttachment) {
        headers['Content-Disposition'] = `attachment; filename="${path.basename(target).replace(/"/g, '')}"`;
    }

    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : size - 1;
        if (start > end || end >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            res.end();
            return;
        }
        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1)
        });
        fs.createReadStream(target, { start, end }).pipe(res);
        return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': String(size) });
    fs.createReadStream(target).pipe(res);
}

/** Lists downloaded video files, newest first. */
async function handleLibrary(res: http.ServerResponse) {
    const items: { path: string; name: string; dir: string; size: number; mtime: number }[] = [];
    async function walk(abs: string) {
        let entries: string[] = [];
        try {
            entries = await fs.readdir(abs);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(abs, entry);
            const stat = await fs.stat(full);
            if (stat.isDirectory()) {
                await walk(full);
            } else if (path.extname(entry).toLowerCase() === '.mp4') {
                const rel = path.relative(DOWNLOADS_DIR, full);
                items.push({
                    path: rel,
                    name: entry,
                    dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
                    size: stat.size,
                    mtime: stat.mtimeMs
                });
            }
        }
    }
    await fs.ensureDir(DOWNLOADS_DIR);
    await walk(DOWNLOADS_DIR);
    items.sort((a, b) => b.mtime - a.mtime);
    send(res, 200, { items });
}

/** Deletes one downloaded file and prunes now-empty parent folders. */
async function handleDelete(res: http.ServerResponse, rel: string) {
    const target = resolveInDownloads(rel);
    if (!target || target === DOWNLOADS_DIR || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        send(res, 404, { error: 'Not found' });
        return;
    }
    await fs.remove(target);
    let dir = path.dirname(target);
    while (dir !== DOWNLOADS_DIR && dir.startsWith(DOWNLOADS_DIR + path.sep)) {
        const remaining = await fs.readdir(dir);
        if (remaining.length > 0) break;
        await fs.remove(dir);
        dir = path.dirname(dir);
    }
    send(res, 200, { ok: true });
}

async function handleImport(res: http.ServerResponse, raw: string) {
    try {
        const status = await importCookiesTxt(raw);
        send(res, 200, { status: status.status, expiresAt: status.expiresAt ?? null });
    } catch (err) {
        send(res, 400, { error: String(err instanceof Error ? err.message : err) });
    }
}

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    try {
        if (req.method === 'GET' && reqUrl.pathname === '/') {
            send(res, 200, await fs.readFile(path.join(WEB_DIR, 'index.html'), 'utf8'), 'text/html');
            return;
        }
        if (req.method === 'GET' && reqUrl.pathname === '/api/auth') {
            const status = await getAuthStatus();
            send(res, 200, { status: status.status, expiresAt: status.expiresAt ?? null });
            return;
        }
        if (req.method === 'GET' && reqUrl.pathname === '/api/thread') {
            const url = reqUrl.searchParams.get('url');
            if (!url) return send(res, 400, { error: 'Missing ?url' });
            await handleThread(res, url);
            return;
        }
        if (req.method === 'POST' && reqUrl.pathname === '/api/auth/import') {
            await handleImport(res, await readText(req));
            return;
        }
        if (req.method === 'POST' && reqUrl.pathname === '/api/download') {
            await handleDownload(res, await readBody(req));
            return;
        }
        if (req.method === 'GET' && reqUrl.pathname === '/api/library') {
            await handleLibrary(res);
            return;
        }
        if (req.method === 'GET' && reqUrl.pathname === '/api/file') {
            handleFile(req, res, reqUrl.searchParams.get('path') || '', reqUrl.searchParams.get('dl') === '1');
            return;
        }
        if (req.method === 'DELETE' && reqUrl.pathname === '/api/file') {
            await handleDelete(res, reqUrl.searchParams.get('path') || '');
            return;
        }
        send(res, 404, { error: 'Not found' });
    } catch (err) {
        send(res, 500, { error: String(err instanceof Error ? err.message : err) });
    }
});

function listen(port: number, attempt = 0) {
    server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
            listen(port + 1, attempt + 1);
        } else {
            console.error(err);
            process.exit(1);
        }
    });
    server.listen(port, () => {
        const addr = `http://localhost:${port}`;
        console.log(`\n  Skool Downloader — web UI running at ${addr}\n`);
        if (process.platform === 'darwin') exec(`open ${addr}`);
        else if (process.platform === 'win32') exec(`start ${addr}`);
    });
}

listen(BASE_PORT);
