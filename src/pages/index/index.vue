<template>
    <view class="home">
        <!-- 顶部：标题 + 搜索入口 -->
        <view class="home__header" :style="{ paddingTop: statusBarHeight + 'px' }">
            <view class="home__header-bar">
                <text class="home__logo">映话</text>
                <view class="home__search tap" @click="goSearch">
                    <text class="home__search-text">搜索影片、演员</text>
                </view>
            </view>
        </view>

        <view v-if="loading" class="home__loading">
            <text class="home__loading-text">加载中</text>
        </view>

        <template v-else>
            <!-- 轮播：取自「最新」的前若干部，16:9 横屏 -->
            <view v-if="banners.length" class="home__banner">
                <swiper
                    class="home__banner-swiper"
                    :autoplay="true"
                    :interval="4500"
                    :duration="420"
                    :circular="true"
                    @change="onBannerChange">
                    <swiper-item v-for="(b, i) in banners" :key="i">
                        <view class="home__banner-item tap" @click="goDetail(b)">
                            <image class="home__banner-img" :src="b.vod_pic" mode="aspectFill" />
                            <view class="home__banner-mask">
                                <text class="home__banner-name">{{ b.vod_name }}</text>
                                <text v-if="bannerSub(b)" class="home__banner-sub">{{ bannerSub(b) }}</text>
                            </view>
                        </view>
                    </swiper-item>
                </swiper>

                <view class="home__dots">
                    <view
                        v-for="(b, i) in banners"
                        :key="i"
                        class="home__dot"
                        :class="{ 'home__dot--active': i === bannerIndex }" />
                </view>
            </view>

            <!-- 栏目流：每个分类一行，横向滑动 -->
            <view v-for="sec in sections" :key="sec.name" class="home__section">
                <view class="home__section-head">
                    <text class="home__section-title">{{ sec.name }}</text>
                    <view v-if="!sec.isLatest" class="home__section-more tap tap-solid" @click="goCategory(sec)">
                        <text class="home__section-more-text">更多</text>
                    </view>
                </view>

                <scroll-view class="home__row" scroll-x :show-scrollbar="false" :bounce="false">
                    <view v-for="vod in sec.list" :key="vod.id" class="home__row-item tap" @click="goDetail(vod)">
                        <image class="home__row-img" :src="vod.vod_pic" mode="aspectFill" lazy-load />
                        <text class="home__row-name">{{ vod.vod_name }}</text>
                        <text class="home__row-meta">{{ rowMeta(vod) }}</text>
                    </view>
                </scroll-view>
            </view>

            <yh-empty v-if="!sections.length && !loading" text="暂无内容" />

            <!-- 分类栏目正在串行加载时的轻提示 -->
            <view v-if="sectionTip" class="home__section-tip">
                <text class="home__section-tip-text">{{ sectionTip }}</text>
            </view>
        </template>
    </view>
</template>

<script setup lang="ts">
/**
 * 首页。
 *
 * 布局：**顶部轮播 + 多个横向栏目流**。
 *
 * 说明：不再放置频道 tab —— 分类切换由独立的「分类」页承担，
 * 避免与分类功能重合。首页只做内容发现。
 *
 * 数据源：公开采集源（苹果CMS v10），见 services/video.ts。
 */

import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Vod } from '@/api/types';
import { getChannelInfo, getLatestVod } from '@/services/video';
import { HOME_SECTIONS, LATEST_PAGES, LATEST_SECTION } from '@/constants/source';

const statusBarHeight = ref(uni.getSystemInfoSync().statusBarHeight || 0);
const loading = ref(true);
const banners = ref<Vod[]>([]);
const bannerIndex = ref(0);
/** 分类栏目的加载进度文案（串行加载时提示） */
const sectionTip = ref('');

interface HomeSection {
    name: string;
    list: Vod[];
    /** 「最新」栏目不提供「更多」入口 */
    isLatest?: boolean;
}

const sections = ref<HomeSection[]>([]);

/** 轮播副标题：年份 · 地区 · 备注。 */
function bannerSub(v: Vod): string {
    const parts: string[] = [];
    if (v.vod_year) parts.push(v.vod_year);
    if (v.vod_area) parts.push(v.vod_area);
    if (v.vod_remarks) parts.push(v.vod_remarks);
    return parts.join(' · ');
}

/** 栏目内影片副信息。 */
function rowMeta(v: Vod): string {
    if (v.vod_remarks) return v.vod_remarks;
    if (v.vod_year) return v.vod_year;
    return '';
}

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

async function loadHome() {
    loading.value = true;
    sections.value = [];
    banners.value = [];

    try {
        /*
         * 「最新」先出：不传分类参数即为按 vod_time 倒序，
         * 是首页最需要的新鲜内容，也顺便充当轮播来源。
         */
        const latest = await getLatestVod(LATEST_PAGES)
            .then(mods => ({ name: LATEST_SECTION.name, list: flatten(mods), isLatest: true }))
            .catch(() => ({ name: LATEST_SECTION.name, list: [] as Vod[], isLatest: true }));

        if (latest.list.length) {
            sections.value = [latest];
            banners.value = latest.list.slice(0, 6);
        }
        // 首屏拿到内容即可结束骨架，后续栏目增量追加
        loading.value = false;

        /*
         * 分类栏目**并行**加载。
         *
         * 早先是 `for + await` 串行：4 个栏目逐个等，
         * 每个栏目内部还要聚合 8 个子类，总耗时是各栏目之和 ——
         * 这正是「首页加载很慢」的根因。
         *
         * 现在一次性全部提交，且**谁先完成谁先上屏**：
         *   · 并发上限由 service 层的全局闸门统一控制（恒定 6），
         *     上层怎么并行都不会打爆源站 —— 这是能安全并行的前提。
         *   · 完成一个就立刻重建列表，用户不必等最慢的栏目。
         */
        sectionTip.value = '正在加载栏目';

        /*
         * 已加载的栏目（分类名 → 影片列表）。
         *
         * 用「映射 + 按固定顺序重建」而不是「算下标插入」：
         * 下标插入依赖「前面的栏目已就位」，而并行完成顺序是随机的 ——
         * 若「综艺」最先返回，算出的位置会越界、被夹到末尾，
         * 结果它排到了「短剧」前面。用映射重建则与到达顺序完全无关。
         */
        const loaded = new Map<string, Vod[]>();

        /** 按 HOME_SECTIONS 的配置顺序重建列表，「最新」恒在首位。 */
        const rebuild = () => {
            const next: HomeSection[] = sections.value.filter(s => s.isLatest);
            for (const cfg of HOME_SECTIONS) {
                const list = loaded.get(cfg.name);
                if (list && list.length) next.push({ name: cfg.name, list });
            }
            sections.value = next;
        };

        const tasks = HOME_SECTIONS.map(async sec => {
            try {
                const mods = await getChannelInfo(sec.name, 1, sec.alias || []);
                const list = flatten(mods);
                if (!list.length) return;
                loaded.set(sec.name, list);
                rebuild();
            } catch (e) {
                // 单个栏目失败不影响其它栏目
                console.warn('[home] 栏目加载失败', sec.name, e);
            }
        });

        await Promise.all(tasks);
    } finally {
        sectionTip.value = '';
        loading.value = false;
    }
}

function onBannerChange(e: any) {
    bannerIndex.value = e.detail.current;
}

function goDetail(vod: Vod) {
    uni.navigateTo({ url: `/pages/detail/detail?id=${vod.id}` });
}

/**
 * 进入分类列表。
 *
 * 只传分类**名称**，不传 id —— 各源的 type_id 体系不同，
 * 传 id 到别的源会取到无关分类（见 services/video.ts 的分类解析）。
 */
function goCategory(sec: { name: string }) {
    uni.navigateTo({
        url: `/pages/catlist/catlist?name=${encodeURIComponent(sec.name)}`
    });
}

function goSearch() {
    uni.navigateTo({ url: '/pages/search/search' });
}

onLoad(() => {
    loadHome();
});
</script>

<style lang="scss" scoped>
.home {
    min-height: 100vh;
    /* dvh 兜底：移动端地址栏收起/展开会改变 vh，用 dvh 更稳 */
    min-height: 100dvh;
    background-color: #0b0d10;
    padding-bottom: 40rpx;

    &__header {
        position: sticky;
        top: 0;
        z-index: 10;
        background-color: #0b0d10;
    }

    &__header-bar {
        display: flex;
        align-items: center;
        padding: 20rpx 24rpx 16rpx;
    }

    &__logo {
        font-size: 40rpx;
        font-weight: 700;
        color: #f0a63c;
        letter-spacing: 4rpx;
    }

    &__search {
        flex: 1;
        margin-left: 24rpx;
        height: 64rpx;
        padding: 0 24rpx;
        display: flex;
        align-items: center;
        border-radius: 32rpx;
        background-color: #1d2128;
    }

    &__search-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    &__loading {
        padding: 120rpx 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__loading-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    /* ---------- 轮播 ---------- */

    &__banner {
        position: relative;
        margin: 8rpx 24rpx 0;
    }

    &__banner-swiper {
        width: 100%;
        height: 380rpx;
        border-radius: 16rpx;
        overflow: hidden;
    }

    &__banner-item {
        position: relative;
        width: 100%;
        height: 100%;
    }

    &__banner-img {
        width: 100%;
        height: 100%;
        display: block;
    }

    &__banner-mask {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 80rpx 24rpx 22rpx;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.88), transparent);
    }

    &__banner-name {
        display: block;
        font-size: 34rpx;
        font-weight: 700;
        color: #ffffff;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__banner-sub {
        display: block;
        margin-top: 6rpx;
        font-size: 24rpx;
        color: rgba(255, 255, 255, 0.72);
    }

    &__dots {
        position: absolute;
        right: 24rpx;
        bottom: 18rpx;
        display: flex;
        align-items: center;
    }

    &__dot {
        width: 10rpx;
        height: 10rpx;
        margin-left: 10rpx;
        border-radius: 50%;
        background-color: rgba(255, 255, 255, 0.36);
    }

    &__dot--active {
        width: 22rpx;
        border-radius: 5rpx;
        background-color: #f0a63c;
    }

    /* ---------- 栏目流 ---------- */

    &__section {
        margin-top: 40rpx;
    }

    &__section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 24rpx 18rpx;
    }

    &__section-title {
        font-size: 34rpx;
        font-weight: 600;
        color: #e8eaed;
    }

    &__section-more {
        padding: 4rpx 20rpx;
        border-radius: 24rpx;
        background-color: #1d2128;
    }

    &__section-more-text {
        font-size: 24rpx;
        color: #f0a63c;
    }

    &__row {
        white-space: nowrap;
        padding: 0 24rpx;
    }

    &__row-item {
        display: inline-block;
        width: 220rpx;
        margin-right: 20rpx;
        vertical-align: top;
    }

    &__row-img {
        width: 220rpx;
        height: 308rpx;
        border-radius: 12rpx;
        background-color: #1d2128;
    }

    &__row-name {
        display: block;
        margin-top: 12rpx;
        font-size: 26rpx;
        color: #e8eaed;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__row-meta {
        display: block;
        margin-top: 4rpx;
        font-size: 22rpx;
        color: #6b7280;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__section-tip {
        padding: 32rpx 0 56rpx;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__section-tip-text {
        font-size: 24rpx;
        color: #4b5563;
    }
}
</style>
