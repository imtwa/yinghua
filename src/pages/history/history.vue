<template>
    <view class="history">
        <yh-nav title="观看历史">
            <template #right>
                <text v-if="list.length" class="history__clear tap" @click="onClear">清空</text>
            </template>
        </yh-nav>

        <view v-if="!list.length" class="history__empty">
            <yh-empty text="还没有观看记录" />
        </view>

        <view v-else class="history__list">
            <view v-for="item in list" :key="item.vodId" class="history__item tap-row" @click="play(item)">
                <view class="history__poster">
                    <image class="history__img" :src="item.vodPic" mode="aspectFill" lazy-load />
                    <!-- 进度条：让用户一眼看到看到哪了 -->
                    <view v-if="progressOf(item) > 0" class="history__bar">
                        <view class="history__bar-fill" :style="{ width: progressOf(item) + '%' }" />
                    </view>
                </view>

                <view class="history__info">
                    <text class="history__name">{{ item.vodName }}</text>
                    <text class="history__sub">{{ item.collectionTitle || '第 1 集' }}</text>
                    <text class="history__time">{{ timeText(item.updatedAt) }}</text>
                </view>

                <view class="history__remove tap" @click.stop="onRemove(item)">
                    <text class="history__remove-text">删除</text>
                </view>
            </view>
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 观看历史。
 *
 * 数据来自 `services/user.ts` 的本地存储（按更新时间倒序），
 * 点击条目会带着「看到的集数」直接续播。
 */

import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { clearHistory, getHistory, removeHistory, type HistoryItem } from '@/services/user';
import { useUserStore } from '@/stores/user';

const userStore = useUserStore();
const list = ref<HistoryItem[]>([]);

/** 观看进度百分比（0~100）。 */
function progressOf(item: HistoryItem): number {
    if (!item.duration || item.duration <= 0) return 0;
    const pct = (item.position / item.duration) * 100;
    // 不足 1% 不显示，避免出现一条几乎不可见的线
    return pct < 1 ? 0 : Math.min(pct, 100);
}

/** 相对时间文案。 */
function timeText(ts: number): string {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    return new Date(ts).toLocaleDateString();
}

/** 续播：带上集数序号（collectionId 从 1 开始，与播放页一致）。 */
function play(item: HistoryItem) {
    uni.navigateTo({
        url: `/pages/play/play?vodId=${item.vodId}&index=${Math.max(item.collectionId - 1, 0)}`
    });
}

function onRemove(item: HistoryItem) {
    removeHistory(item.vodId);
    list.value = getHistory();
    userStore.refresh();
}

function onClear() {
    uni.showModal({
        title: '清空观看历史',
        content: '清空后无法恢复，确认继续？',
        success: res => {
            if (!res.confirm) return;
            clearHistory();
            list.value = [];
            userStore.refresh();
            uni.showToast({ icon: 'none', title: '已清空' });
        }
    });
}

// 每次显示都刷新：可能刚从播放页返回，记录已更新
onShow(() => {
    list.value = getHistory();
    userStore.refresh();
});
</script>

<style lang="scss" scoped>
.history {
    min-height: 100vh;
    /* dvh 兜底：移动端地址栏收起/展开会改变 vh */
    min-height: 100dvh;
    background-color: #0b0d10;

    &__clear {
        font-size: 26rpx;
        color: #f0a63c;
    }

    &__empty {
        padding-top: 80rpx;
    }

    &__list {
        padding: 8rpx 24rpx 60rpx;
        /* 底部安全区：无 tabBar 的页面，最后一条会被 iPhone 小黑条压住 */
        padding-bottom: calc(60rpx + env(safe-area-inset-bottom));
    }

    &__item {
        display: flex;
        align-items: center;
        padding: 20rpx 0;
        border-bottom: 1rpx solid #16191f;
    }

    &__poster {
        position: relative;
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

    &__bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 6rpx;
        background-color: rgba(255, 255, 255, 0.24);
    }

    &__bar-fill {
        height: 100%;
        background-color: #f0a63c;
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
        margin-top: 8rpx;
        font-size: 24rpx;
        color: #f0a63c;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__time {
        display: block;
        margin-top: 6rpx;
        font-size: 22rpx;
        color: #6b7280;
    }

    &__remove {
        padding: 10rpx 20rpx;
        flex-shrink: 0;
    }

    &__remove-text {
        font-size: 24rpx;
        color: #6b7280;
    }
}
</style>
