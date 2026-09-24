/**
 * 影片相关接口。
 *
 * 数据源：苹果CMS v10 标准采集接口（见 constants/source.ts）。
 *
 * 设计：**适配器模式**。
 * 对外保持原有函数签名（getChannels / getChannelInfo / getVodDetail / searchVod），
 * 内部把苹果CMS 的数据结构转换成工程既有的 Vod / Channel / HomeModule 形状，
 * 因此页面与播放器无需任何改动。
 *
 * 端点（苹果CMS v10 标准）：
 *   GET ?ac=list                    分类列表
 *   GET ?ac=detail&t=&pg=           按分类取列表
 *   GET ?ac=detail&ids=             影片详情
 *   GET ?ac=detail&wd=              搜索
 *
 * 播放地址在 `vod_play_url` 字段，格式：
 *   "第01集$https://xxx.m3u8#第02集$https://yyy.m3u8"
 */

import type { Channel, Collection, HomeModule, PlayInfo, Vod } from '@/api/types';
import {
    ALL_SOURCES,
    LATEST_SECTION,
    SOURCE_TIMEOUT,
    type ContentSource
} from '@/constants/source';
import { requestRaw } from '@/http/request';
import { createLogger } from '@/utils/logger';
import { wrapUrl } from '@/utils/url';

const log = createLogger('video');

/* ------------------------------------------------------------------
 * 底层请求（GET + JSON，与业务接口的 POST+加密不同）
 * ---------------------------------------------------------------- */

interface CmsResponse {
    code: number;
    msg?: string;
    page?: number;
    pagecount?: number;
    limit?: string;
    total?: number;
    list?: any[];
    class?: any[];
}

/**
 * 全局并发闸门。
 *
 * 为什么要有：源站对短时间密集请求会临时拒绝（实测同一批请求
 * 时而全成功、时而全失败，属限流）。因此必须限制「同时在飞的请求数」。
 *
 * 为什么放在最底层而不是各调用点：首页要并行拉多个栏目，
 * 每个栏目内部又并发多个子类。若只在栏目内限流，
 * 多栏目并行时总并发会相乘（实测到 24 就会整批失败）。
 * 把闸门放在 fetchSource 这一层，任何调用路径都共用一个池，
 * 无论上层怎么并行，实际并发恒定。
 */
const MAX_CONCURRENT = 6;

/** 当前在飞请求数 */
let inflight = 0;
/** 等待队列（FIFO，保证先到先发） */
const waitQueue: Array<() => void> = [];

/** 申请一个并发额度（满了就排队等待）。 */
function acquireSlot(): Promise<void> {
    if (inflight < MAX_CONCURRENT) {
        inflight += 1;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => waitQueue.push(resolve));
}

/** 归还额度并唤醒队首等待者。 */
function releaseSlot() {
    const next = waitQueue.shift();
    if (next) {
        // 额度直接转交，不改 inflight —— 避免「先减后加」的空窗
        next();
        return;
    }
    inflight -= 1;
}

/** 向指定源发 GET 请求（受全局并发闸门约束）。 */
async function fetchSource(source: ContentSource, params: Record<string, any>): Promise<CmsResponse> {
    await acquireSlot();
    try {
        return await doFetchSource(source, params);
    } finally {
        releaseSlot();
    }
}

/** 实际发起请求（调用前须已取得并发额度）。 */
function doFetchSource(source: ContentSource, params: Record<string, any>): Promise<CmsResponse> {
    const query = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');

    const rawUrl = `${source.api}?${query}`;
    // H5 端采集源无 CORS 头，需走本地代理（见 utils/url.ts）
    const url = wrapUrl(rawUrl);
    log.info(`请求 ${source.name}`, rawUrl);

    return new Promise<CmsResponse>((resolve, reject) => {
        uni.request({
            url,
            method: 'GET',
            timeout: SOURCE_TIMEOUT,
            header: { Accept: 'application/json,*/*' },
            dataType: 'json',
            success: res => {
                if (res.statusCode !== 200) {
                    reject(new Error(`${source.name} HTTP ${res.statusCode}`));
                    return;
                }
                const data = res.data as CmsResponse;
                if (!data || !Array.isArray(data.list)) {
                    reject(new Error(`${source.name} 返回格式异常`));
                    return;
                }
                resolve(data);
            },
            fail: err => reject(new Error(`${source.name} 请求失败：${JSON.stringify(err)}`))
        });
    });
}

/**
 * 按顺序尝试各源，返回第一个成功的结果。
 *
 * 这样主源挂了会自动落到备用源。
 *
 * 注意：**不处理分类名解析**。跨源分类必须由调用方先按分类表
 * 转成目标源的 type_id（见 getChannelInfo），因为分类查询要走
 * 「父类 + 子类聚合」，不是单次请求能表达的。
 *
 * @param params 源端查询参数（t 必须是已解析好的数字 id）
 * @param opts.needList 要求返回非空列表，否则视为该源不可用
 */
async function fetchAny(
    params: Record<string, any>,
    opts: { needList?: boolean } = {}
): Promise<CmsResponse> {
    let lastError: Error | null = null;

    for (const source of ALL_SOURCES) {
        // 搜索只走支持搜索的源
        if (params.wd && !source.searchable) continue;

        try {
            const data = await fetchSource(source, params);

            if (opts.needList && (!data.list || data.list.length === 0)) {
                lastError = new Error(`${source.name} 无数据`);
                log.warn(`${source.name} 该请求无数据，尝试下一个源`);
                continue;
            }

            log.info(`命中源：${source.name}`, `返回 ${data.list?.length ?? 0} 条`);
            return data;
        } catch (e) {
            lastError = e as Error;
            log.warn(`${source.name} 不可用，尝试下一个源`);
        }
    }

    throw lastError || new Error('所有内容源均不可用');
}

/* ------------------------------------------------------------------
 * 分类解析（名字 → 各源自己的 type_id）
 * ---------------------------------------------------------------- */

/** 分类表中的一项。 */
interface ClassNode {
    id: number;
    name: string;
    /** 子分类 id 列表（一级分类才可能有） */
    children: number[];
}

/**
 * 分类表缓存：源名 → { 分类名: 节点 }。
 *
 * 各源的 type_id 互不相同，只能用名字反查；分类表基本不变，
 * 缓存一次即可，避免每次取栏目都多打一次 ac=list。
 */
const classCache = new Map<string, Record<string, ClassNode>>();

/** 拉取并缓存某源的分类表（含父子关系）。 */
async function getClassTree(source: ContentSource): Promise<Record<string, ClassNode>> {
    const cached = classCache.get(source.name);
    if (cached) return cached;

    const data = await fetchSource(source, { ac: 'list' });
    const map: Record<string, ClassNode> = {};
    const pendingChildren: Array<{ pid: number; id: number }> = [];

    for (const c of data.class || []) {
        const id = Number(c.type_id) || 0;
        const name = String(c.type_name || '').trim();
        if (!id || !name) continue;

        /*
         * type_pid 缺失（红牛、无尽、索尼等源）时按一级处理 ——
         * 否则会被整体过滤掉，导致名称解析全部 MISS。
         */
        const rawPid = c.type_pid;
        const pid = rawPid === undefined || rawPid === null || rawPid === '' ? 0 : Number(rawPid);

        if (pid === 0) {
            map[name] = { id, name, children: [] };
        } else {
            pendingChildren.push({ pid, id });
        }
    }

    // 二级分类挂到对应的一级分类下
    for (const child of pendingChildren) {
        for (const node of Object.values(map)) {
            if (node.id === child.pid) {
                node.children.push(child.id);
                break;
            }
        }
    }

    classCache.set(source.name, map);
    return map;
}

/**
 * 按名称（含别名）在分类表里查分类节点。
 *
 * 匹配优先级：精确 name → 精确 alias → 包含 name → 包含 alias。
 * 之所以要「包含」兜底，是因为各源命名不统一，例如
 * 无尽源的「短剧」实际叫「爽文短剧」。
 */
function pickClassNode(map: Record<string, ClassNode>, names: string[]): ClassNode | null {
    for (const n of names) {
        if (map[n]) return map[n];
    }
    for (const n of names) {
        const key = Object.keys(map).find(k => k.includes(n));
        if (key) return map[key];
    }
    return null;
}

/**
 * 把苹果CMS 条目的 vod_time 转成可比较的数值。
 *
 * 源端格式为 `YYYY-MM-DD HH:mm:ss`；iOS 对 `-` 分隔解析不友好，
 * 故手动拆解，避免退化成 NaN 导致排序错乱。
 */
function timeValue(vod: any): number {
    const s = String(vod?.vod_time || '');
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** 把一组影片按更新时间倒序排列（最新的在前）。 */
function sortByTimeDesc(list: any[]): any[] {
    return list
        .map((v, i) => ({ v, i, t: timeValue(v) }))
        .sort((a, b) => b.t - a.t || a.i - b.i)
        .map(x => x.v);
}

/* ------------------------------------------------------------------
 * 数据转换
 * ---------------------------------------------------------------- */

/** 把苹果CMS 的播放地址串转成剧集列表。 */
export function parsePlayUrl(playUrl: string): Collection[] {
    if (!playUrl) return [];

    const out: Collection[] = [];
    // 格式：第01集$url#第02集$url
    const segments = playUrl.split('#').filter(Boolean);

    segments.forEach((seg, index) => {
        const idx = seg.indexOf('$');
        if (idx < 0) return;
        const title = seg.slice(0, idx).trim();
        const url = seg.slice(idx + 1).trim();
        if (!url) return;

        out.push({
            id: index + 1,
            collection: index + 1,
            title: title || `第${index + 1}集`,
            vod_id: 0,
            // 苹果CMS 无需 token，播放地址直接可用
            vod_token: '',
            cur_time: '',
            vod_url: url,
            ck: '',
            duration: '',
            is_p2p: 0,
            is_selected: index === 0 ? 1 : 0,
            position: index + 1
        });
    });

    return out;
}

/** 把苹果CMS 的条目转成工程的 Vod。 */
function toVod(raw: any): Vod {
    const playUrl = raw.vod_play_url || '';
    return {
        id: Number(raw.vod_id) || 0,
        vod_id: Number(raw.vod_id) || 0,
        vod_name: raw.vod_name || '',
        vod_pic: raw.vod_pic || '',
        vod_year: String(raw.vod_year || ''),
        vod_serial: String(raw.vod_serial || ''),
        vod_actors: raw.vod_actor || '',
        vod_area: raw.vod_area || '',
        vod_lang: raw.vod_lang || '',
        vod_remarks: raw.vod_remarks || '',
        vod_score: String(raw.vod_douban_score || ''),
        vod_content: raw.vod_content || raw.vod_blurb || '',
        vod_total: Number(raw.vod_total) || 0,
        type_pid: Number(raw.type_id_1) || Number(raw.type_id) || 0,
        // 附加字段：列表页也带播放地址，可直接进播放页
        vod_collection: parsePlayUrl(playUrl)
    } as Vod;
}

/** 苹果CMS 的 type_id → 工程 Channel。 */
function toChannel(raw: any): Channel {
    return {
        id: Number(raw.type_id) || 0,
        channel_name: raw.type_name || '',
        vod_type_id: Number(raw.type_pid) || 0
    };
}

/**
 * 把苹果CMS 的扁平列表包装成工程的 HomeModule 形状。
 *
 * 工程首页按「模块 + block」渲染，这里统一包一层。
 */
function toHomeModules(list: any[], title: string): HomeModule[] {
    const vods = list.map(toVod).filter(v => v.id > 0);

    return [
        {
            module_id: 1,
            module_name: title,
            type: 6,
            is_title: 1,
            is_more: 0,
            is_change: 0,
            block_list: [
                {
                    vod_list: vods
                }
            ]
        }
    ];
}

/* ------------------------------------------------------------------
 * 对外接口（保持原有签名）
 * ---------------------------------------------------------------- */

/** 分类列表（只返回一级分类）。 */
export async function getChannels(): Promise<Channel[]> {
    const data = await fetchAny({ ac: 'list' });
    const classes = data.class || [];

    /*
     * 只保留一级分类。
     *
     * type_pid 缺失（红牛、无尽、索尼等源）时按一级处理 ——
     * 不能用 `Number(c.type_pid) === 0` 判断：undefined 转出来是 NaN，
     * 会把这类源的**全部**分类误判为二级而过滤掉，
     * 结果分类页一个分类都不显示。
     */
    const isTop = (c: any) => {
        const raw = c.type_pid;
        return raw === undefined || raw === null || raw === '' || Number(raw) === 0;
    };
    const top = classes.filter(isTop);
    const list = (top.length > 0 ? top : classes).map(toChannel);

    log.info('分类列表', list.map(c => c.channel_name));
    return list;
}

/** 向指定源发 GET 请求（带一次重试）。 */
async function fetchSourceRetry(
    source: ContentSource,
    params: Record<string, any>,
    retries = 1
): Promise<CmsResponse> {
    let lastErr: Error | null = null;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fetchSource(source, params);
        } catch (e) {
            lastErr = e as Error;
            if (i < retries) await delay(220);
        }
    }
    throw lastErr || new Error(`${source.name} 请求失败`);
}

/** 简易延时。 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 取「一组分类 id」聚合后的影片列表，按更新时间倒序。
 *
 * 为什么不是一个请求搞定：
 *   实测暴风源**不支持多分类查询** —— `t=30,31,32,...` 的返回与
 *   `t=30` 完全相同（分隔符用逗号/竖线/空格都一样）。
 *
 * 因此改为：并发查每个子类，再客户端按 vod_time 归并。
 *
 * 为什么需要子类：
 *   该源的**一级分类几乎是空壳**。以「连续剧(30)」为例，直接查它
 *   只返回 7 条 2023 年的老剧，而它的子类国产剧/韩剧/日剧/泰剧
 *   每天都在更新（首条均为当天）。不查子类，首页栏目只会是老内容。
 *
 * 并发控制交给底层的全局闸门（见 fetchSource）——
 * 这里只需一次性把全部子类请求提交出去，闸门会按 6 并发自动排队。
 * 早先在这里再做「分批 + 批间 delay」，与全局闸门叠加后反而
 * 让总耗时成倍增加（每批都要等一个 120ms 的间隔）。
 *
 * @param source 已选定的源
 * @param ids    参与聚合的分类 id（父类 + 子类）
 * @param page   页码，逐子类翻同一页后归并
 */
async function fetchGrouped(
    source: ContentSource,
    ids: number[],
    page: number
): Promise<{ list: any[]; total: number }> {
    const merged: any[] = [];
    const seen = new Set<number>();
    let total = 0;

    // 全部子类一次提交；并发由底层闸门限流，失败的重试也在 fetchSourceRetry 内
    const settled = await Promise.all(
        ids.map(id => fetchSourceRetry(source, { ac: 'detail', t: id, pg: page }).catch(() => null))
    );

    for (const r of settled) {
        if (!r || !r.list) continue;
        total += Number(r.total) || 0;
        for (const v of r.list) {
            const vid = Number(v.vod_id) || 0;
            if (vid && seen.has(vid)) continue;
            if (vid) seen.add(vid);
            merged.push(v);
        }
    }

    return { list: sortByTimeDesc(merged), total };
}

/**
 * 分类下的影片列表（聚合该分类及其全部子类）。
 *
 * ⚠️ 分页语义与单分类查询不同：
 * 聚合后每「页」是「每个子类各取 20 条再按时间归并」，
 * 因此返回条数通常远多于 20（分类多时可达上百条），
 * 且**天然按更新时间倒序** —— 最新内容永远在最前面。
 *
 * 调用方判断「是否还有下一页」时不能用 `list.length >= 20`，
 * 应使用 {@link hasNextPage} 或按「返回条数 > 0」判断。
 *
 * @param channel 分类名（推荐，跨源安全）或分类 id（仅主源可靠，不推荐）
 * @param page    页码
 * @param alias   分类别名，供各源命名差异兜底
 */
export async function getChannelInfo(
    channel: string | number,
    page = 1,
    alias: string[] = []
): Promise<HomeModule[]> {
    const isName = typeof channel === 'string';
    let lastError: Error | null = null;

    for (const source of ALL_SOURCES) {
        try {
            let targetIds: number[] = [];

            if (isName) {
                const map = await getClassTree(source);
                const node = pickClassNode(map, [channel, ...alias]);
                if (!node) {
                    lastError = new Error(`${source.name} 无「${channel}」分类`);
                    continue;
                }
                // 父类 + 全部子类一起聚合
                targetIds = [node.id, ...node.children];
            } else {
                targetIds = [channel];
            }

            /*
             * 限制参与聚合的子类数量。
             *
             * 首页会同时拉「最新」+ 多个分类栏目，若每栏目都放开十几个
             * 子类，总请求数会触发源站限流（实测会整批失败、栏目变空）。
             * 取前 8 个已足够覆盖主要子类且排序后仍是最新内容在前。
             */
            const picked = targetIds.slice(0, 8);
            const { list } = await fetchGrouped(source, picked, page);

            /*
             * 注意：这里不能用「list 为空」判定该源不可用。
             *
             * 聚合页为空有两种情形：
             *   a) 该分类确实没有内容（翻到了末页，或分类本身冷门）
             *   b) 源故障
             * 两者无法从响应区分，但 (a) 更常见。若按 (b) 处理去回退到
             * 备用源，会把「末页」误判成源故障 —— 表现为翻到底后
             * 整个列表被换成另一个源的内容。
             *
             * 因此：分类名匹配成功即认为该源可用，空列表直接返回空，
             * 由调用方按「本页 0 条」停止翻页。
             */
            log.info(
                `分类「${channel}」第 ${page} 页`,
                `${source.name} 聚合 ${picked.length} 个分类，${list.length} 条`
            );
            return toHomeModules(list, isName ? channel : list[0]?.type_name || '影片列表');
        } catch (e) {
            lastError = e as Error;
            log.warn(`${source.name} 分类聚合失败，尝试下一个源`);
        }
    }

    throw lastError || new Error('所有内容源均不可用');
}

/**
 * 判断某分类的指定页之后是否还有内容。
 *
 * 聚合分页下每页条数不固定，故单独提供该方法：
 * 取下一页，有数据就说明还有（顺带可用于预判）。
 *
 * @param channel 分类名
 * @param page    已加载到的页码
 * @param alias   分类别名
 */
export async function hasNextPage(channel: string, page: number, alias: string[] = []): Promise<boolean> {
    try {
        const mods = await getChannelInfo(channel, page + 1, alias);
        const list = mods?.[0]?.block_list?.[0]?.vod_list || [];
        return list.length > 0;
    } catch {
        return false;
    }
}

/**
 * 最新影片（按更新时间倒序）。
 *
 * 苹果CMS 在不传 `t` 时默认按 `vod_time` 倒序 —— 实测各源一致，
 * 无需任何排序参数（`order`/`by` 参数在多数源上并不生效）。
 *
 * @param pages 抓取的页数，逐页拼接（首页只想看新鲜的，默认 1 页）
 */
export async function getLatestVod(pages = 1): Promise<HomeModule[]> {
    const pageCount = Math.max(1, Math.min(pages, 5));
    const reqs: Array<Promise<CmsResponse>> = [];

    for (let pg = 1; pg <= pageCount; pg++) {
        reqs.push(fetchAny({ ac: 'detail', pg }, { needList: true }));
    }

    const results = await Promise.allSettled(reqs);

    // 逐页追加，任一页失败不影响其它页
    const list: any[] = [];
    for (const r of results) {
        if (r.status === 'fulfilled') {
            list.push(...(r.value.list || []));
        } else {
            log.warn('最新列表某页失败', (r.reason as Error)?.message);
        }
    }

    if (list.length === 0) throw new Error('最新列表获取失败');

    log.info('最新影片', `共 ${list.length} 条`);
    return toHomeModules(list, LATEST_SECTION.name);
}

/**
 * 影片详情。
 *
 * 苹果CMS 的列表接口已带完整字段（含 vod_play_url），
 * 故直接按 id 查询即可，无需额外请求。
 */
export async function getVodDetail(vodId: number, token = ''): Promise<Vod> {
    const data = await fetchAny({ ac: 'detail', ids: vodId }, { needList: true });
    const raw = data.list?.[0];
    if (!raw) throw new Error('影片不存在');

    const vod = toVod(raw);
    log.info('影片详情', vod.vod_name, `集数 ${vod.vod_collection?.length ?? 0}`);
    return vod;
}

/**
 * 取某集的播放信息。
 *
 * 苹果CMS 的播放地址已包含在详情里，此处直接返回对应剧集，
 * 保持与原接口（/api/video/collection）相同的返回形状。
 */
export async function getPlayInfo(
    vodId: number,
    collectionId: number,
    vodToken = '',
    curTime = '',
    token = ''
): Promise<PlayInfo> {
    const vod = await getVodDetail(vodId, token);
    const collections = vod.vod_collection || [];

    const idx = Math.min(Math.max(collectionId - 1, 0), Math.max(collections.length - 1, 0));
    const ep = collections[idx];
    if (!ep) throw new Error('该影片暂无可用剧集');

    return {
        id: ep.id,
        vod_id: vodId,
        vod_token: '',
        vod_url: ep.vod_url,
        out_vod_url: ep.vod_url,
        tc_vod_url: '',
        sub_vod_url: '',
        ck: '',
        header_json: '',
        // 苹果CMS 不走 P2P
        is_p2p: 0,
        source_id: 1,
        server_time: Math.floor(Date.now() / 1000),
        title: ep.title,
        title_desc: ep.title,
        duration: ''
    };
}

/**
 * 搜索影片。
 *
 * 苹果CMS 标准搜索：`ac=detail&wd=<关键词>`。
 * 若主源不支持搜索，会自动尝试其他支持搜索的源。
 */
export async function searchVod(keyword: string, page = 1): Promise<Vod[]> {
    const wd = (keyword || '').trim();
    if (!wd) return [];

    const data = await fetchAny({ ac: 'detail', wd, pg: page }, { needList: true });
    const list = (data.list || []).map(toVod).filter(v => v.id > 0);

    log.info(`搜索「${wd}」`, `命中 ${list.length} 条`);
    return list;
}

/**
 * 热搜词。
 *
 * 苹果CMS 无此接口，用固定词兜底（也避免首页空白）。
 */
export async function getHotSearch(): Promise<Array<{ name: string; vodId?: number }>> {
    const defaults = ['庆余年', '仙逆', '法医秦明', '狂飙', '三体', '流浪地球', '漫长的季节', '莲花楼'];
    return defaults.map(name => ({ name }));
}

/**
 * 猜你喜欢。
 *
 * 用最新列表兜底。
 */
export async function getRecommend(page = 1): Promise<Vod[]> {
    const data = await fetchAny({ ac: 'detail', pg: page }, { needList: true });
    return (data.list || []).map(toVod).filter(v => v.id > 0);
}

/**
 * 探测某个 m3u8 地址是否可播放。
 *
 * 判据：HTTP 200 且响应体以 #EXTM3U 开头。
 */
export async function probePlayUrl(url: string): Promise<boolean> {
    if (!url) return false;
    try {
        const body = await requestRaw(url, Number(import.meta.env.VITE_PLAY_PROBE_TIMEOUT) || 8000);
        return typeof body === 'string' && body.trimStart().startsWith('#EXTM3U');
    } catch {
        return false;
    }
}
