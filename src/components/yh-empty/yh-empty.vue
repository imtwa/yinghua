<template>
    <view class="empty">
        <text class="empty__text">{{ text }}</text>
    </view>
</template>

<script setup lang="ts">
/** 空状态占位。 */

interface Props {
    text?: string;
}

withDefaults(defineProps<Props>(), { text: '暂无内容' });
</script>

<style lang="scss" scoped>
.empty {
    padding: 120rpx 0;
    display: flex;
    align-items: center;
    justify-content: center;

    &__text {
        font-size: 26rpx;
        color: #6b7280;
    }
}
</style>
