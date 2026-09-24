/**
 * 播放状态管理。
 *
 * 负责：
 * 1. 当前影片 / 剧集 / 播放地址
 * 2. 播放进度（本地续播）
 * 3. 双人同步所需的进度上报与对齐
 *
 * 注意：本客户端不走 P2P，播放地址直连 CDN。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/** 本地续播记录的存储键前缀。 */
const PROGRESS_KEY = 'yinghua_progress_';

export interface PlayProgress {
    vodId: number;
    collectionId: number;
    /** 已播放秒数 */
    position: number;
    /** 总时长秒数 */
    duration: number;
    /** 更新时间戳，用于判断记录是否过期 */
    updatedAt: number;
}

export const usePlayStore = defineStore('play', () => {
    /** 当前影片 id */
    const vodId = ref(0);
    /** 当前剧集 id */
    const collectionId = ref(0);
    /** 当前影片名 */
    const vodName = ref('');
    /** 当前集标题 */
    const title = ref('');
    /** 当前播放地址 */
    const playUrl = ref('');
    /** 备用线路 */
    const backups = ref<string[]>([]);
    /** 是否正在解析地址 */
    const resolving = ref(false);

    /** 是否为双人房间模式 */
    const roomMode = ref(false);
    /** 房间 id */
    const roomId = ref('');
    /**
     * 房主身份。
     *
     * 注意：进入房间后若中途离开（比如房主回首页挑片），
     * 房间号与身份需要保留 —— 否则回来时会新建房间，
     * 观众就找不到人了。因此这两个值在 [leaveRoom] 之外不主动清空。
     */
    const isHost = ref(false);
    /** 远端播放状态（房主广播） */
    const remoteState = ref<{ playing: boolean; position: number; updatedAt: number } | null>(null);

    const hasPlayUrl = computed(() => !!playUrl.value);

    /** 设置当前播放的影片与剧集。 */
    function setCurrent(vod: { id: number; vod_name: string }, collection: { id: number; title?: string }) {
        vodId.value = vod.id;
        vodName.value = vod.vod_name;
        collectionId.value = collection.id;
        title.value = collection.title || '';
    }

    /** 设置解析出的播放地址。 */
    function setResolved(url: string, backupList: string[]) {
        playUrl.value = url;
        backups.value = backupList;
    }

    /** 切换到备用线路。 */
    function switchToBackup(): boolean {
        if (backups.value.length === 0) return false;
        const next = backups.value[0];
        backups.value = backups.value.slice(1);
        playUrl.value = next;
        return true;
    }

    /** 保存播放进度到本地。 */
    function saveProgress(position: number, duration: number) {
        if (!vodId.value || !collectionId.value) return;
        const record: PlayProgress = {
            vodId: vodId.value,
            collectionId: collectionId.value,
            position,
            duration,
            updatedAt: Date.now()
        };
        uni.setStorageSync(`${PROGRESS_KEY}${vodId.value}_${collectionId.value}`, record);
    }

    /** 读取本地播放进度。 */
    function loadProgress(vod: number, collection: number): PlayProgress | null {
        const record = uni.getStorageSync(`${PROGRESS_KEY}${vod}_${collection}`) as PlayProgress | '';
        if (!record || typeof record === 'string') return null;
        // 超过 30 天的记录视为过期
        if (Date.now() - record.updatedAt > 30 * 24 * 3600 * 1000) return null;
        return record;
    }

    /** 进入双人房间。 */
    function enterRoom(id: string, host: boolean) {
        roomMode.value = true;
        roomId.value = id;
        isHost.value = host;
    }

    /** 退出双人房间。 */
    function leaveRoom() {
        roomMode.value = false;
        roomId.value = '';
        isHost.value = false;
        remoteState.value = null;
    }

    /** 更新远端播放状态（观众侧调用）。 */
    function updateRemoteState(state: { playing: boolean; position: number; updatedAt: number }) {
        remoteState.value = state;
    }

    /**
     * 计算与房主的进度偏差。
     *
     * 观众侧用它决定是否需要 seek 对齐。
     * @param localPosition 本地当前播放秒数
     * @param threshold     允许的最大偏差（秒）
     */
    function driftFrom(localPosition: number, threshold = 2): number {
        if (!remoteState.value) return 0;
        // 用本地时钟推进远端位置，补偿上报间隔
        const elapsed = (Date.now() - remoteState.value.updatedAt) / 1000;
        const expected = remoteState.value.position + (remoteState.value.playing ? elapsed : 0);
        const drift = localPosition - expected;
        return Math.abs(drift) > threshold ? drift : 0;
    }

    /** 重置（切换影片时调用）。 */
    function reset() {
        playUrl.value = '';
        backups.value = [];
        resolving.value = false;
    }

    return {
        vodId,
        collectionId,
        vodName,
        title,
        playUrl,
        backups,
        resolving,
        roomMode,
        roomId,
        isHost,
        remoteState,
        hasPlayUrl,
        setCurrent,
        setResolved,
        switchToBackup,
        saveProgress,
        loadProgress,
        enterRoom,
        leaveRoom,
        updateRemoteState,
        driftFrom,
        reset
    };
});
