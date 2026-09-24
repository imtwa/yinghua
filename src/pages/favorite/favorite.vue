<template>
    <view class="favorite">
        <yh-nav title="我的收藏">
            <template #right>
                <text v-if="favorites.length" class="favorite__clear tap" @click="onClear">清空</text>
            </template>
        </yh-nav>

        <view v-if="!favorites.length" class="favorite__empty">
            <yh-empty text="还没有收藏任何影片" />
        </view>

        <template v-else>
            <!-- 批量模式入口：长按或点右上角进入 -->
            <view class="favorite__bar">
                <text class="favorite__count">共 {{ favorites.length }} 部</text>
                <text class="favorite__toggle tap" @click="toggleEdit">
                    {{ editing ? '完成' : '管理' }}
                </text>
            </view>

            <view class="favorite__grid">
                <view
                    v-for="item in favorites"
                    :key="item.vodId"
                    class="favorite__cell tap"
                    @click="onCellTap(item)">
                    <yh-vod-card class="favorite__card" :vod="asVod(item)" />
                    <view v-if="editing" class="favorite__mask" @click.stop="onRemove(item)">
                        <text class="favorite__mask-text">移除</text>
                    </view>
                </view>
            </view>
        </template>
    </view>
</template>

<script setup lang="ts">
/**
 * 我的收藏。
 *
 * 数据来自 `services/user.ts` 的本地存储。
 * 「管理」模式下点卡片会移除收藏，避免误触。
 */

import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { Vod } from '@/api/types';
import { clearFavorites, getFavorites, toggleFavorite, type FavoriteItem } from '@/services/user';
import { useUserStore } from '@/stores/user';

const userStore = useUserStore();
const favorites = ref<FavoriteItem[]>([]);
const editing = ref(false);

/** 收藏条目转成卡片需要的形状（只用到展示字段）。 */
function asVod(item: FavoriteItem): Vod {
    return {
        id: item.vodId,
        vod_id: item.vodId,
        vod_name: item.vodName,
        vod_pic: item.vodPic,
        vod_year: '',
        vod_serial: '',
        vod_actors: '',
        vod_area: '',
        vod_lang: '',
        vod_remarks: item.vodRemarks,
        vod_score: '',
        vod_content: '',
        vod_total: 0,
        type_pid: 0
    };
}

function toggleEdit() {
    editing.value = !editing.value;
}

/** 非管理模式：进入详情页。 */
function onCellTap(item: FavoriteItem) {
    if (editing.value) return;
    uni.navigateTo({ url: `/pages/detail/detail?id=${item.vodId}` });
}

function onRemove(item: FavoriteItem) {
    toggleFavorite({
        vodId: item.vodId,
        vodName: item.vodName,
        vodPic: item.vodPic,
        vodRemarks: item.vodRemarks
    });
    favorites.value = getFavorites();
    userStore.refresh();
    if (favorites.value.length === 0) editing.value = false;
}

function onClear() {
    uni.showModal({
        title: '清空收藏',
        content: '清空后无法恢复，确认继续？',
        success: res => {
            if (!res.confirm) return;
            clearFavorites();
            favorites.value = [];
            editing.value = false;
            userStore.refresh();
            uni.showToast({ icon: 'none', title: '已清空' });
        }
    });
}

onShow(() => {
    favorites.value = getFavorites();
    userStore.refresh();
});
</script>

<style lang="scss" scoped>
.favorite {
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

    &__bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16rpx 24rpx 4rpx;
    }

    &__count {
        font-size: 24rpx;
        color: #6b7280;
    }

    &__toggle {
        font-size: 26rpx;
        color: #f0a63c;
    }

    &__grid {
        display: flex;
        flex-wrap: wrap;
        padding: 16rpx 24rpx 60rpx;
        /* 底部安全区：最后一行海报会被 iPhone 小黑条压住 */
        padding-bottom: calc(60rpx + env(safe-area-inset-bottom));
    }

    &__cell {
        position: relative;
        width: 31.3%;
        margin-right: 3%;
        margin-bottom: 32rpx;
    }

    &__cell:nth-child(3n) {
        margin-right: 0;
    }

    &__card {
        width: 100%;
    }

    &__mask {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        /* 只盖住海报区（3:4 中的 3 份），下方标题仍可辨识 */
        padding-top: 133%;
        border-radius: 12rpx;
        overflow: hidden;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__mask-text {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 8rpx 24rpx;
        border-radius: 24rpx;
        font-size: 24rpx;
        color: #0b0d10;
        background-color: #f0a63c;
    }
}
</style>
