/**
 * 离线缓存（m3u8 → 本地分片）。
 *
 * ## 为什么自己实现而不用系统下载
 *
 * 采集源的片源是 **m3u8 + 大量 .ts 分片**，不是单一 MP4：
 * 直接下载 m3u8 只能拿到一份索引，离线时毫无用处。
 * 因此必须：解析索引 → 逐个下载分片 → 落盘 → 播放时改读本地。
 *
 * ## 分片与本地文件的对应关系
 *
 * 不用维护「URL → 文件名」映射表（上千条会让存储爆掉），
 * 而是用 **URL 的哈希做文件名**：播放时对请求的 URL 现算哈希即可定位本地文件。
 *
 * ## 平台支持
 *
 * 仅 App 端。H5 端存储配额（约 5MB）装不下一部影片，故直接不支持。
 */

import { createLogger } from '@/utils/logger';
import { unwrapUrl } from '@/utils/url';

const log = createLogger('download');

/** 缓存列表的存储键。 */
const LIST_KEY = 'yinghua_cache_list';
/** 每集 m3u8 文本单独存储，避免列表键膨胀。 */
const MANIFEST_PREFIX = 'yinghua_cache_m3u8_';
/** App 端沙箱内的缓存目录名。 */
export const CACHE_DIR = 'yinghua_cache';

/** 同时在下的分片数。过高会被源站限流，过低则慢。 */
const CONCURRENCY = 3;

/**
 * 进度落盘的最小间隔（毫秒）。
 *
 * 单集分片数可达两千以上（实测），逐片同步写存储会拖慢下载并卡 UI。
 * 取 600ms：既让界面进度条看起来连续（约每秒刷新 1.7 次），
 * 又把写存储次数从「分片数」压到「秒数 × 1.7」。
 */
const PROGRESS_FLUSH_MS = 600;

/**
 * 单个分片的下载超时（毫秒）。
 *
 * 实测平均分片约 0.69MB，正常网络下远快于此值；
 * 取 60 秒是给弱网留足余量，同时避免挂死的请求拖垮整集任务。
 */
const DOWNLOAD_TIMEOUT = 60000;

/** 单集缓存状态。 */
export type CacheStatus = 'pending' | 'downloading' | 'done' | 'error';

/** 缓存条目（不含 m3u8 正文，正文单独存）。 */
export interface CacheItem {
    key: string;
    vodId: number;
    vodName: string;
    vodPic: string;
    collectionId: number;
    collectionTitle: string;
    /** 影片时长（秒），由 EXTINF 累加得出 */
    duration: number;
    /** 分片总数 */
    total: number;
    /** 已完成分片数 */
    done: number;
    /** 已落盘字节数 */
    bytes: number;
    status: CacheStatus;
    createdAt: number;
    updatedAt: number;
    error?: string;
}

/** 缓存唯一键。 */
export function cacheKey(vodId: number, collectionId: number): string {
    return `${vodId}_${collectionId}`;
}

/** 当前平台是否支持离线缓存。 */
export function canCache(): boolean {
    // #ifdef APP-PLUS
    return true;
    // #endif

    // #ifndef APP-PLUS
    return false;
    // #endif
}

/**
 * URL → 本地文件名的哈希（djb2）。
 *
 * 同一部影片的分片 URL 前缀相同、尾部序号不同，哈希后能稳定区分。
 */
export function hashUrl(url: string): string {
    let h = 5381;
    for (let i = 0; i < url.length; i++) {
        h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** 把相对地址补成绝对地址。 */
function absolutize(uri: string, base: string): string {
    if (/^https?:\/\//i.test(uri)) return uri;
    try {
        return new URL(uri, base).toString();
    } catch {
        // base 非法时退化为字符串拼接
        const dir = base.slice(0, base.lastIndexOf('/') + 1);
        return dir + uri;
    }
}

/**
 * URL → 本地文件名。
 *
 * 规则必须与播放器读取时**完全一致**（播放器通过注入的同一函数取名）：
 * 用 URL 哈希 + 扩展名。扩展名按内容区分，不按原 URL ——
 * 因为 fMP4 分片的 URL 常常没有 .mp4 后缀，统一用 .ts 也无妨，
 * 但显式区分更利于排查。
 */
export function localFileNameOf(url: string): string {
    if (!url) return '';
    const isMp4 = /\.mp4(\?|$)/i.test(url) || /\.m4s(\?|$)/i.test(url);
    return `${hashUrl(url)}${isMp4 ? '.mp4' : '.ts'}`;
}

/**
 * 把 m3u8 里的相对地址改写成绝对地址后再保存。
 *
 * 为什么必须改写：离线播放时索引由内存提供、没有真实 URL 作基准，
 * 若保留相对路径（如 `seg1.ts`），播放器无法算出对应的原始 URL，
 * 也就无法用哈希命中本地文件，结果整集黑屏。
 */
export function rewriteManifest(text: string, baseUrl: string): string {
    return text
        .split('\n')
        .map(raw => {
            const line = raw.trim();
            if (!line) return raw;

            // 标签行：把 KEY / MAP 里的 URI 也补成绝对地址
            if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-MAP:')) {
                const m = line.match(/URI="([^"]+)"/);
                if (m) return line.replace(m[1], absolutize(m[1], baseUrl));
                return raw;
            }
            if (line.startsWith('#')) return raw;

            // 资源行
            return absolutize(line, baseUrl);
        })
        .join('\n');
}

/** m3u8 解析结果。 */
export interface ParsedManifest {
    /** 分片绝对地址，按出现顺序 */
    segments: string[];
    /** 密钥地址（AES-128 加密时存在） */
    keys: string[];
    /** 初始化段地址（fMP4 时存在） */
    maps: string[];
    /** 总时长（秒） */
    duration: number;
}

/**
 * 解析 m3u8 索引。
 *
 * ⚠️ 分片**必须去重**。
 *
 * 实测本项目的片源会把同一段广告（`/video/adjump/...`）在索引里
 * 重复列出多次，一共 2142 行里就有 9 组重复。
 * 不去重会踩两个坑：
 *   1. 本地文件名由 URL 哈希决定，重复的 URL 映射到**同一个文件**，
 *      于是并发池会同时下载并写同一个目标文件（copyInto 是先删后拷），
 *      两个 worker 相互删对方的产物 → 必然有一个报错，
 *      整集因此被判成「N 个分片下载失败」而无法离线播放。
 *   2. `total` 被重复计数，进度分母虚大、百分比永远到不了 100%。
 *
 * 去重后每个资源只下一次，进度与文件都正确。
 */
export function parseManifest(text: string, baseUrl: string): ParsedManifest {
    const segments: string[] = [];
    const keys: string[] = [];
    const maps: string[] = [];
    const seen = new Set<string>();
    let duration = 0;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            const v = Number.parseFloat(line.slice(8));
            if (!Number.isNaN(v)) duration += v;
            continue;
        }
        if (line.startsWith('#EXT-X-KEY:')) {
            /*
             * 只收真正带 URI 的密钥。
             *
             * `METHOD=NONE` 表示这一段不加密，没有 URI；
             * 而部分编码器会在**每个分片前重复输出同一个 KEY 行**，
             * 不去重的话同一个密钥会被下载多次、`total` 也被重复计数，
             * 进度百分比随之失真（分母虚大、永远到不了 100%）。
             */
            const m = line.match(/URI="([^"]+)"/);
            if (m) {
                const u = absolutize(m[1], baseUrl);
                if (!keys.includes(u)) keys.push(u);
            }
            continue;
        }
        if (line.startsWith('#EXT-X-MAP:')) {
            const m = line.match(/URI="([^"]+)"/);
            if (m) {
                const u = absolutize(m[1], baseUrl);
                if (!maps.includes(u)) maps.push(u);
            }
            continue;
        }
        // 其它 # 开头的都是标签，非 URI 行
        if (line.startsWith('#')) continue;

        const u = absolutize(line, baseUrl);
        if (seen.has(u)) continue;
        seen.add(u);
        segments.push(u);
    }

    return { segments, keys, maps, duration };
}

/* ------------------------------------------------------------------
 * 本地文件读写（App 端 plus.io）
 * ---------------------------------------------------------------- */

/** 解析本地路径为 Entry。 */
function resolveEntry(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
        // #ifdef APP-PLUS
        plus.io.resolveLocalFileSystemURL(path, resolve, reject);
        // #endif

        // #ifndef APP-PLUS
        reject(new Error('当前平台不支持本地文件'));
        // #endif
    });
}

/** 取（必要时创建）缓存子目录 `_doc/yinghua_cache/<key>/`。 */
function ensureDir(key: string): Promise<any> {
    return resolveEntry(`_doc/${CACHE_DIR}/`).then(
        (cacheDir: any) =>
            new Promise<any>((resolve, reject) => {
                cacheDir.getDirectory(key, { create: true }, resolve, reject);
            }),
        // 缓存根目录不存在则先创建
        () =>
            resolveEntry('_doc/').then(
                (docDir: any) =>
                    new Promise<any>((resolve, reject) => {
                        docDir.getDirectory(
                            CACHE_DIR,
                            { create: true },
                            (cacheDir: any) => {
                                cacheDir.getDirectory(key, { create: true }, resolve, reject);
                            },
                            reject
                        );
                    })
            )
    );
}

/**
 * 把临时文件复制进缓存目录，命名为 `<name>`。
 *
 * ⚠️ 覆盖写：`copyTo` 在目标已存在时**会失败**（不同机型报错不一，
 * 有的是「文件已存在」有的是静默不覆盖）。而以下场景必然命中已存在：
 *   · 重试一次失败的分片（downloadWithRetry 的第二次尝试）
 *   · 取消后重新开始缓存同一集（注释里说「同名文件会被覆盖」，实际不会）
 * 故这里先删除同名目标文件，再复制 —— 保证「重试即覆盖」成立。
 *
 * 删除失败（文件本就不存在是最常见的情况）直接忽略，不影响后续复制。
 */
function copyInto(dirEntry: any, tempPath: string, name: string): Promise<number> {
    return resolveEntry(tempPath).then(
        (srcEntry: any) =>
            new Promise<number>((resolve, reject) => {
                const doCopy = () => {
                    srcEntry.copyTo(
                        dirEntry,
                        name,
                        (entry: any) => {
                            // 顺带取文件大小，用于统计已用空间
                            entry.getMetadata(
                                (meta: any) => resolve(Number(meta.size) || 0),
                                () => resolve(0)
                            );
                        },
                        reject
                    );
                };

                // 先尝试删掉同名旧文件（不存在时回调失败，忽略即可）
                dirEntry.getFile(
                    name,
                    { create: false },
                    (old: any) => {
                        old.remove(doCopy, doCopy);
                    },
                    doCopy
                );
            })
    );
}

/**
 * 读取本地文件为纯文本。
 *
 * 注意 plus.io 的 FileReader 是 **W3C 事件回调风格**：
 * 读取结果在 `reader.result`，且要监听 `onload`；
 * 它没有「回调入参」写法（容易凭印象写错）。
 */
export function readLocalText(path: string): Promise<string> {
    return resolveEntry(path).then(
        (entry: any) =>
            new Promise<string>((resolve, reject) => {
                entry.file(
                    (file: any) => {
                        const reader = new plus.io.FileReader();
                        reader.onload = (e: any) => resolve(String(e?.target?.result ?? reader.result ?? ''));
                        reader.onerror = () => reject(new Error('读取本地文件失败'));
                        reader.readAsText(file);
                    },
                    reject
                );
            })
    );
}

/**
 * 读取本地文件为 ArrayBuffer（供离线分片加载使用）。
 *
 * 走 readAsDataURL 拿 base64 再自行解码：
 * plus.io 的 FileReader 只提供 Text / DataURL 两种读法，没有 readAsArrayBuffer。
 */
export function readLocalBuffer(path: string): Promise<ArrayBuffer | null> {
    return resolveEntry(path).then(
        (entry: any) =>
            new Promise<ArrayBuffer | null>(resolve => {
                entry.file(
                    (file: any) => {
                        try {
                            const reader = new plus.io.FileReader();
                            reader.onload = (e: any) =>
                                resolve(dataUrlToBuffer(String(e?.target?.result ?? reader.result ?? '')));
                            reader.onerror = () => resolve(null);
                            reader.readAsDataURL(file);
                        } catch {
                            resolve(null);
                        }
                    },
                    () => resolve(null)
                );
            }),
        () => Promise.resolve(null)
    );
}

/** dataURL(base64) → ArrayBuffer。 */
function dataUrlToBuffer(dataUrl: string): ArrayBuffer | null {
    try {
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        const bin = atob(dataUrl.slice(comma + 1));
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    } catch {
        return null;
    }
}

/** 删除整个缓存目录。 */
export function removeLocalDir(key: string): Promise<void> {
    return resolveEntry(`_doc/${CACHE_DIR}/${key}/`).then(
        (dirEntry: any) =>
            new Promise<void>(resolve => {
                dirEntry.removeRecursively(() => resolve(), () => resolve());
            }),
        () => Promise.resolve()
    );
}

/* ------------------------------------------------------------------
 * 元数据（storage）
 * ---------------------------------------------------------------- */

/** 读取全部缓存条目（按创建时间倒序）。 */
export function getCacheList(): CacheItem[] {
    try {
        const list = (uni.getStorageSync(LIST_KEY) as CacheItem[]) || [];
        return list.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
        return [];
    }
}

/** 取单条缓存记录。 */
export function getCacheItem(vodId: number, collectionId: number): CacheItem | null {
    return getCacheList().find(i => i.key === cacheKey(vodId, collectionId)) || null;
}

/** 某集是否已缓存完成（可离线播放）。 */
export function isCached(vodId: number, collectionId: number): boolean {
    const item = getCacheItem(vodId, collectionId);
    return !!item && item.status === 'done';
}

/** 写入/更新一条缓存记录。 */
function upsertItem(item: CacheItem) {
    try {
        const list = getCacheList().filter(i => i.key !== item.key);
        list.unshift(item);
        uni.setStorageSync(LIST_KEY, list);
    } catch (e) {
        log.warn('写入缓存记录失败', String(e));
    }
}

/** 读取某集缓存的 m3u8 正文。 */
export function getCachedManifest(vodId: number, collectionId: number): string {
    try {
        return (uni.getStorageSync(`${MANIFEST_PREFIX}${cacheKey(vodId, collectionId)}`) as string) || '';
    } catch {
        return '';
    }
}

/** 取某集缓存所在的本机目录前缀。 */
export function cacheDirOf(key: string): string {
    return `_doc/${CACHE_DIR}/${key}/`;
}

/**
 * 删除某集缓存（文件 + 记录 + 索引）。
 *
 * ⚠️ 必须先取消正在进行的下载任务。
 *
 * 否则会出现「删了又回来」：删除只清了文件与记录，但下载任务还在跑，
 * 它下一次 persist() 会按内存里的 item 把记录**重新写回**列表，
 * 用户刷新后看到条目还在（点进去才发现文件已没了）。
 * 同时任务仍在往已删除的目录里写文件，会持续报错刷日志。
 */
export async function removeCache(key: string): Promise<void> {
    // 先停任务，并给它一点时间退出循环（避免边删边写）
    cancelDownload(key);
    if (running.has(key)) {
        await new Promise(r => setTimeout(r, 120));
    }

    await removeLocalDir(key);
    try {
        uni.removeStorageSync(`${MANIFEST_PREFIX}${key}`);
        uni.setStorageSync(LIST_KEY, getCacheList().filter(i => i.key !== key));
    } catch (e) {
        log.warn('删除缓存记录失败', String(e));
    }
}

/**
 * 清空全部缓存。
 *
 * 先统一取消所有在跑的任务再逐个删除 —— 理由同 removeCache，
 * 不先停会让清空操作和在跑任务互相打架（记录被写回、文件删不干净）。
 */
export async function clearAllCache(): Promise<void> {
    const list = getCacheList();
    for (const item of list) {
        cancelDownload(item.key);
    }
    // 等各任务退出循环后再动手删，避免「删到一半又被写入」
    if (running.size > 0) {
        await new Promise(r => setTimeout(r, 200));
    }

    for (const item of list) {
        await removeCache(item.key);
    }
    try {
        uni.setStorageSync(LIST_KEY, []);
    } catch {
        // 忽略
    }
}

/* ------------------------------------------------------------------
 * 下载流程
 * ---------------------------------------------------------------- */

/** 正在进行的任务，key → 取消标记。 */
const running = new Map<string, { cancelled: boolean }>();

/** 某集是否正在下载。 */
export function isDownloading(key: string): boolean {
    return running.has(key);
}

/** 取消某集的下载。 */
export function cancelDownload(key: string) {
    const task = running.get(key);
    if (task) task.cancelled = true;
}

/** 拉取 m3u8 文本。 */
function fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        uni.request({
            url,
            method: 'GET',
            dataType: 'text',
            timeout: 20000,
            success: res => {
                if (res.statusCode === 200 && typeof res.data === 'string') {
                    resolve(res.data);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            },
            fail: err => reject(new Error(`拉取索引失败：${JSON.stringify(err)}`))
        });
    });
}

/**
 * 下载单个资源到本地文件，返回落盘字节数。
 *
 * 自带超时兜底：`uni.downloadFile` 的 timeout 在部分 Android 机型上
 * 并不可靠，而本工程的片源单集动辄上千个分片 —— 只要有一个请求挂住
 * 不回调（既 success 也 fail 都不来），runPool 的 Promise 就永远不 settle，
 * 整个缓存任务卡在「缓存中…」且无法自行结束。
 *
 * 因此这里再包一层定时器：超时后主动 reject，让并发池继续推进。
 * 注意**只能 reject 一次**，故用 settled 标记防止重复决议。
 */
function downloadToFile(url: string, dirEntry: any, name: string): Promise<number> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };

        const timer = setTimeout(() => {
            finish(() => reject(new Error('下载超时')));
        }, DOWNLOAD_TIMEOUT);

        uni.downloadFile({
            url,
            timeout: DOWNLOAD_TIMEOUT,
            success: res => {
                if (res.statusCode !== 200 || !res.tempFilePath) {
                    finish(() => reject(new Error(`HTTP ${res.statusCode}`)));
                    return;
                }
                copyInto(dirEntry, res.tempFilePath, name).then(
                    n => finish(() => resolve(n)),
                    e => finish(() => reject(e as Error))
                );
            },
            fail: err => finish(() => reject(new Error(JSON.stringify(err))))
        });
    });
}

/**
 * 下载单个资源（含一次重试）。
 *
 * 源站会临时拒绝密集请求，重试能显著降低整集失败率。
 */
async function downloadWithRetry(url: string, dirEntry: any, name: string): Promise<number> {
    try {
        return await downloadToFile(url, dirEntry, name);
    } catch {
        await new Promise(r => setTimeout(r, 300));
        return downloadToFile(url, dirEntry, name);
    }
}

/** 并发池。 */
async function runPool<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>,
    shouldStop?: () => boolean
): Promise<void> {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            if (shouldStop && shouldStop()) return;
            const i = cursor++;
            if (i >= items.length) return;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

/** 开始缓存的入参。 */
export interface StartCacheOptions {
    vodId: number;
    vodName: string;
    vodPic: string;
    collectionId: number;
    collectionTitle: string;
    /** 该集的 m3u8 地址（未包装代理的原始地址） */
    m3u8Url: string;
    /** 进度回调（每次分片完成时触发） */
    onProgress?: (item: CacheItem) => void;
}

/**
 * 开始缓存一集。
 *
 * 流程：拉索引 → 解析分片 → 并发下载落盘 → 保存索引与记录。
 * 中途可 `cancelDownload(key)` 取消；已下载的分片保留，
 * 重新开始时同名文件会被覆盖，不影响正确性。
 */
export async function startCache(options: StartCacheOptions): Promise<CacheItem> {
    if (!canCache()) {
        throw new Error('当前平台不支持离线缓存');
    }

    const key = cacheKey(options.vodId, options.collectionId);
    if (running.has(key)) {
        throw new Error('该集正在缓存中');
    }
    const flag = { cancelled: false };
    running.set(key, flag);

    const item: CacheItem = {
        key,
        vodId: options.vodId,
        vodName: options.vodName,
        vodPic: options.vodPic,
        collectionId: options.collectionId,
        collectionTitle: options.collectionTitle,
        duration: 0,
        total: 0,
        done: 0,
        bytes: 0,
        status: 'downloading',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    upsertItem(item);

    /**
     * 进度落盘的节流器。
     *
     * 为什么必须节流：实测本项目的片源**单集可达 2142 个分片**
     * （约 1.4GB / 107 分钟）。原实现「每个分片完成都 upsertItem」，
     * 等于 2142 次「读全量列表 → 同步写存储」。
     * `uni.setStorageSync` 是**同步磁盘写**，在下载这种高频回调里
     * 会明显拖慢任务、并让 UI 频繁卡顿。
     *
     * 这里改为：进度照常累加（内存中的 item 始终准确），
     * 但落盘最多每 PROGRESS_FLUSH_MS 一次；收尾时再强制flush一次，
     * 保证最终状态一定写进去。
     */
    let lastFlush = 0;
    const persist = (force = false) => {
        const now = Date.now();
        if (!force && now - lastFlush < PROGRESS_FLUSH_MS) return;
        lastFlush = now;
        item.updatedAt = now;
        upsertItem(item);
        options.onProgress?.({ ...item });
    };

    try {
        // 1. 拉取并解析索引（走原始地址，不走 H5 代理）
        const rawUrl = unwrapUrl(options.m3u8Url);
        const text = await fetchText(rawUrl);
        // 关键：保存**改写为绝对地址**的索引，否则离线时无法由哈希命中本地分片
        const normalized = rewriteManifest(text, rawUrl);
        const parsed = parseManifest(normalized, rawUrl);

        if (parsed.segments.length === 0) {
            throw new Error('该片源没有可下载的分片');
        }

        item.total = parsed.segments.length + parsed.keys.length + parsed.maps.length;
        item.duration = Math.round(parsed.duration);
        // 分片总数是「必须立刻让界面看到」的信息（进度分母），故强制落盘
        persist(true);

        const dirEntry = await ensureDir(key);

        /*
         * 2. 密钥与初始化段。
         *
         * ⚠️ 文件名**必须**用 localFileNameOf（URL 哈希），不能自定义
         * `key_0.bin` / `init_0.mp4` 之类的好看名字 ——
         * 离线播放时 hls.js 会拿着索引里的原始 URL 来请求这两类资源，
         * 播放器的本地查找规则是「URL 哈希 + 扩展名」（见 yh-player 的
         * localFileNameOf），自定义名字永远命中不了。
         *
         * 后果很隐蔽：不加密的 TS 片源完全正常，因此平时测不出来；
         * 一旦遇到 AES-128 或 fMP4 片源，离线播放就必然黑屏 / 解密失败。
         * 这里统一走同一套命名规则，让播放器能按哈希找到。
         */
        const extras: Array<{ url: string; name: string }> = [
            ...parsed.keys.map(u => ({ url: u, name: localFileNameOf(u) })),
            ...parsed.maps.map(u => ({ url: u, name: localFileNameOf(u) }))
        ];
        let failed = 0;
        for (const ex of extras) {
            if (flag.cancelled) break;
            try {
                const n = await downloadWithRetry(ex.url, dirEntry, ex.name);
                item.bytes += n;
                item.done += 1;
            } catch (e) {
                // 失败不计入 done，否则百分比会虚高、也看不出完整性
                failed += 1;
                log.warn('附加资源下载失败', ex.url, String(e));
            }
            persist();
        }

        // 3. 分片：并发下载，文件名由 URL 哈希决定（播放时按同样规则定位）
        await runPool(
            parsed.segments,
            CONCURRENCY,
            async url => {
                const name = localFileNameOf(url);
                try {
                    /*
                     * ⚠️ 必须先 await 拿到结果，再同步累加。
                     *
                     * 不能写成 `item.bytes += await download(...)` ——
                     * 那个形式是「读 item.bytes → await → 写回」，
                     * 而 await 期间其它并发分片会同样读到**同一个旧值**，
                     * 各自加完再写回，互相覆盖。
                     *
                     * 实测（3 个分片、100+200+300 字节）：写成 += await 时
                     * 最终只记到 300，**丢失一半**。这里的分片动辄数千个，
                     * 丢失量会让「已用空间」远小于实际占用，
                     * 用户看到的体积是错的，也据此判断不出磁盘够不够。
                     */
                    const n = await downloadWithRetry(url, dirEntry, name);
                    item.bytes += n;
                    item.done += 1;
                } catch (e) {
                    failed += 1;
                    log.warn('分片下载失败', url, String(e));
                }
                persist();
            },
            () => flag.cancelled
        );

        // 4. 保存索引以便离线播放（存改写后的版本）
        uni.setStorageSync(`${MANIFEST_PREFIX}${key}`, normalized);

        if (flag.cancelled) {
            item.status = 'error';
            item.error = '已取消';
        } else if (failed > 0) {
            /*
             * 有分片失败就不算「可离线」：缺片会导致播放到某处卡死，
             * 这种半成品必须让用户看到失败并可重试。
             */
            item.status = 'error';
            item.error = `${failed} 个分片下载失败`;
        } else {
            item.status = 'done';
        }
        // 终态强制落盘：节流可能刚跳过最后一次写入，这里必须补上
        persist(true);

        log.info(
            '缓存结束',
            key,
            `${item.done}/${item.total}`,
            `失败 ${failed}`,
            `${(item.bytes / 1048576).toFixed(1)}MB`
        );
        return item;
    } catch (e) {
        item.status = 'error';
        item.error = (e as Error)?.message || '下载失败';
        persist(true);
        log.error('缓存失败', key, item.error);
        return item;
    } finally {
        running.delete(key);
    }
}

/** 格式化字节数，用于界面展示。 */
export function formatSize(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** 格式化时长（秒 → mm:ss / hh:mm:ss）。 */
export function formatDuration(sec: number): string {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}
