<template>
    <view class="episode-grid">
        <view
            v-for="(item, index) in collections"
            :key="item.id"
            class="episode-grid__item tap tap-solid"
            :class="{ 'episode-grid__item--active': index === currentIndex }"
            @click="emit('select', item, index)">
            <text class="episode-grid__text">{{ item.title || index + 1 }}</text>
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 剧集选择宫格。
 */

import type { Collection } from '@/api/types';

interface Props {
    collections: Collection[];
    /** 当前集索引 */
    currentIndex?: number;
}

withDefaults(defineProps<Props>(), { currentIndex: 0 });

const emit = defineEmits<{ (e: 'select', item: Collection, index: number): void }>();
</script>

<style lang="scss" scoped>
.episode-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 16rpx;

    &__item {
        min-width: 108rpx;
        height: 68rpx;
        padding: 0 20rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8rpx;
        background-color: #1d2128;
    }

    &__item--active {
        background-color: #f0a63c;

        .episode-grid__text {
            color: #0b0d10;
            font-weight: 600;
        }
    }

    &__text {
        font-size: 24rpx;
        color: #c9ced6;
    }
}
</style>
