<template>
    <view class="cache">
        <yh-nav title="离线缓存">
            <template #right>
                <text v-if="list.length" class="cache__clear tap" @click="onClearAll">清空</text>
            </template>
        </yh-nav>

        <!-- 平台提示：网页端存储空间很小，装不下一部影片 -->
        <view v-if="!supported" class="cache__notice">
            <text class="cache__notice-text">
                离线缓存目前只在手机 App 里可用。网页端能占用的存储空间太小，装不下一部影片。
            </text>
        </view>

        <template v-else>
            <view v-if="totalBytes > 0" class="cache__summary">
                <text class="cache__summary-text">
                    共 {{ doneCount }} 集 · 占用 {{ sizeText }}
                </text>
            </view>

            <view v-if="!list.length" class="cache__empty">
                <yh-empty text="还没有缓存任何影片" />
            </view>

            <view v-else class="cache__list">
                <view v-for="item in list" :key="item.key" class="cache__item">
                    <view class="cache__poster">
                        <image class="cache__img" :src="item.vodPic" mode="aspectFill" lazy-load />
                    </view>

                    <view class="cache__info">
                        <text class="cache__name">{{ item.vodName }}</text>
                        <text class="cache__sub">{{ item.collectionTitle || '第 1 集' }}</text>

                        <!-- 进行中：显示进度与网速无关的完成度 -->
                        <view v-if="item.status === 'downloading'" class="cache__progress">
                            <view class="cache__bar">
                                <view
                                    class="cache__bar-fill"
                                    :style="{ width: percentOf(item) + '%' }" />
                            </view>
                            <text class="cache__status">
                                {{ percentOf(item) }}% · {{ formatSize(item.bytes) }}
                            </text>
                        </view>

                        <text v-else-if="item.status === 'done'" class="cache__status cache__status--ok">
                            已完成 · {{ formatSize(item.bytes) }}
                        </text>

                        <text v-else class="cache__status cache__status--err">
                            {{ item.error || '下载失败' }} · {{ percentOf(item) }}%
                        </text>
                    </view>

                    <view class="cache__ops">
                        <view v-if="item.status === 'downloading'" class="cache__op tap tap-solid" @click="onCancel(item)">
                            <text class="cache__op-text">取消</text>
                        </view>
                        <template v-else>
                            <view v-if="item.status === 'done'" class="cache__op tap tap-solid" @click="onPlay(item)">
                                <text class="cache__op-text cache__op-text--primary">播放</text>
                            </view>
                            <view v-else class="cache__op tap tap-solid" @click="onRetry(item)">
                                <text class="cache__op-text cache__op-text--primary">重试</text>
                            </view>
                            <view class="cache__op tap tap-solid" @click="onRemove(item)">
                                <text class="cache__op-text">删除</text>
                            </view>
                        </template>
                    </view>
                </view>
            </view>
        </template>
    </view>
</template>

<script setup lang="ts">
/**
 * 离线缓存管理。
 *
 * 缓存内容存放在应用沙箱 `_doc/yinghua_cache/<key>/`，
 * 本页只负责展示与增删；下载逻辑在 `services/download.ts`。
 *
 * 播放走「本地优先」：已缓存完成的集在播放页会直接被播放器
 * 从沙箱读取，不再请求网络。
 */

import { computed, ref } from 'vue';
import { onShow, onUnload } from '@dcloudio/uni-app';
import {
    canCache,
    cancelDownload,
    clearAllCache,
    formatSize,
    getCacheList,
    removeCache,
    startCache,
    type CacheItem
} from '@/services/download';
import { getVodDetail } from '@/services/video';
import { useUserStore } from '@/stores/user';

const userStore = useUserStore();
const list = ref<CacheItem[]>([]);
const supported = canCache();
/** 正在重试的条目 key */
const retrying = ref('');

/** 下载中的任务会频繁刷新列表，用一个定时器驱动 */
let ticker: ReturnType<typeof setInterval> | null = null;

const doneCount = computed(() => list.value.filter(i => i.status === 'done').length);
const totalBytes = computed(() => list.value.reduce((sum, i) => sum + (i.bytes || 0), 0));
const sizeText = computed(() => formatSize(totalBytes.value));

/** 完成百分比。 */
function percentOf(item: CacheItem): number {
    if (!item.total) return 0;
    return Math.min(Math.round((item.done / item.total) * 100), 100);
}

function refresh() {
    list.value = getCacheList();
    userStore.refresh();
}

/** 有正在下载的任务时才需要轮询。 */
function syncTicker() {
    const busy = list.value.some(i => i.status === 'downloading');
    if (busy && !ticker) {
        ticker = setInterval(refresh, 700);
    } else if (!busy && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

function onPlay(item: CacheItem) {
    if (!item.vodId || !item.collectionId) return;
    uni.navigateTo({
        url: `/pages/play/play?vodId=${item.vodId}&index=${Math.max(item.collectionId - 1, 0)}`
    });
}

/**
 * 重试失败的缓存。
 *
 * 需要重新解析该集的 m3u8 地址 —— 失败记录里没存播放地址
 * （存了会随源变化失效），所以这里回到详情取一次。
 */
async function onRetry(item: CacheItem) {
    if (retrying.value === item.key) return;
    retrying.value = item.key;
    try {
        const detail = await getVodDetail(item.vodId);
        const collections = detail?.vod_collection || [];
        const target = collections.find(c => c.id === item.collectionId);
        if (!target || !target.vod_url) {
            uni.showToast({ icon: 'none', title: '该集已不可用' });
            return;
        }

        // 重新开始：先清掉旧的半成品，避免残留文件造成误判
        await removeCache(item.key);
        refresh();

        const result = await startCache({
            vodId: item.vodId,
            vodName: item.vodName || detail?.vod_name || '',
            vodPic: item.vodPic || detail?.vod_pic || '',
            collectionId: item.collectionId,
            collectionTitle: item.collectionTitle || target.title || '',
            m3u8Url: target.vod_url
        });

        uni.showToast({
            icon: 'none',
            title: result.status === 'done' ? '缓存完成' : result.error || '缓存失败'
        });
    } catch (e) {
        uni.showToast({ icon: 'none', title: (e as Error)?.message || '重试失败' });
    } finally {
        retrying.value = '';
        refresh();
        syncTicker();
    }
}

function onCancel(item: CacheItem) {
    cancelDownload(item.key);
    uni.showToast({ icon: 'none', title: '已取消' });
    setTimeout(refresh, 400);
}

function onRemove(item: CacheItem) {
    uni.showModal({
        title: '删除缓存',
        content: `删除《${item.vodName}》${item.collectionTitle || ''}的本地文件？`,
        success: async res => {
            if (!res.confirm) return;
            await removeCache(item.key);
            refresh();
            syncTicker();
            uni.showToast({ icon: 'none', title: '已删除' });
        }
    });
}

function onClearAll() {
    uni.showModal({
        title: '清空缓存',
        content: '将删除全部本地影片文件，确认继续？',
        success: async res => {
            if (!res.confirm) return;
            await clearAllCache();
            refresh();
            syncTicker();
            uni.showToast({ icon: 'none', title: '已清空' });
        }
    });
}

onShow(() => {
    refresh();
    syncTicker();
});

onUnload(() => {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
});

// startCache / isDownloading 由播放页使用，这里保留引用以便后续扩展「重试」用
void startCache;
void isDownloading;
</script>

<style lang="scss" scoped>
.cache {
    min-height: 100vh;
    /* dvh 兜底：移动端地址栏收起/展开会改变 vh */
    min-height: 100dvh;
    background-color: #0b0d10;

    &__clear {
        font-size: 26rpx;
        color: #f0a63c;
    }

    &__notice {
        margin: 24rpx;
        padding: 24rpx;
        border-radius: 12rpx;
        background-color: #14171c;
    }

    &__notice-text {
        font-size: 24rpx;
        line-height: 1.7;
        color: #6b7280;
    }

    &__summary {
        padding: 20rpx 24rpx 4rpx;
    }

    &__summary-text {
        font-size: 24rpx;
        color: #6b7280;
    }

    &__empty {
        padding-top: 80rpx;
    }

    &__list {
        padding: 8rpx 24rpx 60rpx;
        /* 底部安全区：最后一条缓存会被 iPhone 小黑条压住 */
        padding-bottom: calc(60rpx + env(safe-area-inset-bottom));
    }

    &__item {
        display: flex;
        align-items: center;
        padding: 20rpx 0;
        border-bottom: 1rpx solid #16191f;
    }

    &__poster {
        width: 200rpx;
        height: 120rpx;
        border-radius: 10rpx;
        overflow: hidden;
        background-color: #1d2128;
        flex-shrink: 0;
    }

    &__img {
        width: 100%;
        height: 100%;
    }

    &__info {
        flex: 1;
        min-width: 0;
        margin-left: 20rpx;
    }

    &__name {
        display: block;
        font-size: 28rpx;
        color: #e8eaed;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__sub {
        display: block;
        margin-top: 6rpx;
        font-size: 24rpx;
        color: #c9ced6;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__progress {
        margin-top: 10rpx;
    }

    &__bar {
        height: 6rpx;
        border-radius: 3rpx;
        background-color: #1d2128;
        overflow: hidden;
    }

    &__bar-fill {
        height: 100%;
        border-radius: 3rpx;
        background-color: #f0a63c;
        transition: width 0.3s ease;
    }

    &__status {
        display: block;
        margin-top: 6rpx;
        font-size: 22rpx;
        color: #6b7280;
        font-variant-numeric: tabular-nums;
    }

    &__status--ok {
        color: #4b8b5a;
    }

    &__status--err {
        color: #b4534b;
    }

    &__ops {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        flex-shrink: 0;
        margin-left: 12rpx;
    }

    &__op {
        padding: 6rpx 18rpx;
        margin-bottom: 8rpx;
        border-radius: 22rpx;
        background-color: #1d2128;
    }

    &__op-text {
        font-size: 24rpx;
        color: #c9ced6;
        white-space: nowrap;
    }

    &__op-text--primary {
        color: #f0a63c;
    }
}
</style>
