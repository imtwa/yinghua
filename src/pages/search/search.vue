<template>
    <view class="search">
        <yh-nav title="搜索" />

        <view class="search__bar">
            <input
                v-model="keyword"
                class="search__input"
                type="text"
                placeholder="输入影片名、演员"
                placeholder-class="search__placeholder"
                confirm-type="search"
                :focus="true"
                @confirm="doSearch" />
            <view class="search__btn tap" @click="doSearch">
                <text class="search__btn-text">搜索</text>
            </view>
        </view>

        <!-- 热搜 -->
        <view v-if="!searched && hotWords.length" class="search__section">
            <text class="search__section-title">热门搜索</text>
            <view class="search__tags">
                <view v-for="(w, i) in hotWords" :key="i" class="search__tag tap tap-solid" @click="searchWord(w.name)">
                    <text class="search__tag-text">{{ w.name }}</text>
                </view>
            </view>
        </view>

        <!-- 搜索中 -->
        <view v-if="searching" class="search__status">
            <text class="search__status-text">搜索中</text>
        </view>

        <!-- 结果 -->
        <view v-if="searched && !searching" class="search__result">
            <view v-if="results.length" class="search__grid">
                <yh-vod-card
                    v-for="vod in results"
                    :key="vod.id"
                    class="search__grid-item"
                    :vod="vod"
                    @click="goDetail" />
            </view>
            <yh-empty v-else :text="`没有找到「${lastKeyword}」相关影片`" />
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 搜索页。
 *
 * 数据源说明：服务端 `/api/search/result` 已失效（恒返回空数组），
 * 故改用 `/api/search/screen` 拉取分页数据 + 本地关键词匹配。
 * 详见 services/video.ts 的 searchVod。
 */

import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Vod } from '@/api/types';
import { getHotSearch, searchVod } from '@/services/video';

const keyword = ref('');
const lastKeyword = ref('');
const hotWords = ref<Array<{ name: string; vodId?: number }>>([]);
const results = ref<Vod[]>([]);
const searched = ref(false);
const searching = ref(false);

async function loadHot() {
    try {
        hotWords.value = await getHotSearch();
    } catch {
        hotWords.value = [];
    }
}

async function doSearch() {
    const wd = keyword.value.trim();
    if (!wd) {
        uni.showToast({ icon: 'none', title: '请输入关键词' });
        return;
    }

    searched.value = true;
    searching.value = true;
    lastKeyword.value = wd;

    try {
        results.value = await searchVod(wd);
    } catch (e) {
        console.warn('[search] 失败', e);
        results.value = [];
    } finally {
        searching.value = false;
    }
}

function searchWord(w: string) {
    keyword.value = w;
    doSearch();
}

function goDetail(vod: Vod) {
    uni.navigateTo({ url: `/pages/detail/detail?id=${vod.id}` });
}

onLoad(() => {
    loadHot();
});
</script>

<style lang="scss" scoped>
.search {
    min-height: 100vh;
    min-height: 100dvh;
    background-color: #0b0d10;
    /* 底部安全区：搜索结果最后一行会被 iPhone 小黑条压住 */
    padding-bottom: env(safe-area-inset-bottom);

    &__bar {
        display: flex;
        align-items: center;
        padding: 12rpx 24rpx 24rpx;
    }

    &__input {
        flex: 1;
        height: 72rpx;
        padding: 0 28rpx;
        border-radius: 36rpx;
        background-color: #1d2128;
        font-size: 28rpx;
        color: #e8eaed;
    }

    &__placeholder {
        color: #6b7280;
    }

    &__btn {
        margin-left: 20rpx;
        padding: 0 12rpx;
    }

    &__btn-text {
        font-size: 30rpx;
        color: #f0a63c;
    }

    &__section {
        padding: 24rpx;
    }

    &__section-title {
        display: block;
        font-size: 30rpx;
        font-weight: 600;
        color: #e8eaed;
        margin-bottom: 24rpx;
    }

    &__tags {
        display: flex;
        flex-wrap: wrap;
    }

    &__tag {
        padding: 12rpx 28rpx;
        margin: 0 20rpx 20rpx 0;
        border-radius: 30rpx;
        background-color: #1d2128;
    }

    &__tag-text {
        font-size: 26rpx;
        color: #c9ced6;
    }

    &__status {
        padding: 100rpx 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__status-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    &__grid {
        display: flex;
        flex-wrap: wrap;
        padding: 0 24rpx;
    }

    &__grid-item {
        width: 31.3%;
        margin-right: 3%;
        margin-bottom: 32rpx;
    }

    &__grid-item:nth-child(3n) {
        margin-right: 0;
    }
}
</style>
