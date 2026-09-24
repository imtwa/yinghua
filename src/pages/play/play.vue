<template>
    <view class="play">
        <!--
            独立导航栏：返回按钮占据单独一栏，不再浮在视频画面上方。
            勿再绑 @back —— yh-nav 内部已自行 navigateBack，重复绑定会返回两次。
        -->
        <yh-nav class="play__nav" :title="navTitle" />

        <!-- 播放器区域：本区域不参与滚动 -->
        <view class="play__stage">
            <view class="play__stage-inner">
                <yh-player
                    v-if="playStore.playUrl"
                    ref="playerRef"
                    class="play__player"
                    :src="playStore.playUrl"
                    :poster="poster"
                    :autoplay="true"
                    :initial-time="resumePosition"
                    :offline="offlineInfo"
                    :collections="collections"
                    :current-index="currentIndex"
                    @timeupdate="onTimeUpdate"
                    @landscapechange="onLandscapeChange"
                    @orientationchange="onOrientationChange"
                    @episodechange="onEpisodeChange"
                    @ended="onEnded"
                    @error="onPlayError" />

                <view v-else class="play__loading">
                    <text class="play__loading-text">{{ loadingText }}</text>
                    <text v-if="status === 'error' && failReason" class="play__reason">{{ failReason }}</text>
                    <view v-if="status === 'error'" class="play__retry tap tap-solid" @click="reload">
                        <text class="play__retry-text">重新加载</text>
                    </view>
                </view>
            </view>
        </view>

        <!-- 信息与选集：只在这一层滚动 -->
        <scroll-view class="play__body" scroll-y :show-scrollbar="false">
            <view class="play__info">
                <text class="play__title">{{ vodName }}</text>
                <text class="play__subtitle">{{ episodeTitle }}</text>

                <view class="play__actions">
                    <view class="play__action tap tap-solid" @click="goRoom">
                        <text class="play__action-text">一起看</text>
                    </view>
                    <view class="play__action tap tap-solid" @click="toggleFullscreen">
                        <text class="play__action-text">{{ fullscreenText }}</text>
                    </view>
                    <view v-if="isLandscape" class="play__action tap tap-solid" @click="toggleOrientation">
                        <text class="play__action-text">{{ isLandscapeLayout ? '切竖屏' : '切横屏' }}</text>
                    </view>
                    <!-- 离线缓存：仅 App 端可用 -->
                    <view v-if="cacheSupported" class="play__action tap tap-solid" @click="onCacheTap">
                        <text class="play__action-text" :class="{ 'play__action-text--busy': caching }">
                            {{ cacheText }}
                        </text>
                    </view>
                    <view v-if="playStore.backups.length" class="play__action tap tap-solid" @click="switchLine">
                        <text class="play__action-text">切换线路</text>
                    </view>
                </view>

                <!-- 缓存进度条：下载中才显示 -->
                <view v-if="caching && cacheItem" class="play__cache">
                    <view class="play__cache-bar">
                        <view class="play__cache-fill" :style="{ width: cachePercent + '%' }" />
                    </view>
                    <text class="play__cache-text">
                        正在缓存 {{ cachePercent }}% · {{ formatSize(cacheItem.bytes) }}
                        <text v-if="cacheItem.total">（{{ cacheItem.done }}/{{ cacheItem.total }} 片）</text>
                    </text>
                </view>

                <!-- 离线模式提示：该集已缓存，正在读本地文件 -->
                <view v-if="offlineInfo" class="play__offline">
                    <text class="play__offline-text">离线播放中（本地缓存）</text>
                </view>
            </view>

            <!-- 选集 -->
            <view v-if="collections.length" class="play__section">
                <text class="play__section-title">选集（{{ collections.length }}）</text>
                <yh-episode
                    :collections="collections"
                    :current-index="currentIndex"
                    @select="switchEpisode" />
            </view>

            <view class="play__tail" />
        </scroll-view>
    </view>
</template>

<script setup lang="ts">
/**
 * 播放页。
 *
 * 要点：
 * 1. 整页高度锁定为视口高度，**只有下半部分滚动** ——
 *    播放器不随页面滚动移动，画面始终保持在同一位置
 * 2. 播放器区域内禁用了外层滚动与长按选中，左侧竖滑调亮度、右侧竖滑调音量
 * 3. 全屏由播放器组件接管：App 端隐藏系统状态栏并锁定横屏，H5 端走 Fullscreen API
 * 4. 播放器自带控制条：点画面唤出，再点画面立即隐藏
 */

import { computed, ref } from 'vue';
import { onBackPress, onLoad, onUnload } from '@dcloudio/uni-app';
import type { Collection } from '@/api/types';
import { resolvePlayUrl } from '@/services/play';
import { getVodDetail } from '@/services/video';
import { addHistory } from '@/services/user';
import { usePlayStore } from '@/stores/play';
import { createLogger } from '@/utils/logger';
import { isRoomCode, loadActiveRoom } from '@/utils/room-sync';
import {
    cacheDirOf,
    canCache,
    cancelDownload,
    formatSize,
    getCacheItem,
    getCachedManifest,
    startCache,
    type CacheItem
} from '@/services/download';

const log = createLogger('play');

const playStore = usePlayStore();

const playerRef = ref<any>(null);
const collections = ref<Collection[]>([]);
const currentIndex = ref(0);
const vodName = ref('');
const vodPic = ref('');
const episodeTitle = ref('');
const poster = ref('');
const resumePosition = ref(0);
const failReason = ref('');
const isLandscape = ref(false);
/** 全屏下的方向：true=横屏 */
const isLandscapeLayout = ref(true);

/* ---------------- 离线缓存 ---------------- */

/** 当前平台是否支持缓存（仅 App 端） */
const cacheSupported = canCache();
/** 当前集的缓存记录。 */
const cacheItem = ref<CacheItem | null>(null);
/** 是否正在缓存当前集 */
const caching = ref(false);
/** 缓存进度轮询定时器 */
let cacheTicker: ReturnType<typeof setInterval> | null = null;

/**
 * 离线播放信息。
 *
 * 已缓存完成时返回本地索引与目录，播放器据此**完全离线**播放；
 * 未缓存则为 null，走正常在线播放。
 * 注意要「响应式」：缓存完成或切集后需要重新求值。
 */
const offlineInfo = computed(() => {
    // 依赖 cacheItem 触发重算
    const item = cacheItem.value;
    if (!item || item.status !== 'done') return null;
    const collection = collections.value[currentIndex.value];
    if (!collection || collection.id !== item.collectionId) return null;

    const manifest = getCachedManifest(item.vodId, item.collectionId);
    if (!manifest) return null;

    return {
        key: item.key,
        dir: cacheDirOf(item.key),
        // 供播放器生成虚拟索引地址
        base: `local://${item.key}`,
        manifest,
        // 个别分片缺失时回落在线地址
        fallbackSrc: playStore.playUrl
    };
});

/** 缓存按钮文案。 */
const cacheText = computed(() => {
    const item = cacheItem.value;
    if (item && item.status === 'downloading') return '缓存中…';
    if (item && item.status === 'done') return '已缓存';
    if (item && item.status === 'error') return '重试缓存';
    return '缓存';
});

/** 缓存完成百分比。 */
const cachePercent = computed(() => {
    const item = cacheItem.value;
    if (!item || !item.total) return 0;
    return Math.min(Math.round((item.done / item.total) * 100), 100);
});

/** 刷新当前集的缓存状态。 */
function refreshCacheState() {
    const c = collections.value[currentIndex.value];
    if (!c) {
        cacheItem.value = null;
        caching.value = false;
        return;
    }
    cacheItem.value = getCacheItem(vodId.value, c.id);
    caching.value = cacheItem.value?.status === 'downloading';

    if (caching.value && !cacheTicker) {
        cacheTicker = setInterval(refreshCacheState, 700);
    } else if (!caching.value && cacheTicker) {
        clearInterval(cacheTicker);
        cacheTicker = null;
    }
}

/** 点缓存按钮：未缓存则开始，已缓存则提示，进行中则询问是否取消。 */
function onCacheTap() {
    const c = collections.value[currentIndex.value];
    if (!c) return;

    const item = cacheItem.value;

    if (item?.status === 'downloading') {
        uni.showModal({
            title: '取消缓存',
            content: '已下载的部分会保留，可在缓存页删除。确认取消？',
            success: res => {
                if (!res.confirm) return;
                cancelDownload(item.key);
                uni.showToast({ icon: 'none', title: '已取消' });
                setTimeout(refreshCacheState, 400);
            }
        });
        return;
    }

    if (item?.status === 'done') {
        uni.showToast({ icon: 'none', title: '该集已缓存，可离线观看' });
        return;
    }

    startCurrentCache(c);
}

/** 开始缓存当前集。 */
async function startCurrentCache(collection: Collection) {
    if (caching.value) return;

    // 需要该集的原始 m3u8 地址
    const url = collection.vod_url;
    if (!url) {
        uni.showToast({ icon: 'none', title: '该集没有可缓存的地址' });
        return;
    }

    caching.value = true;
    refreshCacheState();
    uni.showToast({ icon: 'none', title: '开始缓存，可继续观看' });

    const result = await startCache({
        vodId: vodId.value,
        vodName: vodName.value,
        vodPic: vodPic.value,
        collectionId: collection.id,
        collectionTitle: collection.title || `第${currentIndex.value + 1}集`,
        m3u8Url: url,
        onProgress: () => {
            // 进度由定时器刷新即可，这里不额外操作，避免频繁渲染
        }
    });

    caching.value = false;
    refreshCacheState();

    if (result.status === 'done') {
        uni.showToast({ icon: 'none', title: `缓存完成 ${formatSize(result.bytes)}` });
        // 缓存完成后立刻切到本地播放，验证离线可用
        playerRef.value?.showHint?.('已切换为离线播放');
        playerRef.value?.clearHint?.();
    } else {
        uni.showToast({ icon: 'none', title: result.error || '缓存失败' });
    }
}

/* ---------------- 全屏与播放状态 ---------------- */

/** 全屏按钮文案：区分「进全屏」与「退全屏」。 */
const fullscreenText = computed(() => (isLandscape.value ? '退出全屏' : '全屏'));

/**
 * 播放状态机。
 *
 * loading —— 加载中（含「详情尚未返回」与「正在解析片源」两种情形）
 * ready   —— 已拿到地址，播放器接管
 * error   —— 解析失败，展示原因与重试
 *
 * 注意：初始必须是 loading。若用布尔量表示「是否正在解析」，
 * 详情接口返回前的那段空窗期会被误判成失败，页面闪一下「片源不可用」。
 */
type PlayStatus = 'loading' | 'ready' | 'error';
const status = ref<PlayStatus>('loading');

/** 加载中的提示文案。 */
const loadingText = computed(() => {
    if (status.value === 'error') return '暂时无法播放';
    return vodName.value ? '正在加载视频' : '正在加载';
});

const vodId = ref(0);

/** 导航栏标题：优先剧名，未加载出来时退化为分集标题。 */
const navTitle = computed(() => vodName.value || episodeTitle.value || '播放');

/** 解析播放地址。 */
async function resolve() {
    status.value = 'loading';
    playStore.resolving = true;
    failReason.value = '';

    try {
        const current = collections.value[currentIndex.value];
        if (!current) {
            throw new Error('无可用剧集');
        }

        // 续播位置
        const progress = playStore.loadProgress(vodId.value, current.id);
        resumePosition.value = progress?.position || 0;

        const resolved = await resolvePlayUrl(vodId.value, current.id);

        log.info('片源已解析', resolved.url);

        /*
         * 注意：这里**不要**先 playStore.reset()。
         * reset 会清空 playUrl，使 v-if 判定为假、播放器被销毁重建 ——
         * 全屏状态下重建会丢掉 is-fs 却仍在横屏锁定中，卡成横屏小窗。
         * 切集的「黑一下」由播放器内部遮罩显式完成（见 switchEpisode）。
         */
        playStore.setResolved(resolved.url, resolved.backups);
        episodeTitle.value = current.title || resolved.title || '';
        status.value = 'ready';

        // 写入本地播放记录（换源后无需上报服务端）
        addHistory({
            vodId: vodId.value,
            vodName: vodName.value,
            vodPic: vodPic.value,
            collectionId: current.id,
            collectionTitle: episodeTitle.value,
            position: resumePosition.value,
            duration: 0
        });
    } catch (e) {
        failReason.value = (e as Error)?.message || '未知错误';
        log.error('片源解析失败', failReason.value);
        // 解析失败才清空，此时展示错误页而非留着上一集的画面
        playerRef.value?.clearHint?.();
        playStore.reset();
        status.value = 'error';
        uni.showToast({ icon: 'none', title: '加载失败，请稍后重试' });
    } finally {
        playStore.resolving = false;
    }
}

/** 加载影片详情（取剧集列表）。 */
async function loadDetail() {
    status.value = 'loading';
    try {
        const res = await getVodDetail(vodId.value);
        vodName.value = res?.vod_name || '';
        vodPic.value = res?.vod_pic || '';
        poster.value = res?.vod_pic || '';
        collections.value = res?.vod_collection || [];
        // 剧集列表就绪后才能判断当前集是否已缓存
        refreshCacheState();
        await resolve();
    } catch (e) {
        failReason.value = (e as Error)?.message || '影片信息加载失败';
        log.error('详情加载失败', failReason.value);
        status.value = 'error';
    }
}

/** 重新加载（失败后点「重新加载」）。 */
function reload() {
    if (collections.value.length === 0) {
        loadDetail();
    } else {
        resolve();
    }
}

/** 切换剧集。 */
function switchEpisode(item: Collection, index: number) {
    if (index === currentIndex.value && playStore.playUrl) return;
    currentIndex.value = index;
    // 内建面板由播放器自管，切集时通知它收起
    playerRef.value?.closeEpisodePanel?.();
    // 切集后缓存状态随之变化（可能切到已缓存的集）
    refreshCacheState();
    /*
     * 先把画面压黑、标出要切到第几集，再解析新片源。
     * 黑场是用户要的切换反馈；揭开时机由播放器决定 ——
     * 新源 playing 时自动揭开，避免解析慢时长时间黑屏。
     */
    playerRef.value?.showHint?.(`第 ${index + 1} 集`);
    resolve();
}

/** 切换备用线路。 */
function switchLine() {
    const ok = playStore.switchToBackup();
    if (!ok) {
        uni.showToast({ icon: 'none', title: '没有更多线路' });
    }
}

/** 切换全屏（进入/退出由播放器内部状态决定）。 */
function toggleFullscreen() {
    if (isLandscape.value) {
        playerRef.value?.exitFullscreen?.();
    } else {
        playerRef.value?.requestFullscreen?.();
    }
}

/** 在全屏内切换横竖屏。 */
function toggleOrientation() {
    playerRef.value?.toggleOrientation?.();
}

/** 播放器内部按钮切了全屏：同步按钮文案，并收起抽屉。 */
function onLandscapeChange(on: boolean) {
    isLandscape.value = on;
    if (!on) {
        isLandscapeLayout.value = true;
        // 退出全屏后选集列表就在下方，面板没有存在意义
        playerRef.value?.closeEpisodePanel?.();
    }
}

/** 播放器内部切了方向：同步按钮文案。 */
function onOrientationChange(dir: string) {
    isLandscapeLayout.value = dir !== 'portrait';
}

/**
 * 全屏内选集面板切集。
 *
 * 面板由播放器渲染层自绘，这里只负责按新下标切集 ——
 * 播放器收到新的 collections / currentIndex 后会自行刷新高亮。
 */
function onEpisodeChange(index: number) {
    const item = collections.value[index];
    if (!item) return;
    switchEpisode(item, index);
}

/** 播放进度变化：保存续播点。 */
function onTimeUpdate(payload: { currentTime: number; duration: number }) {
    // 每 5 秒落一次盘，避免频繁写存储
    if (Math.floor(payload.currentTime) % 5 !== 0) return;
    playStore.saveProgress(payload.currentTime, payload.duration);
}

/** 播放结束：自动下一集。 */
function onEnded() {
    const next = currentIndex.value + 1;
    if (next < collections.value.length) {
        switchEpisode(collections.value[next], next);
    }
}

/** 播放出错：尝试换线路，再失败则重新解析。 */
async function onPlayError(err: any) {
    log.error('播放出错', JSON.stringify(err), '当前地址', playStore.playUrl);

    if (playStore.switchToBackup()) {
        log.info('已切换备用线路', playStore.playUrl);
        return;
    }
    await resolve();
}

/**
 * 进入双人房间。
 *
 * 带上「正在看的影片 + 集数」，房间页据此成为房主；
 * 若此前已有未结束的房间（房主中途去挑片又回来），
 * 传 roomId 让房间页复用，观众不会掉线。
 */
function goRoom() {
    const params = [
        `vodId=${vodId.value}`,
        `index=${currentIndex.value}`,
        `fromPlay=1`
    ];

    const saved = loadActiveRoom();
    if (saved && saved.isHost && isRoomCode(saved.roomId)) {
        params.push(`roomId=${saved.roomId}`);
    }

    uni.navigateTo({ url: `/pages/room/room?${params.join('&')}` });
}

function goBack() {
    uni.navigateBack({ fail: () => uni.switchTab({ url: '/pages/index/index' }) });
}

/**
 * 返回键的优先顺序：先收面板，再退全屏，最后才离开页面。
 *
 * 不这样处理的话，面板开着按返回会直接退出全屏（甚至退出页面），
 * 用户会觉得「返回键没管住浮层」。
 *
 * 面板状态在渲染层，逻辑层取不到，故用「请它收起」的方式询问：
 * 播放器返回是否真的收起了，据此决定要不要吃掉这次返回。
 */
onBackPress(() => {
    if (playerRef.value?.closeEpisodePanel?.()) {
        return true;
    }
    if (isLandscape.value) {
        playerRef.value?.exitFullscreen?.();
        return true;
    }
    return false;
});

onLoad(options => {
    vodId.value = Number(options?.vodId || 0);
    currentIndex.value = Number(options?.index || 0);
    if (vodId.value) {
        loadDetail();
    } else {
        failReason.value = '缺少影片参数';
        status.value = 'error';
    }
});

onUnload(() => {
    // 退出前销毁播放器：解除全屏、还原系统方向 / 状态栏 / 屏幕亮度
    playerRef.value?.destroy?.();
    isLandscape.value = false;
    // 缓存进度轮询必须停掉，否则离开页面后仍在跑
    if (cacheTicker) {
        clearInterval(cacheTicker);
        cacheTicker = null;
    }
    playStore.reset();
});
</script>

<style lang="scss" scoped>
.play {
    /* 整页锁定视口高度：页面本身不滚动，滚动交给下方 scroll-view */
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: #0b0d10;

    /* 导航栏固定不滚动：flex: none 保证不会被下方内容挤压缩高 */
    &__nav {
        flex: none;
    }

    &__stage {
        position: relative;
        flex: none;
        width: 100%;
        background-color: #000;
    }

    &__stage-inner {
        position: relative;
        width: 100%;
        height: 420rpx;
    }

    &__player {
        width: 100%;
        height: 100%;
    }

    &__loading {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    &__loading-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    &__reason {
        margin-top: 12rpx;
        padding: 0 48rpx;
        font-size: 24rpx;
        color: #3d434e;
        text-align: center;
        line-height: 1.6;
    }

    &__retry {
        margin-top: 24rpx;
        padding: 12rpx 36rpx;
        border-radius: 32rpx;
        background-color: #1d2128;
    }

    &__retry-text {
        font-size: 26rpx;
        color: #f0a63c;
    }

    /* 唯一可滚动区域：height: 0 + flex: 1 才能在 flex 容器里正确收缩 */
    &__body {
        flex: 1;
        /* flex 子项默认 min-height: auto，不加这行会被内容撑开、页面整体变高 */
        min-height: 0;
        height: 0;
        width: 100%;
    }

    &__info {
        padding: 28rpx 24rpx 0;
    }

    &__title {
        display: block;
        font-size: 36rpx;
        font-weight: 700;
        color: #e8eaed;
    }

    &__subtitle {
        display: block;
        margin-top: 8rpx;
        font-size: 26rpx;
        color: #6b7280;
    }

    &__actions {
        display: flex;
        flex-wrap: wrap;
        margin-top: 28rpx;
    }

    &__action {
        height: 68rpx;
        padding: 0 32rpx;
        margin: 0 20rpx 20rpx 0;
        border-radius: 34rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: #1d2128;
    }

    &__action-text {
        font-size: 26rpx;
        color: #f0a63c;
        white-space: nowrap;
    }

    &__action-text--busy {
        color: #6b7280;
    }

    /* ---------- 缓存进度 ---------- */

    &__cache {
        margin-top: 4rpx;
    }

    &__cache-bar {
        height: 6rpx;
        border-radius: 3rpx;
        background-color: #1d2128;
        overflow: hidden;
    }

    &__cache-fill {
        height: 100%;
        border-radius: 3rpx;
        background-color: #f0a63c;
        transition: width 0.3s ease;
    }

    &__cache-text {
        display: block;
        margin-top: 10rpx;
        font-size: 22rpx;
        color: #6b7280;
        font-variant-numeric: tabular-nums;
    }

    &__offline {
        margin-top: 12rpx;
        padding: 8rpx 20rpx;
        align-self: flex-start;
        border-radius: 20rpx;
        background-color: #1d2128;
    }

    &__offline-text {
        font-size: 22rpx;
        color: #4b8b5a;
    }

    &__section {
        margin-top: 24rpx;
        padding: 0 24rpx;
    }

    &__section-title {
        display: block;
        font-size: 32rpx;
        font-weight: 600;
        color: #e8eaed;
        margin-bottom: 20rpx;
    }

    &__tail {
        height: calc(60rpx + env(safe-area-inset-bottom));
    }
}
</style>
