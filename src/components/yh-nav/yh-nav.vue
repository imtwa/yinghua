<template>
    <view class="nav" :style="{ paddingTop: statusBarHeight + 'px' }">
        <view class="nav__bar">
            <!--
                返回键：箭头用纯 CSS 边框绘制，不用「‹」字符。
                字符箭头的问题：各机型字体不同，字号与基线都会漂，
                旋转 45° 的边框在任何设备上都是同一个形状。
                触控区 44×44，符合最小可点尺寸。
            -->
            <view v-if="showBack" class="nav__back" hover-class="nav__back--hover" @click="onBack">
                <view class="nav__arrow" />
            </view>
            <view v-else class="nav__back nav__back--ghost" />

            <text class="nav__title">{{ title }}</text>

            <view class="nav__right">
                <slot name="right" />
            </view>
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 自定义导航栏。
 *
 * 全局 navigationStyle 为 custom，各页统一用本组件，自动适配状态栏高度。
 *
 * 样式约定：
 *   · 底色用**不透明**深色而非半透明+模糊 —— App 端 WebView 对
 *     `backdrop-filter` 支持不稳，不支持时会变成一层灰雾，
 *     比纯色更难看。标题栏本来也不需要透出下方内容。
 *   · 返回箭头与右侧插槽固定同宽，标题才能精确居中。
 */

import { ref } from 'vue';

interface Props {
    title?: string;
    /** 是否显示返回按钮 */
    showBack?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    title: '',
    showBack: true
});

const emit = defineEmits<{ (e: 'back'): void }>();

const statusBarHeight = ref(uni.getSystemInfoSync().statusBarHeight || 0);

function onBack() {
    if (props.showBack) {
        emit('back');
        uni.navigateBack({ fail: () => uni.switchTab({ url: '/pages/index/index' }) });
    }
}
</script>

<style lang="scss" scoped>
.nav {
    /*
     * 保留 sticky：列表页（历史/收藏/缓存）滚动时导航栏要吸顶。
     * 注意父元素若有 overflow:hidden 会使其失效 ——
     * 用 `.play` 那种整页锁高的页面需自行给 flex:none。
     */
    position: sticky;
    top: 0;
    z-index: 100;
    background-color: #0b0d10;
    /* 与下方内容的分隔线：极淡，避免纯色块拼接显得生硬 */
    border-bottom: 1rpx solid rgba(255, 255, 255, 0.06);

    &__bar {
        height: 88rpx;
        display: flex;
        align-items: center;
        padding: 0 12rpx;
    }

    &__back {
        width: 88rpx;
        height: 88rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
    }

    &__back--hover {
        background-color: rgba(255, 255, 255, 0.08);
    }

    /* 无返回键时占位，保证标题在未显示返回键的页面上同样居中 */
    &__back--ghost {
        pointer-events: none;
    }

    /*
     * 箭头本体：一个旋转 45° 的方块，只留左边与下边的边框，
     * 视觉上就是「‹」。尺寸用 px 保证跨设备一致。
     */
    &__arrow {
        width: 16rpx;
        height: 16rpx;
        margin-left: 6rpx;
        border-left: 3rpx solid #e8eaed;
        border-bottom: 3rpx solid #e8eaed;
        border-radius: 2rpx;
        transform: rotate(45deg);
    }

    &__title {
        flex: 1;
        min-width: 0;
        font-size: 32rpx;
        font-weight: 600;
        letter-spacing: 0.5rpx;
        color: #e8eaed;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__right {
        width: 88rpx;
        min-height: 88rpx;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-shrink: 0;
    }
}
</style>
