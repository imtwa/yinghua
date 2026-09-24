<template>
    <view class="category">
        <yh-nav :title="title" :show-back="showBack" />

        <!-- 左侧频道栏 -->
        <view class="category__body">
            <scroll-view class="category__side" scroll-y :show-scrollbar="false" :bounce="false">
                <view
                    v-for="ch in channels"
                    :key="ch.id"
                    class="category__side-item tap-row"
                    :class="{ 'category__side-item--active': ch.channel_name === currentChannel.channel_name }"
                    @click="switchChannel(ch)">
                    <text class="category__side-text">{{ ch.channel_name }}</text>
                </view>
            </scroll-view>

            <!-- 右侧影片列表 -->
            <scroll-view class="category__main" scroll-y :show-scrollbar="false" :bounce="false">
                <view v-if="loading" class="category__tip">
                    <text class="category__tip-text">加载中</text>
                </view>

                <template v-else>
                    <view v-if="vods.length" class="category__grid">
                        <yh-vod-card
                            v-for="vod in vods"
                            :key="vod.id"
                            class="category__grid-item"
                            :vod="vod"
                            @click="goDetail" />
                    </view>
                    <yh-empty v-else text="该分类暂无内容" />

                    <view v-if="hasMore && vods.length" class="category__more tap" @click="loadMore">
                        <text class="category__more-text">{{ loadingMore ? '加载中' : '加载更多' }}</text>
                    </view>
                </template>
            </scroll-view>
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 分类页。
 *
 * 左侧频道 + 右侧影片宫格，分页加载。
 */

import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Channel, Vod } from '@/api/types';
import { getChannelInfo, getChannels } from '@/services/video';
import { HOME_SECTIONS } from '@/constants/source';

const channels = ref<Channel[]>([]);
/** 当前选中的分类对象（用对象而非 id，跨源才安全） */
const currentChannel = ref<Channel>({ id: 0, channel_name: '', vod_type_id: 0 });
const vods = ref<Vod[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const page = ref(1);
const hasMore = ref(true);
/** 已出现的影片 id，用于跨页去重 */
const seenIds = new Set<number>();
/** 从首页「更多」带进来的分类名 */
const presetChannelName = ref('');
/** 页面标题（带参时为分类名） */
const title = ref('分类');
/** 是否显示返回按钮（带参进入时才显示） */
const showBack = ref(false);

/** 从模块数据里拍平出影片列表。 */
function flattenVods(modules: any[]): Vod[] {
    const out: Vod[] = [];
    for (const mod of modules || []) {
        for (const block of mod.block_list || []) {
            if (block.vod_info) out.push(block.vod_info);
            for (const v of block.vod_list || []) {
                out.push(v);
            }
        }
    }
    return out;
}

async function loadChannels() {
    try {
        const list = await getChannels();
        channels.value = list || [];
        if (channels.value.length > 0) {
            /*
             * 带参进入时优先用指定分类，否则用第一个。
             *
             * 注意：这里选中的是**分类对象**而不是 id ——
             * 各源的 type_id 体系不同，把某个源的 id 拿去别的源查
             * 会取到毫不相干的分类（见 services/video.ts 的分类解析）。
             */
            const target = presetChannelName.value
                ? channels.value.find(c => c.channel_name === presetChannelName.value)
                : null;
            currentChannel.value = target || channels.value[0];
            await loadVods(true);
        }
    } finally {
        loading.value = false;
    }
}

/** 加载影片列表；reset 为 true 时重置分页。 */
async function loadVods(reset = false) {
    if (reset) {
        page.value = 1;
        vods.value = [];
        hasMore.value = true;
        seenIds.clear();
    }

    /*
     * 用分类名请求：跨源安全。
     * 服务端已把该分类**及其全部子类**聚合，并按更新时间倒序。
     */
    const list = await getChannelInfo(
        currentChannel.value.channel_name,
        page.value,
        aliasOf(currentChannel.value.channel_name)
    );
    const items = flattenVods(list);

    // 聚合分页下跨页可能重叠，按 id 去重
    const fresh = items.filter(v => {
        if (seenIds.has(v.id)) return false;
        seenIds.add(v.id);
        return true;
    });

    vods.value = reset ? fresh : vods.value.concat(fresh);

    // 聚合后每页条数不固定，不能用 `>= 20` 判断；本页返回 0 条才算到底
    hasMore.value = items.length > 0;
}

/** 取某分类在 HOME_SECTIONS 中配置的别名。 */
function aliasOf(name: string): string[] {
    const hit = HOME_SECTIONS.find(s => s.name === name);
    return hit?.alias || [];
}

function switchChannel(ch: Channel) {
    if (ch.channel_name === currentChannel.value.channel_name) return;
    currentChannel.value = ch;
    loading.value = true;
    loadVods(true).finally(() => {
        loading.value = false;
    });
}

async function loadMore() {
    if (loadingMore.value || !hasMore.value) return;
    loadingMore.value = true;
    page.value += 1;
    try {
        await loadVods(false);
    } finally {
        loadingMore.value = false;
    }
}

function goDetail(vod: Vod) {
    uni.navigateTo({ url: `/pages/detail/detail?id=${vod.id}` });
}

onLoad(options => {
    // 从首页栏目「更多」进入时带分类名（name）；id 仅作兼容，不参与跨源查询
    const presetName = options?.name ? decodeURIComponent(options.name) : '';

    if (presetName) {
        presetChannelName.value = presetName;
        title.value = presetName;
        showBack.value = true;
    }
    loadChannels();
});
</script>

<style lang="scss" scoped>
.category {
    /*
     * 整页锁高 + flex 纵向排列，内容区自动占满剩余高度。
     *
     * 原先用 `height: calc(100vh - 200rpx)` 硬编码减去导航栏 ——
     * 但导航栏真实高度是「状态栏(px) + 88rpx」，状态栏在不同机型
     * 相差 20~48px，这个 200rpx 必然对不齐：要么底部被切掉，
     * 要么留出一条空白。用 flex:1 让浏览器自己算就没有这个问题。
     *
     * 高度必须减去 `--window-bottom`（uni-app 注入的原生 tabBar 高度，
     * 非 tabBar 页为 0）。本页是 tabBar 页，若直接用 100vh，
     * 容器会比可视区高出约 50px —— 叠加 overflow:hidden 后，
     * 列表底部一截会被永久切掉且滚不到。
     */
    height: calc(100vh - var(--window-bottom, 0px));
    /* dvh 兜底：移动端浏览器地址栏收起/展开会改变 vh */
    height: calc(100dvh - var(--window-bottom, 0px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: #0b0d10;

    &__body {
        flex: 1;
        /* min-height:0 是必须的：flex 子项默认 min-height:auto，
           不加则内部 scroll-view 撑开后整页会被顶出去 */
        min-height: 0;
        display: flex;
    }

    &__side {
        width: 176rpx;
        height: 100%;
        background-color: #14171c;
    }

    &__side-item {
        height: 96rpx;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__side-item--active {
        background-color: #0b0d10;

        .category__side-text {
            color: #f0a63c;
            font-weight: 600;
        }
    }

    &__side-text {
        font-size: 26rpx;
        color: #c9ced6;
    }

    &__main {
        flex: 1;
        height: 100%;
    }

    &__tip {
        padding: 100rpx 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__tip-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    &__grid {
        display: flex;
        flex-wrap: wrap;
        padding: 24rpx;
    }

    &__grid-item {
        width: 31.3%;
        margin-right: 3%;
        margin-bottom: 32rpx;
    }

    &__grid-item:nth-child(3n) {
        margin-right: 0;
    }

    &__more {
        padding: 24rpx 0 48rpx;
        /* 底部安全区：滚到底时「加载更多」不被 iPhone 小黑条压住 */
        padding-bottom: calc(48rpx + env(safe-area-inset-bottom));
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__more-text {
        font-size: 26rpx;
        color: #f0a63c;
    }
}
</style>
