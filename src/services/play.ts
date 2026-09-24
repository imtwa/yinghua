/**
 * 播放地址解析。
 *
 * ## 数据源说明
 *
 * 本工程使用**公开采集源**（苹果CMS v10，见 constants/source.ts），
 * 其 m3u8 与分片均可由普通 HTTP 客户端直连，**不走 P2P 分发**。
 *
 * 这与原 APK（`com.hjmore.oeqvv`）不同：原源使用私有 P2P 协议
 * （`libpp_hls.so`），普通客户端只能拿到占位警告片。
 *
 * ## 流程
 *
 * 详情接口（`ac=detail&ids=`）已返回 `vod_play_url`，
 * 其中含各集直链，故解析只需：
 *   1. 从详情里取出对应剧集的 m3u8 地址
 *   2. 可选探测可用性
 *   3. 交给播放器
 */

import type { Collection, ResolvedPlay } from '@/api/types';
import { getVodDetail, probePlayUrl } from '@/services/video';
import { createLogger } from '@/utils/logger';
import { wrapUrl } from '@/utils/url';

const log = createLogger('play-resolve');

/** 是否开启可用性探测。 */
const PROBE_ENABLE = import.meta.env.VITE_PLAY_PROBE_ENABLE !== 'false';

/**
 * H5 端能否直连片源 CDN。
 *
 * 片源 CDN 不返回 CORS 头，浏览器探测会被同源策略拦截。
 * H5 端统一走本地代理（见 utils/url.ts），探测也经代理进行。
 */
function canProbe(): boolean {
    // #ifdef H5
    return true;
    // #endif

    // #ifndef H5
    return true;
    // #endif
}

/** 组装返回值。 */
function buildResult(collection: Collection, candidates: string[]): ResolvedPlay {
    return {
        url: candidates[0],
        backups: candidates.slice(1),
        title: collection.title || '',
        isP2p: 0,
        sourceId: 1
    };
}

/**
 * 解析出可播放地址。
 *
 * @param vodId        影片 id
 * @param collectionId 剧集序号（从 1 开始）
 * @param token        登录 token（本源不需要，保留参数以兼容调用方）
 */
export async function resolvePlayUrl(
    vodId: number,
    collectionId: number,
    token = ''
): Promise<ResolvedPlay> {
    const detail = await getVodDetail(vodId, token);
    const collections = (detail?.vod_collection || []) as Collection[];

    if (collections.length === 0) {
        throw new Error('该影片暂无可用剧集');
    }

    // collectionId 从 1 开始；越界时回退到第一集
    const idx = Math.min(Math.max(collectionId - 1, 0), collections.length - 1);
    const collection = collections[idx];

    // 收集候选线路（本源每条剧集只有一个地址，备用为空）
    const rawCandidates = [collection.vod_url].filter(Boolean) as string[];
    if (rawCandidates.length === 0) {
        throw new Error('该剧集未提供播放地址');
    }

    // H5 端包装成走本地代理的地址（CDN 无 CORS 头），App 端保持原地址
    const candidates = rawCandidates.map(wrapUrl);

    log.info(`解析第 ${idx + 1} 集`, {
        标题: collection.title,
        原始地址: rawCandidates[0],
        实际地址: candidates[0]
    });

    // 探测可用性
    if (PROBE_ENABLE && canProbe()) {
        const ok = await probePlayUrl(candidates[0]);
        log.info(ok ? '线路可访问' : '线路不可访问', rawCandidates[0]);
        if (!ok) {
            log.warn('该线路探测失败，仍交给播放器尝试');
        }
    } else {
        log.info('跳过探测，直接交给播放器');
    }

    return buildResult(collection, candidates);
}

/** 从剧集列表里取指定集。 */
export function pickCollection(collections: any[] | undefined, index = 0) {
    if (!collections || collections.length === 0) {
        return null;
    }
    const safeIndex = Math.min(Math.max(index, 0), collections.length - 1);
    return collections[safeIndex];
}
