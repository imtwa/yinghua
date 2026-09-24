<template>
    <KuRootView />
</template>

<script setup lang="ts">
/**
 * @uni-ku/root 的全局根组件。
 *
 * 插件在编译期把模板里的 <KuRootView /> 替换成 <slot />，
 * 因此这一行不能删 —— 它是页面内容的插槽位置。
 *
 * 注意：这里**不要加包裹元素**（如 <view class="app-root">）。
 * 该组件会套在「每个页面」外层，多包一层会让页面高度计算层层嵌套，
 * 表现为「接口有数据但页面渲染不出来」。
 * 全局背景色统一在 App.vue 的 page 选择器里设置。
 */
</script>
