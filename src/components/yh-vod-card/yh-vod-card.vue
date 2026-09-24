<template>
    <view class="vod-card tap" @click="onClick">
        <view class="vod-card__poster">
            <image class="vod-card__img" :src="vod.vod_pic" mode="aspectFill" lazy-load />
            <view v-if="vod.vod_remarks" class="vod-card__badge">
                <text class="vod-card__badge-text">{{ vod.vod_remarks }}</text>
            </view>
        </view>
        <view class="vod-card__info">
            <text class="vod-card__name">{{ vod.vod_name }}</text>
            <text v-if="showMeta" class="vod-card__meta">{{ metaText }}</text>
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 影片卡片。
 *
 * 两种布局：
 * - 竖版（默认）：海报 3:4，用于宫格列表
 * - 横版：海报 16:9，用于横向滑动推荐位
 */

import { computed } from 'vue';
import type { Vod } from '@/api/types';

interface Props {
    vod: Vod;
    /** 是否横版（16:9） */
    horizontal?: boolean;
    /** 是否显示年份/集数等副信息 */
    showMeta?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    horizontal: false,
    showMeta: true
});

const emit = defineEmits<{ (e: 'click', vod: Vod): void }>();

/** 副信息：年份 · 集数 · 评分。 */
const metaText = computed(() => {
    const parts: string[] = [];
    if (props.vod.vod_year) parts.push(props.vod.vod_year);
    if (props.vod.vod_serial) parts.push(`全${props.vod.vod_serial}集`);
    if (props.vod.vod_score && props.vod.vod_score !== '0.0') parts.push(`${props.vod.vod_score}分`);
    return parts.join(' · ');
});

function onClick() {
    emit('click', props.vod);
}
</script>

<style lang="scss" scoped>
.vod-card {
    display: flex;
    flex-direction: column;

    &__poster {
        position: relative;
        width: 100%;
        padding-top: 133%; // 3:4 竖版
        border-radius: 12rpx;
        overflow: hidden;
        background-color: #1d2128;
    }

    &__img {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
    }

    &__badge {
        position: absolute;
        right: 8rpx;
        bottom: 8rpx;
        padding: 2rpx 10rpx;
        border-radius: 6rpx;
        background-color: rgba(0, 0, 0, 0.65);
    }

    &__badge-text {
        font-size: 20rpx;
        color: #f0a63c;
    }

    &__info {
        margin-top: 12rpx;
    }

    &__name {
        display: block;
        font-size: 26rpx;
        color: #e8eaed;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__meta {
        display: block;
        margin-top: 4rpx;
        font-size: 22rpx;
        color: #6b7280;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }
}
</style>
