<template>
    <view class="catlist">
        <yh-nav :title="title" />

        <view class="catlist__bar">
            <scroll-view class="catlist__tabs" scroll-x :show-scrollbar="false" :bounce="false">
                <view
                    v-for="ch in channels"
                    :key="ch.id"
                    class="catlist__tab tap tap-solid"
                    :class="{ 'catlist__tab--active': ch.channel_name === currentName }"
                    @click="switchTo(ch)">
                    <text class="catlist__tab-text">{{ ch.channel_name }}</text>
                </view>
            </scroll-view>
        </view>

        <scroll-view class="catlist__main" scroll-y :show-scrollbar="false" :bounce="false">
            <view v-if="loading" class="catlist__tip">
                <text class="catlist__tip-text">加载中</text>
            </view>

            <template v-else>
                <view v-if="vods.length" class="catlist__grid">
                    <yh-vod-card
                        v-for="vod in vods"
                        :key="vod.id"
                        class="catlist__grid-item"
                        :vod="vod"
                        @click="goDetail" />
                </view>
                <yh-empty v-else text="该分类暂无内容" />

                <view v-if="hasMore && vods.length" class="catlist__more tap" @click="loadMore">
                    <text class="catlist__more-text">{{ loadingMore ? '加载中' : '加载更多' }}</text>
                </view>
            </template>
        </scroll-view>
    </view>
</template>

<script setup lang="ts">
/**
 * 分类影片列表页。
 *
 * 与「分类」tab 页的区别：
 *   - 本页为普通页面（navigateTo 打开），支持从首页栏目「更多」带参进入
 *   - 顶部为横向分类标签，非左侧竖栏，适合长列表浏览
 */

import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Channel, Vod } from '@/api/types';
import { getChannelInfo, getChannels } from '@/services/video';
import { HOME_SECTIONS } from '@/constants/source';

const channels = ref<Channel[]>([]);
/** 当前分类名（用名字而非 id，跨源才安全） */
const currentName = ref('');
/** 当前分类的别名（供源端命名差异兜底） */
const currentAlias = ref<string[]>([]);
const vods = ref<Vod[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const page = ref(1);
const hasMore = ref(true);
const title = ref('影片列表');
/** 已出现的影片 id，用于跨页去重 */
const seenIds = new Set<number>();

/** 从模块结果里拍平出影片列表。 */
function flatten(modules: any[]): Vod[] {
    const out: Vod[] = [];
    for (const mod of modules || []) {
        for (const block of mod.block_list || []) {
            for (const v of block.vod_list || []) {
                out.push(v);
            }
        }
    }
    return out;
}

async function loadVods(reset = false) {
    if (reset) {
        page.value = 1;
        vods.value = [];
        hasMore.value = true;
        seenIds.clear();
    }

    /*
     * 用分类名请求：跨源安全。
     * 服务端已把该分类**及其全部子类**聚合，并按更新时间倒序，
     * 所以每次翻页拿到的都是「更早更新」的内容。
     */
    const list = await getChannelInfo(currentName.value, page.value, currentAlias.value);
    const items = flatten(list);

    // 聚合分页下每页条数不固定，跨页可能重叠，这里按 id 去重
    const fresh = items.filter(v => {
        if (seenIds.has(v.id)) return false;
        seenIds.add(v.id);
        return true;
    });

    vods.value = reset ? fresh : vods.value.concat(fresh);

    /*
     * 聚合每页通常远多于 20 条，不能再用 `>= 20` 判断到底。
     * 判据改为：本页返回 0 条才算到底。
     */
    hasMore.value = items.length > 0;
}

async function switchTo(ch: Channel) {
    if (ch.channel_name === currentName.value) return;
    currentName.value = ch.channel_name;
    currentAlias.value = aliasOf(ch.channel_name);
    title.value = ch.channel_name;
    loading.value = true;
    loadVods(true).finally(() => {
        loading.value = false;
    });
}

/** 取某分类在 HOME_SECTIONS 中配置的别名。 */
function aliasOf(name: string): string[] {
    const hit = HOME_SECTIONS.find(s => s.name === name);
    return hit?.alias || [];
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
    const presetName = options?.name ? decodeURIComponent(options.name) : '';

    if (presetName) title.value = presetName;

    (async () => {
        try {
            const list = await getChannels();
            channels.value = list || [];
            if (channels.value.length === 0) {
                loading.value = false;
                return;
            }
            /*
             * 优先用带进来的分类名；否则退回第一个分类。
             * 这里按 name 定位而不是 id —— 各源的 type_id 体系不同，
             * 拿 A 源的 id 去 B 源查会取到无关分类。
             */
            const target = presetName ? channels.value.find(c => c.channel_name === presetName) : null;
            const picked = target || channels.value[0];
            currentName.value = picked.channel_name;
            currentAlias.value = aliasOf(picked.channel_name);
            title.value = currentName.value;
            await loadVods(true);
        } finally {
            loading.value = false;
        }
    })();
});
</script>

<style lang="scss" scoped>
.catlist {
    /*
     * 整页锁高 + flex 纵向排列：导航栏、分类标签栏自然占位，
     * 影片列表占满剩余高度并在内部滚动。
     *
     * 原先 main 用 `height: calc(100vh - 260rpx)` 硬编码 ——
     * 但导航栏真实高度含状态栏（机型间差 20~48px），
     * 这个数字必然对不齐，滚动区底部会被切掉一截。
     *
     * 同样减去 `--window-bottom`：本页虽是普通页（该值为 0），
     * 但从 tabBar 页跳进来时它可能非 0，写上更稳妥。
     */
    height: calc(100vh - var(--window-bottom, 0px));
    height: calc(100dvh - var(--window-bottom, 0px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: #0b0d10;

    &__bar {
        flex: none;
        background-color: #0b0d10;
        padding: 4rpx 0 12rpx;
    }

    &__tabs {
        white-space: nowrap;
        padding: 0 24rpx;
    }

    &__tab {
        display: inline-block;
        padding: 8rpx 28rpx;
        margin-right: 12rpx;
        border-radius: 28rpx;
        background-color: #1d2128;
    }

    &__tab--active {
        background-color: #f0a63c;

        .catlist__tab-text {
            color: #0b0d10;
            font-weight: 600;
        }
    }

    &__tab-text {
        font-size: 26rpx;
        color: #c9ced6;
    }

    &__main {
        flex: 1;
        /* 不加会被内容撑开、整页被顶出视口（flex 子项默认 min-height:auto） */
        min-height: 0;
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
        padding: 12rpx 24rpx 0;
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
