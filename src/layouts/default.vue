<template>
    <slot />
</template>

<script setup lang="ts">
/**
 * 默认布局。
 *
 * 保持为「纯插槽」—— 不要在这里加包裹元素。
 * 页面外层容器由 App.ku.vue 统一提供，这里再包一层会导致
 * 高度层层嵌套、页面内容被挤成零高度（表现为白屏但有数据）。
 */
</script>
