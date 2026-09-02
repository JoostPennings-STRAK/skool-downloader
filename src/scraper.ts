import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs-extra';
import { createConsoleLogger, type Logger } from './logger.js';
import { STORAGE_STATE_PATH } from './auth.js';

export interface Resource {
    title: string;
    file_id?: string;
    file_name?: string;
    file_content_type?: string;
    downloadUrl?: string;
    isExternal?: boolean;
}

export interface Lesson {
    id: string;
    title: string;
    url: string;
    index?: number;
    contentHtml?: string;
    videoLink?: string;
    resources?: Resource[];
}

export interface Module {
    title: string;
    index: number;
    lessons: Lesson[];
    root?: boolean;
}

export interface ClassroomResult {
    groupName: string;
    courseName: string;
    courseImageUrl?: string;
    modules: Module[];
}

export interface CourseListItem {
    id?: string;
    name?: string;
    title: string;
    url: string;
    key: string;
    numModules?: number;
    coverImageUrl?: string;
    hasAccess?: boolean;
    privacy?: number;
    updatedAt?: string;
}

export interface CourseLibraryResult {
    groupName: string;
    classroomUrl: string;
    courses: CourseListItem[];
}

/**
 * A single downloadable video found somewhere in a community post/thread:
 * either the post itself or one of its (nested) comments.
 */
export interface ThreadVideo {
    /** 1-based position in the thread, used for selection and file naming. */
    index: number;
    source: 'post' | 'comment';
    /** Full comment id (source === 'comment' only). */
    commentId?: string;
    /** First 8 chars of the comment id — matches the `?p=` permalink param. */
    commentShortId?: string;
    /** Display name of whoever posted it, e.g. "Louis Dowdeswell". */
    author: string;
    /** Skool handle, e.g. "louis-dowdeswell-3034". */
    authorHandle: string;
    /** Best available label (video title, else a snippet of the text). */
    title: string;
    kind: 'native' | 'external';
    /** 'skool' for native, otherwise 'loom' | 'vimeo' | 'youtube' | 'wistia' | 'external'. */
    provider: string;
    /** Native Skool/Mux video id (kind === 'native'). */
    nativeVideoId?: string;
    /** Present when the page already embedded a signed playback token. */
    playbackId?: string;
    playbackToken?: string;
    /** Direct share/embed URL for external providers (kind === 'external'). */
    externalUrl?: string;
    durationMs?: number;
    thumbnailUrl?: string;
    /** Short snippet of the surrounding post/comment text, for context. */
    contentSnippet?: string;
}

/** One node (the post, or a comment) in the thread hierarchy. */
export interface ThreadNode {
    kind: 'post' | 'comment';
    id: string;
    /** First 8 chars of the id — matches the `?p=` permalink param. */
    shortId: string;
    author: string;
    authorHandle: string;
    snippet: string;
    createdAt?: string;
    /** Posted by the currently logged-in user. */
    isCurrentUser: boolean;
    /** Posted by the community owner (e.g. the coach giving feedback). */
    isOwner: boolean;
    /** `ThreadVideo.index` values for videos attached directly to this node. */
    videoIndexes: number[];
    children: ThreadNode[];
}

export interface PostResult {
    groupName: string;
    url: string;
    postId: string;
    groupId: string;
    postSlug: string;
    postTitle: string;
    postContentHtml: string;
    /** `?p=` value from the input URL, if any — used to pre-select a comment video. */
    preselectShortId?: string;
    videos: ThreadVideo[];
    /** The post + comments as a tree, for hierarchical selection UIs. */
    threadTree: ThreadNode;
    /**
     * Best guess(es) at "the video you actually want": an owner's reply carrying
     * a video, sitting directly under the current user's post/comment — or, if
     * the URL had `?p=`, the video(s) on that comment. Empty when unsure.
     */
    suggestedVideoIndexes: number[];
}

function providerFromUrl(url: string): string {
    if (/loom\.com/i.test(url)) return 'loom';
    if (/vimeo\.com/i.test(url)) return 'vimeo';
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/wistia\.com|wi\.st/i.test(url)) return 'wistia';
    return 'external';
}

function parseJsonArray(raw: unknown): any[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || raw.trim() === '') return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Skool stores text with escaped punctuation and `[@Name](obj://user/id)` mentions. */
function cleanSkoolText(raw: string): string {
    return String(raw || '')
        .replace(/\[@([^\]]+)\]\(obj:\/\/user\/[^)]+\)/g, '@$1')
        .replace(/\\([()[\]*_~`>#+\-.!])/g, '$1');
}

function textSnippet(raw: string, max = 70): string {
    const clean = cleanSkoolText(raw).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function skoolTextToHtml(raw: string): string {
    const escape = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return cleanSkoolText(raw)
        .split(/\n{2,}/)
        .map((para) => `<p>${escape(para).replace(/\n/g, '<br/>')}</p>`)
        .join('');
}

function resolveClassroomRootUrl(inputUrl: string) {
    const urlObj = new URL(inputUrl);
    const segments = urlObj.pathname.split('/').filter(Boolean);
    const classroomIndex = segments.indexOf('classroom');
    if (classroomIndex === -1) {
        urlObj.search = '';
        urlObj.hash = '';
        return urlObj.toString();
    }
    const baseSegments = segments.slice(0, classroomIndex + 1);
    urlObj.pathname = `/${baseSegments.join('/')}`;
    urlObj.search = '';
    urlObj.hash = '';
    return urlObj.toString();
}

export class Scraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private logger: Logger;

    constructor(logger: Logger = createConsoleLogger()) {
        this.logger = logger;
    }

    async init() {
        this.browser = await chromium.launch({ headless: true });
        if (fs.existsSync(STORAGE_STATE_PATH)) {
            this.context = await this.browser.newContext({ storageState: STORAGE_STATE_PATH });
        } else {
            this.context = await this.browser.newContext();
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }

    async parseClassroom(url: string): Promise<ClassroomResult> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        // Ensure we are using a clean classroom URL without query params for structure extraction
        const cleanUrl = url.split('?')[0]!;
        this.logger.info(`Navigating to ${cleanUrl}...`);
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        await page.close();

        if (!nextData) throw new Error('Could not find __NEXT_DATA__ on classroom page');

        const pageProps = nextData.props?.pageProps || {};
        const courseData = pageProps.course;

        if (!courseData || !courseData.children) {
            this.logger.debug(`DEBUG: course metadata: ${JSON.stringify(courseData?.course?.metadata ?? {})}`);
            throw new Error('Course structure not found in __NEXT_DATA__');
        }

        // Extract Group (Community) Name
        const groupData = pageProps.currentGroup || {};
        const groupName = groupData.metadata?.name || groupData.name || 'Unknown Group';

        // Extract Course Name
        let courseName = 'Unknown Course';
        if (courseData.metadata?.title) {
            courseName = courseData.metadata.title;
        } else if (courseData.course?.metadata?.title) {
            courseName = courseData.course.metadata.title;
        } else {
            // Fallback: match current URL segment with allCourses/renderData.allCourses
            const urlParts = cleanUrl.split('/');
            const urlCourseHandle = urlParts[urlParts.length - 1]; // e.g. "767876d4"
            const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];
            const foundCourse = allCourses.find((c: any) => c.name === urlCourseHandle);
            if (foundCourse?.metadata?.title) {
                courseName = foundCourse.metadata.title;
            }
        }

        // Extract Course Image
        let courseImageUrl: string | undefined =
            courseData.metadata?.coverImage ||
            courseData.metadata?.image ||
            courseData.metadata?.coverSmallUrl ||
            courseData.course?.metadata?.coverImage ||
            courseData.course?.metadata?.image ||
            courseData.course?.metadata?.coverSmallUrl;

        if (!courseImageUrl) {
            const urlParts = cleanUrl.split('/');
            const urlCourseHandle = urlParts[urlParts.length - 1];
            const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];
            const foundCourse = allCourses.find((c: any) => c.name === urlCourseHandle || c.id === courseData?.id);
            courseImageUrl =
                foundCourse?.metadata?.coverImage ||
                foundCourse?.metadata?.image ||
                foundCourse?.metadata?.coverSmallUrl;
        }

        this.logger.info(`🎓 Course detected: ${courseName}`);

        // Skool Hierarchy:
        // Children can be sets (modules) or standalone lessons.
        const modules: Module[] = [];
        let rootModule: Module | null = null;

        const childNodes = Array.isArray(courseData.children) ? courseData.children : [];
        childNodes.forEach((node: any) => {
            if (node?.children && node.children.length > 0) {
                const setInfo = node.course || {};
                const setTitle = setInfo.metadata?.title || setInfo.name || 'Untitled Section';

                const lessons: Lesson[] = (node.children || []).map((mod: any, lIdx: number) => {
                    const modInfo = mod.course || {};
                    return {
                        id: modInfo.id,
                        title: modInfo.metadata?.title || modInfo.name || 'Untitled Lesson',
                        url: `${cleanUrl}?md=${modInfo.id}`,
                        index: lIdx + 1
                    };
                }).filter((l: Lesson) => l.id);

                modules.push({
                    title: setTitle,
                    index: modules.length + 1,
                    lessons
                });
                return;
            }

            const lessonInfo = node?.course || {};
            if (lessonInfo?.id) {
                if (!rootModule) {
                    rootModule = {
                        title: 'Lessons',
                        index: modules.length + 1,
                        lessons: [],
                        root: true
                    };
                    modules.push(rootModule);
                }

                rootModule.lessons.push({
                    id: lessonInfo.id,
                    title: lessonInfo.metadata?.title || lessonInfo.name || 'Untitled Lesson',
                    url: `${cleanUrl}?md=${lessonInfo.id}`,
                    index: rootModule.lessons.length + 1
                });
            }
        });

        return {
            groupName,
            courseName,
            courseImageUrl,
            modules: modules.filter(m => m.lessons.length > 0)
        };
    }

    async parseCourseLibrary(url: string): Promise<CourseLibraryResult> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        const classroomUrl = resolveClassroomRootUrl(url);
        this.logger.info(`Navigating to ${classroomUrl}...`);
        await page.goto(classroomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        await page.close();

        if (!nextData) throw new Error('Could not find __NEXT_DATA__ on classroom page');

        const pageProps = nextData.props?.pageProps || {};
        const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];

        if (!Array.isArray(allCourses) || allCourses.length === 0) {
            throw new Error('No courses found in classroom __NEXT_DATA__.');
        }

        const groupData = pageProps.currentGroup || {};
        const groupName =
            groupData.metadata?.displayName ||
            groupData.metadata?.name ||
            groupData.name ||
            'Unknown Group';

        const baseUrl = classroomUrl.replace(/\/$/, '');

        const courses: CourseListItem[] = allCourses.map((course: any, index: number) => {
            const metadata = course.metadata || {};
            const courseSlug = course.name || course.id;
            const title = metadata.title || course.name || course.id || `Course ${index + 1}`;
            const url = courseSlug ? `${baseUrl}/${courseSlug}` : baseUrl;
            const hasAccess =
                metadata.hasAccess === 1 ? true : metadata.hasAccess === 0 ? false : undefined;

            return {
                id: course.id,
                name: course.name,
                title,
                url,
                key: course.id || course.name || url,
                numModules: metadata.numModules,
                coverImageUrl: metadata.coverImage || metadata.coverSmallUrl || metadata.image,
                hasAccess,
                privacy: metadata.privacy,
                updatedAt: course.updatedAt
            };
        }).filter(course => course.url !== baseUrl);

        if (courses.length === 0) {
            throw new Error('No valid courses found in classroom listing.');
        }

        return {
            groupName,
            classroomUrl,
            courses
        };
    }

    async extractLessonData(url: string): Promise<Lesson> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        if (!nextData) throw new Error(`Could not find __NEXT_DATA__ for lesson at ${url}`);

        const pageProps = nextData.props?.pageProps || {};
        const urlObj = new URL(url);
        const md = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');

        let foundLesson: any = null;

        const findInTree = (node: any) => {
            if (node.course?.id === md) {
                foundLesson = node.course;
                return;
            }
            if (node.children) {
                for (const child of node.children) {
                    findInTree(child);
                    if (foundLesson) return;
                }
            }
        };

        if (pageProps.course) {
            findInTree(pageProps.course);
        }

        if (!foundLesson) {
            foundLesson = pageProps.lesson || pageProps.course?.course;
        }

        const metadata = foundLesson?.metadata || {};

        // Handle native videoId vs videoLink
        let vLink = metadata.videoLink || foundLesson?.video?.url || '';

        // Native Skool Player Handling (Mux)
        if (!vLink && metadata.videoId) {
            this.logger.info(`    ℹ️ Native videoId found: ${metadata.videoId}.`);
            const fallbackVideos = [pageProps.video, pageProps.course?.video].filter(Boolean);
            vLink = await this.captureNativeVideoLink(page, metadata.videoId, fallbackVideos);
        }

        // Resource extraction
        let resources: Resource[] = [];
        try {
            // 1. Try to extract from metadata (standard native files)
            const rawResources = metadata.resources || foundLesson?.resources || '[]';
            if (typeof rawResources === 'string') {
                resources = JSON.parse(rawResources);
            } else if (Array.isArray(rawResources)) {
                resources = rawResources;
            }

            // Normalize metadata resources (some have .link instead of .downloadUrl)
            resources = resources.map((r: any) => {
                if (r.link && !r.downloadUrl) {
                    return {
                        ...r,
                        downloadUrl: r.link,
                        isExternal: true
                    };
                }
                return r;
            });

        } catch (e) {
            this.logger.warn(`    ⚠️ Failed to parse metadata resources: ${String(e)}`);
        }

        // 2. Scrape from DOM to catch external links and any native missing from metadata
        try {
            const domResources = await page.evaluate(() => {
                const wrappers = Array.from(document.querySelectorAll('div[class*="ResourceWrapper"]'));
                return wrappers.map(w => {
                    const anchor = w.querySelector('a');
                    const labelSpan = w.querySelector('span[class*="ResourceLabel"]');
                    const title = labelSpan ? labelSpan.textContent?.trim() : 'Untitled Resource';
                    
                    const url = anchor ? anchor.href : null;
                    // If it has an anchor and it's not a skool download link, it's external
                    const isExternal = !!(url && !url.includes('api2.skool.com') && !url.includes('/files/'));

                    return { title, url, isExternal };
                });
            });

            // Merge DOM resources into the metadata resources
            for (const domRes of domResources) {
                const exists = resources.some(r => r.title === domRes.title);
                if (!exists && domRes.title) {
                    if (domRes.isExternal && domRes.url) {
                        resources.push({
                            title: domRes.title,
                            downloadUrl: domRes.url,
                            isExternal: true,
                            file_name: domRes.title
                        });
                    } else {
                        // If it's native but wasn't in metadata, it might be a link-style resource 
                        // that still points to a skool file.
                        if (domRes.url) {
                            resources.push({
                                title: domRes.title,
                                downloadUrl: domRes.url,
                                file_name: domRes.title
                            });
                        }
                    }
                }
            }
        } catch (err) {
            this.logger.warn(`    ⚠️ DOM-based resource scraping failed: ${String(err)}`);
        }

        // Fetch download URLs for each native resource using direct API calls
        if (resources.length > 0) {
            this.logger.info(`    📥 Found ${resources.length} resources. Fetching download URLs...`);

            for (const res of resources) {
                // Skip if it's already an external link or already has a download URL
                if (res.isExternal || (res.downloadUrl && res.downloadUrl.startsWith('http')) || !res.file_id) {
                    continue;
                }

                try {
                    this.logger.info(`      🔗 Requesting download URL for "${res.title}"...`);
                    const response = await page.evaluate(async (fileId: string) => {
                        const apiUrl = `https://api2.skool.com/files/${fileId}/download-url?expire=28800`;
                        try {
                            const resp = await fetch(apiUrl, {
                                method: 'POST',
                                credentials: 'include'
                            });
                            if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
                            const text = await resp.text();
                            return { success: true, url: text.trim() };
                        } catch (e) {
                            return { success: false, error: String(e) };
                        }
                    }, res.file_id);

                    if (response.success && response.url) {
                        res.downloadUrl = response.url;
                        this.logger.info(`      ✅ Got download URL for "${res.title}"`);
                    } else {
                        this.logger.warn(`      ⚠️ Failed to get download URL for "${res.title}": ${response.error}`);
                    }
                } catch (err) {
                    this.logger.warn(`      ⚠️ Error fetching download URL for "${res.title}": ${String(err)}`);
                }
            }
        }

        await page.close();

        // Skool stores rich text as a stringified JSON array or primitive HTML
        let body = metadata.desc || foundLesson?.body || '';

        // If it looks like [v2][{"type"...}], it's TipTap/JSON format
        if (typeof body === 'string' && body.startsWith('[v2]')) {
            try {
                const jsonPart = body.substring(4);
                const nodes = JSON.parse(jsonPart);
                body = this.parseTipTap(nodes);
            } catch (e) {
                this.logger.error(`Failed to parse TipTap content: ${String(e)}`);
            }
        }

        return {
            id: md || foundLesson?.id || '',
            title: metadata.title || foundLesson?.name || '',
            url: url,
            contentHtml: body,
            videoLink: vLink,
            resources: resources
        };
    }

    /**
     * Resolves a signed HLS manifest URL for a native Skool (Mux) video on the
     * currently loaded page. Prefers a playback token already present in the
     * page state; falls back to clicking the player and sniffing the manifest.
     * Shared by `extractLessonData` (classroom) and `extractPostData` (community).
     */
    private async captureNativeVideoLink(
        page: Page,
        videoId: string,
        fallbackVideos: any[] = []
    ): Promise<string> {
        // 1. Direct reconstruction when a signed token is already in the page state.
        const known = fallbackVideos.find((v) => v && v.id === videoId);
        if (known?.playbackId && known?.playbackToken) {
            this.logger.info('    ℹ️ Using HLS URL reconstructed from page state.');
            return `https://stream.video.skool.com/${known.playbackId}.m3u8?token=${known.playbackToken}`;
        }

        // 2. Interaction fallback: click the player, then sniff the manifest.
        try {
            const playButtonSelector = 'div[class*="MuxThumbnailWrapper"]';
            const hasPlayButton = await page.evaluate(
                (sel) => !!document.querySelector(sel),
                playButtonSelector
            );
            if (!hasPlayButton) return '';

            this.logger.info('    🖱️ Clicking play button to initialize stream...');
            await page.click(playButtonSelector);

            let attempts = 0;
            while (attempts < 10) {
                const vLink = await page.evaluate(() => {
                    // 1. Check performance entries for m3u8
                    const entries = performance.getEntriesByType('resource')
                        .filter(e => e.name.includes('m3u8') && e.name.includes('token='));
                    if (entries.length > 0) return (entries[entries.length - 1] as PerformanceResourceTiming).name;

                    // 2. Search all shadow roots for a video element (BFS)
                    const stack: any[] = [document];
                    while (stack.length > 0) {
                        const root = stack.pop();
                        const video = root.querySelector('video');
                        if (video && video.src && video.src.includes('m3u8')) return video.src;

                        const elements = root.querySelectorAll('*');
                        for (let i = 0; i < elements.length; i++) {
                            if (elements[i].shadowRoot) {
                                stack.push(elements[i].shadowRoot);
                            }
                        }
                    }
                    return null;
                });

                if (vLink) return vLink;
                await page.waitForTimeout(1000);
                attempts++;
            }
        } catch (err) {
            this.logger.warn(`    ⚠️ Interaction-based extraction failed: ${String(err)}`);
        }
        return '';
    }

    /**
     * Loads a community post/thread and returns every downloadable video in it
     * (the post itself plus every nested comment). Comments are not in
     * `__NEXT_DATA__`; they come from an authenticated `api2.skool.com` call
     * made from the page context so the saved session cookies apply.
     */
    async extractPostData(url: string): Promise<PostResult> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        const urlObj = new URL(url);
        const preselectShortId = urlObj.searchParams.get('p') || undefined;
        const cleanUrl = `${urlObj.origin}${urlObj.pathname}`;

        // The comments feed is loaded by the page itself via api2.skool.com — that
        // request already carries the right auth/headers, so we capture its
        // response(s) rather than trying to replay the call ourselves.
        const commentResponses: any[] = [];
        page.on('response', async (res) => {
            if (!/api2\.skool\.com\/posts\/[^/]+\/comments/.test(res.url())) return;
            try {
                if ((res.headers()['content-type'] || '').includes('application/json')) {
                    commentResponses.push(await res.json());
                }
            } catch {
                /* ignore unreadable bodies */
            }
        });

        this.logger.info(`Navigating to ${cleanUrl}...`);
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Nudge the page to load lazily-rendered / "load more" comments.
        for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 2400);
            await page.waitForTimeout(1200);
        }
        await page.waitForTimeout(1500);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        if (!nextData) throw new Error(`Could not find __NEXT_DATA__ for post at ${url}`);

        const pageProps = nextData.props?.pageProps || {};
        const postTree = pageProps.postTree;
        if (!postTree?.post) {
            throw new Error('Post structure not found in __NEXT_DATA__ — is this a community post URL?');
        }

        const post = postTree.post;
        const postMeta = post.metadata || {};
        const groupData = pageProps.currentGroup || {};
        const groupName =
            groupData.metadata?.displayName ||
            groupData.metadata?.name ||
            groupData.name ||
            'Unknown Group';
        const postId: string = post.id;
        const groupId: string = post.groupId || groupData.id;
        const postTitle: string = postMeta.title || post.name || 'Untitled Post';
        const postAuthor =
            `${post.user?.firstName ?? ''} ${post.user?.lastName ?? ''}`.trim() ||
            post.user?.name ||
            'Unknown';

        const currentUserId: string | undefined = pageProps.self?.id || pageProps.currentUser?.id;
        let ownerId: string | undefined = groupData.metadata?.createdBy;
        try {
            const ownerObj = JSON.parse(groupData.metadata?.owner || '{}');
            ownerId = ownerObj?.id || ownerId;
        } catch {
            /* keep createdBy fallback */
        }
        const isBy = (userId: string | undefined, target: string | undefined) =>
            !!userId && !!target && userId === target;

        const videos: ThreadVideo[] = [];
        let counter = 1;

        const pushExternal = (
            meta: any,
            base: Omit<ThreadVideo, 'index' | 'kind' | 'provider' | 'externalUrl' | 'title'>,
            fallbackTitle: string
        ) => {
            const entries = parseJsonArray(meta.video_links_data ?? meta.videoLinksData);
            if (entries.length > 0) {
                for (const entry of entries) {
                    if (!entry?.url) continue;
                    videos.push({
                        ...base,
                        index: counter++,
                        kind: 'external',
                        provider: providerFromUrl(entry.url),
                        externalUrl: entry.url,
                        title: entry.title || fallbackTitle,
                        durationMs: entry.len_ms ?? entry.lenMs,
                        thumbnailUrl: entry.thumbnail
                    });
                }
                return;
            }
            const raw = String(meta.video_links ?? meta.videoLinks ?? '').split(/\s+/).filter(Boolean);
            for (const link of raw) {
                videos.push({
                    ...base,
                    index: counter++,
                    kind: 'external',
                    provider: providerFromUrl(link),
                    externalUrl: link,
                    title: fallbackTitle
                });
            }
        };

        // --- 1. The post's own video(s) ---
        const postVideoPool: any[] = Array.isArray(postTree.videos) ? postTree.videos : [];
        const postVideoIds = String(postMeta.videoIds || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        for (const vid of postVideoIds) {
            const match = postVideoPool.find((v) => v && v.id === vid);
            videos.push({
                index: counter++,
                source: 'post',
                author: postAuthor,
                authorHandle: post.user?.name || 'unknown',
                title: postTitle,
                kind: 'native',
                provider: 'skool',
                nativeVideoId: vid,
                playbackId: match?.playbackId,
                playbackToken: match?.playbackToken,
                durationMs: match?.duration,
                thumbnailUrl: postMeta.imagePreview,
                contentSnippet: textSnippet(postMeta.content)
            });
        }
        pushExternal(
            postMeta,
            {
                source: 'post',
                author: postAuthor,
                authorHandle: post.user?.name || 'unknown',
                contentSnippet: textSnippet(postMeta.content)
            },
            postTitle
        );

        const threadTree: ThreadNode = {
            kind: 'post',
            id: postId,
            shortId: String(postId).slice(0, 8),
            author: postAuthor,
            authorHandle: post.user?.name || 'unknown',
            snippet: textSnippet(postMeta.content, 140) || postTitle,
            createdAt: post.createdAt,
            isCurrentUser: isBy(currentUserId, post.userId || post.user?.id),
            isOwner: isBy(ownerId, post.userId || post.user?.id),
            videoIndexes: videos.map((v) => v.index),
            children: []
        };

        // --- 2. Comments (nested), captured from the page's own API responses ---
        const seenComments = new Set<string>();
        const walkComments = (apiNode: any, siblings: ThreadNode[]) => {
            const c = apiNode?.post;
            let childBucket = siblings;
            if (c && !seenComments.has(c.id)) {
                seenComments.add(c.id);
                const cMeta = c.metadata || {};
                const author =
                    `${c.user?.first_name ?? ''} ${c.user?.last_name ?? ''}`.trim() ||
                    c.user?.name ||
                    'Unknown';
                const base = {
                    source: 'comment' as const,
                    commentId: c.id,
                    commentShortId: String(c.id || '').slice(0, 8),
                    author,
                    authorHandle: c.user?.name || 'unknown',
                    contentSnippet: textSnippet(cMeta.content)
                };
                const fallbackTitle = textSnippet(cMeta.content) || `Comment by ${author}`;
                const startIdx = videos.length;

                const cVideoIds = String(cMeta.video_ids || '')
                    .split(',')
                    .map((s: string) => s.trim())
                    .filter(Boolean);
                for (const vid of cVideoIds) {
                    videos.push({
                        ...base,
                        index: counter++,
                        title: fallbackTitle,
                        kind: 'native',
                        provider: 'skool',
                        nativeVideoId: vid
                    });
                }
                pushExternal(cMeta, base, fallbackTitle);

                const commentUserId = c.user_id || c.user?.id;
                const node: ThreadNode = {
                    kind: 'comment',
                    id: c.id,
                    shortId: base.commentShortId,
                    author,
                    authorHandle: base.authorHandle,
                    snippet: textSnippet(cMeta.content, 140) || `Comment by ${author}`,
                    createdAt: c.created_at,
                    isCurrentUser: isBy(currentUserId, commentUserId),
                    isOwner: isBy(ownerId, commentUserId),
                    videoIndexes: videos.slice(startIdx).map((v) => v.index),
                    children: []
                };
                siblings.push(node);
                childBucket = node.children;
            }
            for (const child of apiNode?.children || []) walkComments(child, childBucket);
        };

        if (commentResponses.length === 0) {
            this.logger.warn('    ⚠️ No comments feed was captured — only post-level videos found.');
        }
        for (const payload of commentResponses) {
            if (payload?.post_tree) walkComments(payload.post_tree, threadTree.children);
            if (payload?.pinned_post_tree?.post) walkComments(payload.pinned_post_tree, threadTree.children);
        }

        await page.close();

        // --- 3. Best-guess selection ---
        // Anchor = the comment the URL points at (`?p=`), otherwise the current
        // user's own post/comments in this thread.
        const anchors: ThreadNode[] = [];
        const collectAnchors = (node: ThreadNode) => {
            if (preselectShortId ? node.shortId === preselectShortId : node.isCurrentUser) {
                anchors.push(node);
            }
            node.children.forEach(collectAnchors);
        };
        collectAnchors(threadTree);

        // Inside an anchor's subtree, an owner's comment carrying a video is
        // almost certainly the feedback you're after.
        const ownerFeedback: number[] = [];
        const scanSubtree = (node: ThreadNode, insideAnchor: boolean) => {
            const nowInside = insideAnchor || anchors.includes(node);
            for (const child of node.children) {
                if (nowInside && child.isOwner && !child.isCurrentUser && child.videoIndexes.length > 0) {
                    ownerFeedback.push(...child.videoIndexes);
                }
                scanSubtree(child, nowInside);
            }
        };
        scanSubtree(threadTree, false);

        let suggestedVideoIndexes: number[] = [];
        if (ownerFeedback.length > 0) {
            suggestedVideoIndexes = [...new Set(ownerFeedback)];
        } else if (preselectShortId) {
            // The URL points straight at someone else's video comment.
            suggestedVideoIndexes = anchors
                .filter((n) => !n.isCurrentUser)
                .flatMap((n) => n.videoIndexes);
        }

        return {
            groupName,
            url: cleanUrl,
            postId,
            groupId,
            postSlug: post.name || postId,
            postTitle,
            postContentHtml: skoolTextToHtml(postMeta.content || ''),
            preselectShortId,
            videos,
            threadTree,
            suggestedVideoIndexes
        };
    }

    /**
     * Opens a post page (optionally focused on a specific comment via `?p=`)
     * and resolves a signed HLS URL for a native video whose playback token was
     * not embedded in the initial page state (e.g. native videos in comments).
     */
    async captureNativePostVideoLink(
        postUrl: string,
        nativeVideoId: string,
        commentShortId?: string
    ): Promise<string> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();
        try {
            const urlObj = new URL(postUrl);
            if (commentShortId) urlObj.searchParams.set('p', commentShortId);
            await page.goto(urlObj.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(4000);

            const embeddedVideos = await page.evaluate(() => {
                const script = document.getElementById('__NEXT_DATA__');
                if (!script) return [];
                try {
                    const data = JSON.parse(script.innerText);
                    return data.props?.pageProps?.postTree?.videos || [];
                } catch {
                    return [];
                }
            });

            return await this.captureNativeVideoLink(page, nativeVideoId, embeddedVideos);
        } finally {
            await page.close();
        }
    }



    private parseTipTap(nodes: any[]): string {
        return nodes.map(node => {
            if (node.type === 'paragraph') {
                return `<p>${this.parseTipTapContent(node.content)}</p>`;
            }
            if (node.type === 'hardBreak') {
                return '<br/>';
            }
            if (node.type === 'bulletList') {
                return `<ul>${this.parseTipTap(node.content)}</ul>`;
            }
            if (node.type === 'orderedList') {
                return `<ol>${this.parseTipTap(node.content)}</ol>`;
            }
            if (node.type === 'listItem') {
                return `<li>${this.parseTipTap(node.content)}</li>`;
            }
            if (node.type === 'heading') {
                const level = node.attrs?.level || 2;
                return `<h${level}>${this.parseTipTapContent(node.content)}</h${level}>`;
            }
            if (node.type === 'image' || node.type === 'image-block' || (node.attrs && node.attrs.src)) {
                 const src = node.attrs.src || node.attrs.url || node.attrs.originalSrc;
                 const alt = node.attrs.alt || '';
                 if (src) {
                    return `<img src="${src}" alt="${alt}" />`;
                 }
            }
            if (node.type === 'blockquote') {
                 return `<blockquote>${this.parseTipTap(node.content)}</blockquote>`;
            }

            // Fallback for nested content in unknown blocks
            if (node.content) {
                return `<div>${this.parseTipTap(node.content)}</div>`;
            }

            return '';
        }).join('');
    }

    private parseTipTapContent(content: any[]): string {
        if (!content) return '';
        return content.map(item => {
            if (item.type === 'text') {
                let text = item.text;
                if (item.marks) {
                    item.marks.forEach((mark: any) => {
                        if (mark.type === 'bold') text = `<b>${text}</b>`;
                        if (mark.type === 'link') text = `<a href="${mark.attrs.href}">${text}</a>`;
                    });
                }
                return text;
            }
            if (item.type === 'hardBreak') return '<br/>';
            return '';
        }).join('');
    }
}
