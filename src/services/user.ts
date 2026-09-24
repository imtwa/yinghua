/**
 * 用户与播放记录。
 *
 * 数据源已切换为公开采集源（见 constants/source.ts），
 * 原 APK 的账号体系（init / login / user_history 等）不再适用。
 *
 * 因此这里改为**纯本地实现**：
 *   - 播放记录 / 收藏 存本地存储
 *   - 无需登录、无需 token
 *
 * 这样也顺带解决了原先「/api/video/* 必须带 token」的时序问题。
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('user');

const HISTORY_KEY = 'yinghua_history';
const FAVORITE_KEY = 'yinghua_favorite';

/** 播放记录条目。 */
export interface HistoryItem {
    vodId: number;
    vodName: string;
    vodPic: string;
    /** 剧集序号（从 1 开始） */
    collectionId: number;
    collectionTitle: string;
    /** 已播放秒数 */
    position: number;
    /** 总时长秒数 */
    duration: number;
    updatedAt: number;
}

/** 收藏条目。 */
export interface FavoriteItem {
    vodId: number;
    vodName: string;
    vodPic: string;
    vodRemarks: string;
    addedAt: number;
}

/** 最多保留的记录数。 */
const MAX_HISTORY = 100;
const MAX_FAVORITE = 200;

/* ------------------------------------------------------------------
 * 播放记录
 * ---------------------------------------------------------------- */

/** 读取全部播放记录（按时间倒序）。 */
export function getHistory(): HistoryItem[] {
    try {
        const list = (uni.getStorageSync(HISTORY_KEY) as HistoryItem[]) || [];
        return list.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
}

/**
 * 上报播放记录（写入本地）。
 *
 * 同名影片只保留最新一条，避免列表被同一部剧刷屏。
 */
export function addHistory(item: Omit<HistoryItem, 'updatedAt'>) {
    try {
        const list = getHistory().filter(h => h.vodId !== item.vodId);
        list.unshift({ ...item, updatedAt: Date.now() });
        uni.setStorageSync(HISTORY_KEY, list.slice(0, MAX_HISTORY));
    } catch (e) {
        log.warn('写入播放记录失败', String(e));
    }
}

/** 删除单条记录。 */
export function removeHistory(vodId: number) {
    try {
        const list = getHistory().filter(h => h.vodId !== vodId);
        uni.setStorageSync(HISTORY_KEY, list);
    } catch {
        // 忽略
    }
}

/** 清空播放记录。 */
export function clearHistory() {
    try {
        uni.removeStorageSync(HISTORY_KEY);
    } catch {
        // 忽略
    }
}

/** 查某部影片的播放记录（用于续播）。 */
export function findHistory(vodId: number): HistoryItem | null {
    return getHistory().find(h => h.vodId === vodId) || null;
}

/* ------------------------------------------------------------------
 * 收藏
 * ---------------------------------------------------------------- */

/** 读取收藏列表。 */
export function getFavorites(): FavoriteItem[] {
    try {
        const list = (uni.getStorageSync(FAVORITE_KEY) as FavoriteItem[]) || [];
        return list.sort((a, b) => b.addedAt - a.addedAt);
    } catch {
        return [];
    }
}

/** 是否已收藏。 */
export function isFavorite(vodId: number): boolean {
    return getFavorites().some(f => f.vodId === vodId);
}

/** 切换收藏，返回切换后的状态。 */
export function toggleFavorite(item: Omit<FavoriteItem, 'addedAt'>): boolean {
    try {
        const list = getFavorites();
        const exists = list.some(f => f.vodId === item.vodId);

        if (exists) {
            uni.setStorageSync(FAVORITE_KEY, list.filter(f => f.vodId !== item.vodId));
            return false;
        }

        list.unshift({ ...item, addedAt: Date.now() });
        uni.setStorageSync(FAVORITE_KEY, list.slice(0, MAX_FAVORITE));
        return true;
    } catch (e) {
        log.warn('写入收藏失败', String(e));
        return false;
    }
}

/** 清空收藏。 */
export function clearFavorites() {
    try {
        uni.removeStorageSync(FAVORITE_KEY);
    } catch {
        // 忽略
    }
}
