/**
 * 用户状态。
 *
 * 数据源切换为公开采集源后，**无需登录与 token**，
 * 因此这里只保留最简的本地状态：
 *   - 默认昵称（可在「我的」页修改）
 *   - 收藏 / 观看记录 / 离线缓存的条数
 *
 * 实际数据由 `services/user.ts`、`services/profile.ts`、
 * `services/download.ts` 的本地存储实现负责，这里只是聚合与缓存。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getFavorites, getHistory } from '@/services/user';
import { getCacheList } from '@/services/download';
import { getNickname, setNickname as saveNickname } from '@/services/profile';

export const useUserStore = defineStore('user', () => {
    /** 昵称（首次读取时自动生成并落盘） */
    const nickname = ref('');
    /** 播放记录条数 */
    const historyCount = ref(0);
    /** 收藏条数 */
    const favoriteCount = ref(0);
    /** 离线缓存条数（已完成的） */
    const cacheCount = ref(0);
    /** 离线缓存占用字节数 */
    const cacheBytes = ref(0);

    /** 是否已有数据（用于「我的」页展示） */
    const hasData = computed(
        () => historyCount.value > 0 || favoriteCount.value > 0 || cacheCount.value > 0
    );

    /** 刷新（进入「我的」页或数据变更后调用）。 */
    function refresh() {
        nickname.value = getNickname();
        historyCount.value = getHistory().length;
        favoriteCount.value = getFavorites().length;

        const caches = getCacheList();
        cacheCount.value = caches.filter(c => c.status === 'done').length;
        cacheBytes.value = caches.reduce((sum, c) => sum + (c.bytes || 0), 0);
    }

    /** 修改昵称。 */
    function updateNickname(name: string) {
        nickname.value = saveNickname(name);
        return nickname.value;
    }

    return {
        nickname,
        historyCount,
        favoriteCount,
        cacheCount,
        cacheBytes,
        hasData,
        refresh,
        updateNickname
    };
});
