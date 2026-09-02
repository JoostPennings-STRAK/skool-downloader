import http from 'http';
import { exec } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { Scraper, type PostResult } from './scraper.js';
import { downloadPost } from './post.js';
import { getAuthStatus } from './auth.js';
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

async function readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

/** Serves a downloaded file for in-page preview. Confined to ./downloads. */
function handleFile(res: http.ServerResponse, rel: string) {
    const target = path.resolve(DOWNLOADS_DIR, rel);
    if (!target.startsWith(DOWNLOADS_DIR + path.sep) || !fs.existsSync(target)) {
        send(res, 404, { error: 'Not found' });
        return;
    }
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.mp4' ? 'video/mp4' : ext === '.html' ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(target).pipe(res);
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
        if (req.method === 'POST' && reqUrl.pathname === '/api/download') {
            await handleDownload(res, await readBody(req));
            return;
        }
        if (req.method === 'GET' && reqUrl.pathname === '/api/file') {
            handleFile(res, reqUrl.searchParams.get('path') || '');
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
