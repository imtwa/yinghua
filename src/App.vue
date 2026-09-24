<script setup lang="ts">
/**
 * 应用入口。
 *
 * 数据源为公开采集源（见 constants/source.ts），**无需登录与 token**，
 * 因此这里不再做任何接口预热。
 */

import { onLaunch } from '@dcloudio/uni-app';
import { createLogger } from '@/utils/logger';

const log = createLogger('app');

onLaunch(() => {
    log.info('映话启动');
});
</script>

<style lang="scss">
/* ============================================================
 * 全局基础样式
 * 影院暗色基调：近黑背景 + 琥珀金点缀
 * ============================================================ */

page {
    background-color: #0b0d10;
    color: #e8eaed;
    font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    /* 禁止整页橡皮筋回弹（App 端主要靠 pages.json 的 app-plus.bounce） */
    overscroll-behavior: none;
}

/* #ifdef H5 */
/* H5 端：禁止滚动链与回弹，避免页面滚到底后带动 body 弹动 */
html,
body {
    overscroll-behavior: none;
    /* 关闭移动端点击高亮 */
    -webkit-tap-highlight-color: transparent;
}

uni-page-body,
.uni-page-body {
    overscroll-behavior: none;
}
/* #endif */

/* 滚动容器统一隐藏滚动条 */
::-webkit-scrollbar {
    width: 0;
    height: 0;
    background: transparent;
}

/* ============================================================
 * 统一交互反馈
 *
 * 全站可点元素都挂 `.tap`。此前只有播放器与导航栏有按压反馈，
 * 其余页面的卡片 / 按钮 / 列表项点下去毫无变化 ——
 * 在真机上会被误判成「没点中」，是最影响手感的一处缺失。
 *
 * 用独立类而不是全局 `view:active`：后者会让滚动时的按住状态
 * 也整体变暗，观感很脏，必须显式声明才生效。
 *
 * `cursor: pointer` 不是给桌面端用的 ——
 * 部分 WebKit 内核只有在元素被判为「可交互」时才触发 :active。
 * ============================================================ */
.tap {
    cursor: pointer;
    /* 只做透明度与底色过渡，不改 transform，避免网格布局抖动 */
    transition: opacity 0.12s ease, background-color 0.12s ease;
}

.tap:active {
    opacity: 0.66;
}

/* 有底色的按钮/标签用加深底色代替整体变淡，观感更实 */
.tap-solid:active {
    opacity: 1;
    filter: brightness(1.28);
}

/*
 * 列表项整行可点时的通用样式。
 * 放在全局是因为「历史 / 缓存 / 我的」三处长列表完全同构，
 * 各自维护一份必然发散。
 */
.tap-row {
    cursor: pointer;
    transition: background-color 0.12s ease;
}

.tap-row:active {
    background-color: rgba(255, 255, 255, 0.05);
}
</style>
