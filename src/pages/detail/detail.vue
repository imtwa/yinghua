<template>
    <view class="detail">
        <yh-nav :title="vod?.vod_name || '详情'" />

        <view v-if="loading" class="detail__tip">
            <text class="detail__tip-text">加载中</text>
        </view>

        <template v-else-if="vod">
            <!-- 头部信息 -->
            <view class="detail__head">
                <image class="detail__poster" :src="vod.vod_pic" mode="aspectFill" />
                <view class="detail__meta">
                    <text class="detail__name">{{ vod.vod_name }}</text>
                    <text v-if="subText" class="detail__sub">{{ subText }}</text>
                    <text v-if="vod.vod_actors" class="detail__sub detail__sub--clamp">{{ vod.vod_actors }}</text>
                    <text v-if="vod.vod_director" class="detail__sub detail__sub--clamp">
                        导演：{{ vod.vod_director }}
                    </text>

                    <view class="detail__actions">
                        <view class="detail__btn detail__btn--primary tap tap-solid" @click="playFirst">
                            <text class="detail__btn-text detail__btn-text--primary">立即播放</text>
                        </view>
                        <view class="detail__btn tap tap-solid" @click="toggleFav">
                            <text class="detail__btn-text">{{ faved ? '已收藏' : '收藏' }}</text>
                        </view>
                    </view>
                </view>
            </view>

            <!-- 选集 -->
            <view v-if="collections.length" class="detail__section">
                <text class="detail__section-title">选集（{{ collections.length }}）</text>
                <yh-episode
                    class="detail__episodes"
                    :collections="collections"
                    :current-index="currentIndex"
                    @select="playEpisode" />
            </view>

            <!-- 简介 -->
            <view v-if="vod.vod_content" class="detail__section">
                <text class="detail__section-title">剧情简介</text>
                <text class="detail__content">{{ vod.vod_content }}</text>
            </view>
        </template>
    </view>
</template>

<script setup lang="ts">
/**
 * 影片详情页。
 *
 * 数据源：公开采集源（苹果CMS v10），详情接口已含剧集列表。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Collection, Vod } from '@/api/types';
import { getVodDetail } from '@/services/video';
import { isFavorite, toggleFavorite } from '@/services/user';

const vodId = ref(0);
const vod = ref<Vod | null>(null);
const collections = ref<Collection[]>([]);
const currentIndex = ref(0);
const loading = ref(true);
const faved = ref(false);

/** 副信息：年份 · 地区 · 分类 · 集数。 */
const subText = computed(() => {
    if (!vod.value) return '';
    const parts: string[] = [];
    if (vod.value.vod_year) parts.push(vod.value.vod_year);
    if (vod.value.vod_area) parts.push(vod.value.vod_area);
    if (vod.value.vod_remarks) parts.push(vod.value.vod_remarks);
    return parts.join(' · ');
});

async function loadDetail() {
    loading.value = true;
    try {
        const res = await getVodDetail(vodId.value);
        vod.value = res;
        collections.value = res?.vod_collection || [];
        faved.value = isFavorite(vodId.value);
    } catch {
        vod.value = null;
    } finally {
        loading.value = false;
    }
}

/** 切换收藏。 */
function toggleFav() {
    if (!vod.value) return;
    const now = toggleFavorite({
        vodId: vod.value.id,
        vodName: vod.value.vod_name,
        vodPic: vod.value.vod_pic,
        vodRemarks: vod.value.vod_remarks || ''
    });
    faved.value = now;
    uni.showToast({ icon: 'none', title: now ? '已收藏' : '已取消收藏' });
}

/** 跳到播放页。 */
function playEpisode(item: Collection, index: number) {
    currentIndex.value = index;
    uni.navigateTo({
        url: `/pages/play/play?vodId=${vodId.value}&collectionId=${item.id}&index=${index}`
    });
}

/** 播放第一集。 */
function playFirst() {
    if (collections.value.length === 0) {
        uni.showToast({ icon: 'none', title: '暂无可用剧集' });
        return;
    }
    playEpisode(collections.value[0], 0);
}

onLoad(options => {
    vodId.value = Number(options?.id || 0);
    if (vodId.value) {
        loadDetail();
    } else {
        loading.value = false;
    }
});
</script>

<style lang="scss" scoped>
.detail {
    min-height: 100vh;
    min-height: 100dvh;
    background-color: #0b0d10;
    /* 底部安全区：无 tabBar 的页面，末尾简介会被 iPhone 小黑条压住 */
    padding-bottom: calc(60rpx + env(safe-area-inset-bottom));

    &__tip {
        padding: 120rpx 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__tip-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    &__head {
        display: flex;
        padding: 24rpx;
    }

    &__poster {
        width: 240rpx;
        height: 336rpx;
        border-radius: 12rpx;
        background-color: #1d2128;
        flex-shrink: 0;
    }

    &__meta {
        flex: 1;
        margin-left: 24rpx;
        /* 关键：允许收缩，避免长文本把容器撑破 */
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    &__name {
        font-size: 38rpx;
        font-weight: 700;
        color: #e8eaed;
        /* 片名最多两行 */
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
    }

    &__sub {
        margin-top: 10rpx;
        font-size: 24rpx;
        color: #6b7280;
        line-height: 1.5;
    }

    /* 演员/导演过多时限制两行，超出省略 */
    &__sub--clamp {
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
    }

    &__actions {
        display: flex;
        margin-top: 24rpx;
    }

    &__btn {
        height: 68rpx;
        padding: 0 32rpx;
        margin-right: 20rpx;
        border-radius: 34rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: #1d2128;
        /* 按钮不因内容过长而变形 */
        flex-shrink: 0;
    }

    &__btn--primary {
        background-color: #f0a63c;
    }

    &__btn-text {
        font-size: 28rpx;
        color: #c9ced6;
        white-space: nowrap;
    }

    &__btn-text--primary {
        color: #0b0d10;
        font-weight: 600;
    }

    &__section {
        margin-top: 32rpx;
        padding: 0 24rpx;
    }

    &__section-title {
        display: block;
        font-size: 32rpx;
        font-weight: 600;
        color: #e8eaed;
        margin-bottom: 20rpx;
    }

    &__content {
        font-size: 26rpx;
        line-height: 1.7;
        color: #c9ced6;
    }
}
</style>
