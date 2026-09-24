<template>
    <view class="mine">
        <yh-nav title="我的" :show-back="false" />

        <!-- 用户卡片：默认昵称 + 头像占位 -->
        <view class="mine__card">
            <view class="mine__avatar">
                <text class="mine__avatar-text">{{ avatar }}</text>
            </view>
            <view class="mine__user">
                <view class="mine__name-row tap" @click="editNickname">
                    <text class="mine__name">{{ userStore.nickname }}</text>
                    <text class="mine__edit">修改</text>
                </view>
                <text class="mine__desc">{{ descText }}</text>
            </view>
        </view>

        <!-- 统计 -->
        <view class="mine__stats">
            <view class="mine__stat tap-row" @click="goHistory">
                <text class="mine__stat-num">{{ userStore.historyCount }}</text>
                <text class="mine__stat-label">观看历史</text>
            </view>
            <view class="mine__stat tap-row" @click="goFavorite">
                <text class="mine__stat-num">{{ userStore.favoriteCount }}</text>
                <text class="mine__stat-label">我的收藏</text>
            </view>
            <view class="mine__stat tap-row" @click="goCache">
                <text class="mine__stat-num">{{ userStore.cacheCount }}</text>
                <text class="mine__stat-label">离线缓存</text>
            </view>
        </view>

        <!-- 一起看：输入房间邀请码加入 -->
        <view class="mine__join">
            <view class="mine__join-head">
                <text class="mine__join-title">一起看</text>
                <text class="mine__join-sub">输入好友发来的房间号，即可进入同一房间</text>
            </view>
            <view class="mine__join-row">
                <input
                    class="mine__join-input"
                    v-model="joinCode"
                    type="text"
                    :maxlength="6"
                    placeholder="6 位房间号"
                    placeholder-class="mine__join-placeholder"
                    @input="onJoinInput" />
                <view
                    class="mine__join-btn tap tap-solid"
                    :class="{ 'mine__join-btn--disabled': !canJoin }"
                    @click="joinRoom">
                    <text class="mine__join-btn-text">进入房间</text>
                </view>
            </view>
            <view class="mine__join-tip">
                <text class="mine__join-tip-text tap" @click="createSelfRoom">没有房间号？自己开一个 ›</text>
            </view>
        </view>

        <view class="mine__list">
            <view class="mine__item tap-row" @click="goHistory">
                <text class="mine__item-text">观看历史</text>
                <view class="mine__item-right">
                    <text class="mine__item-count">{{ userStore.historyCount }}</text>
                    <view class="mine__arrow" />
                </view>
            </view>
            <view class="mine__item tap-row" @click="goFavorite">
                <text class="mine__item-text">我的收藏</text>
                <view class="mine__item-right">
                    <text class="mine__item-count">{{ userStore.favoriteCount }}</text>
                    <view class="mine__arrow" />
                </view>
            </view>
            <view class="mine__item tap-row" @click="goCache">
                <text class="mine__item-text">离线缓存</text>
                <view class="mine__item-right">
                    <text class="mine__item-count">{{ cacheText }}</text>
                    <view class="mine__arrow" />
                </view>
            </view>
        </view>

        <!-- 存储占用提示：缓存占的是应用沙箱空间，给用户一个可见的量 -->
        <view v-if="userStore.cacheBytes > 0" class="mine__tip">
            <text class="mine__tip-text">离线缓存已占用 {{ sizeText }}，可在「离线缓存」中清理</text>
        </view>

        <view class="mine__footer">
            <text class="mine__footer-text">映话 v1.0.0</text>
        </view>

        <!--
            昵称编辑弹窗。
            用组件而非 uni.showModal —— 后者是系统原生弹窗，
            样式不可控（白底、系统字体），与本应用的暗色基调格格不入。

            这里把 popup 自身底色设为透明、去圆角，视觉完全交给内层
            的 .nick 盒子，避免出现「白底内又套一层暗色卡片」的脏边。
        -->
        <wd-popup
            v-model="editOpen"
            position="center"
            :z-index="9999"
            custom-style="background: transparent; box-shadow: none;"
            @close="onEditClose">
            <view class="nick">
                <text class="nick__title">修改昵称</text>
                <text class="nick__hint">最多 16 个字，随时可改</text>

                <view class="nick__field">
                    <input
                        class="nick__input"
                        v-model="editValue"
                        :maxlength="16"
                        :focus="editOpen"
                        confirm-type="done"
                        placeholder="输入新昵称"
                        placeholder-class="nick__placeholder"
                        @confirm="saveNickname" />
                    <text class="nick__count">{{ editValue.length }}/16</text>
                </view>

                <view class="nick__ops">
                    <view class="nick__btn tap tap-solid" @click="editOpen = false">
                        <text class="nick__btn-text">取消</text>
                    </view>
                    <view class="nick__btn nick__btn--primary tap tap-solid" @click="saveNickname">
                        <text class="nick__btn-text nick__btn-text--primary">保存</text>
                    </view>
                </view>
            </view>
        </wd-popup>
    </view>
</template>

<script setup lang="ts">
/**
 * 我的页面。
 *
 * 数据源为公开采集源，**没有账号体系**，因此：
 *   - 昵称是本地生成的默认值（可在本页修改），不存在服务端资料
 *   - 收藏 / 观看历史 / 离线缓存 全部存本机
 *
 * 本页只做入口与总览，列表分别在 history / favorite / cache 三个页面。
 */

import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { useUserStore } from '@/stores/user';
import { avatarChar } from '@/services/profile';
import { formatSize } from '@/services/download';
import { isRoomCode } from '@/utils/room-sync';

const userStore = useUserStore();

/** 输入的房间号 */
const joinCode = ref('');

/** 房间号是否合法（6 位、去掉了易混字符） */
const canJoin = computed(() => isRoomCode(joinCode.value));

/** 输入时只保留合法字符并转大写，避免用户粘进空格/符号。 */
function onJoinInput(e: any) {
    const raw = String((e && e.detail && e.detail.value) || '');
    joinCode.value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/** 带着房间号进入房间：观众身份，片源由房主同步过来。 */
function joinRoom() {
    const code = joinCode.value.toUpperCase();
    if (!isRoomCode(code)) {
        uni.showToast({ icon: 'none', title: '请输入 6 位房间号' });
        return;
    }
    uni.navigateTo({ url: `/pages/room/room?roomId=${code}` });
}

/** 没有房间号时自己去开一个（房主身份，进去后再选片）。 */
function createSelfRoom() {
    uni.navigateTo({ url: '/pages/room/room' });
}

const avatar = computed(() => avatarChar(userStore.nickname));

/** 副标题：有数据时展示使用概况，否则展示 slogan。 */
const descText = computed(() => {
    const h = userStore.historyCount;
    const f = userStore.favoriteCount;
    if (h || f) return `看过 ${h} 部 · 收藏 ${f} 部`;
    return '一起看，聊着看';
});

/** 缓存条数与体积的组合文案。 */
const cacheText = computed(() => {
    if (userStore.cacheCount === 0) return '';
    return `${userStore.cacheCount} 集`;
});

const sizeText = computed(() => formatSize(userStore.cacheBytes));

// 每次进入页面刷新（可能刚看完/刚缓存完）
onShow(() => {
    userStore.refresh();
});

/* ---------------- 昵称编辑 ---------------- */

/** 编辑弹窗是否展开 */
const editOpen = ref(false);
/** 编辑中的值 */
const editValue = ref('');

/** 打开编辑弹窗（带入当前昵称）。 */
function editNickname() {
    editValue.value = userStore.nickname;
    editOpen.value = true;
}

/** 弹窗关闭时做一次清理。 */
function onEditClose() {
    editOpen.value = false;
}

/**
 * 保存昵称。
 *
 * 空值不覆盖 —— 用户清空后点保存多半是误操作，
 * 用服务层兜底的默认昵称反而是更意外的结果。
 */
function saveNickname() {
    const next = (editValue.value || '').trim();
    if (!next) {
        uni.showToast({ icon: 'none', title: '昵称不能为空' });
        return;
    }

    const saved = userStore.updateNickname(next);
    editOpen.value = false;
    uni.showToast({ icon: 'none', title: `昵称已改为 ${saved}` });
}

function goHistory() {
    uni.navigateTo({ url: '/pages/history/history' });
}

function goFavorite() {
    uni.navigateTo({ url: '/pages/favorite/favorite' });
}

function goCache() {
    uni.navigateTo({ url: '/pages/cache/cache' });
}
</script>

<style lang="scss" scoped>
.mine {
    min-height: 100vh;
    /* dvh 兜底：移动端地址栏收起/展开会改变 vh */
    min-height: 100dvh;
    background-color: #0b0d10;

    &__card {
        display: flex;
        align-items: center;
        padding: 40rpx 28rpx 32rpx;
    }

    /*
     * 头像：圆形渐变底 + 细描边。
     * 纯色方块在纯黑背景上像一个洞，渐变让它有「徽章」的质感。
     */
    &__avatar {
        width: 120rpx;
        height: 120rpx;
        border-radius: 60rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        background-image: linear-gradient(135deg, rgba(240, 166, 60, 0.24), rgba(240, 166, 60, 0.06));
        border: 1rpx solid rgba(240, 166, 60, 0.28);
    }

    &__avatar-text {
        font-size: 48rpx;
        font-weight: 700;
        color: #f0a63c;
    }

    &__user {
        margin-left: 28rpx;
        flex: 1;
        min-width: 0;
    }

    &__name-row {
        display: flex;
        align-items: center;
    }

    &__name {
        font-size: 34rpx;
        font-weight: 600;
        color: #e8eaed;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        max-width: 360rpx;
    }

    /* 「修改」做成小胶囊，比裸文字更像可点的入口 */
    &__edit {
        margin-left: 16rpx;
        padding: 4rpx 18rpx;
        font-size: 22rpx;
        color: #f0a63c;
        border-radius: 999rpx;
        background-color: rgba(240, 166, 60, 0.14);
        flex-shrink: 0;
    }

    &__desc {
        display: block;
        margin-top: 8rpx;
        font-size: 24rpx;
        color: #6b7280;
    }

    /* ---------- 统计 ---------- */

    /*
     * 三张卡片（统计 / 一起看 / 列表）统一用同一套外观：
     * 同圆角、同底色、同极淡描边。原先只有底色、无描边，
     * 在纯黑背景上边界感很弱。
     */
    &__stats {
        display: flex;
        margin: 0 24rpx;
        padding: 28rpx 0;
        border-radius: 16rpx;
        background-color: #14171c;
        border: 1rpx solid rgba(255, 255, 255, 0.05);
    }

    &__stat {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    /* 中间加一条竖分隔，三块数字之间才有层次 */
    &__stat + .mine__stat {
        border-left: 1rpx solid rgba(255, 255, 255, 0.06);
    }

    &__stat-num {
        font-size: 38rpx;
        font-weight: 700;
        color: #f0a63c;
        font-variant-numeric: tabular-nums;
    }

    &__stat-label {
        margin-top: 8rpx;
        font-size: 24rpx;
        color: #6b7280;
    }

    /* ---------- 列表 ---------- */

    /* ---------- 一起看 ---------- */

    &__join {
        margin: 24rpx;
        padding: 28rpx;
        border-radius: 16rpx;
        background-color: #14171c;
        border: 1rpx solid rgba(255, 255, 255, 0.05);
    }

    &__join-head {
        margin-bottom: 22rpx;
    }

    &__join-title {
        display: block;
        font-size: 30rpx;
        font-weight: 600;
        color: #e8eaed;
    }

    &__join-sub {
        display: block;
        margin-top: 8rpx;
        font-size: 22rpx;
        color: #6b7280;
    }

    &__join-row {
        display: flex;
        align-items: center;
    }

    &__join-input {
        flex: 1;
        min-width: 0;
        height: 76rpx;
        padding: 0 24rpx;
        border-radius: 38rpx;
        background-color: #1d2128;
        color: #e8eaed;
        font-size: 30rpx;
        /*
         * 字距收敛到 3rpx：房间号是 6 位大写字母数字，
         * 略宽的字距便于逐位核对；原先 6rpx 会让字符显得散开。
         */
        letter-spacing: 3rpx;
        font-variant-numeric: tabular-nums;
    }

    &__join-placeholder {
        color: #4b5563;
        font-size: 26rpx;
        letter-spacing: 0;
    }

    &__join-btn {
        height: 76rpx;
        padding: 0 32rpx;
        margin-left: 16rpx;
        border-radius: 38rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: #f0a63c;
        flex-shrink: 0;
    }

    &__join-btn--disabled {
        background-color: #2a2f36;
    }

    &__join-btn-text {
        font-size: 28rpx;
        font-weight: 600;
        color: #0b0d10;
        white-space: nowrap;
    }

    &__join-btn--disabled .mine__join-btn-text {
        color: #6b7280;
    }

    &__join-tip {
        margin-top: 18rpx;
    }

    &__join-tip-text {
        font-size: 22rpx;
        color: #f0a63c;
    }

    &__list {
        /*
         * 卡片化：与上方 __stats / __join 的圆角卡片风格统一。
         * 原先是整块通栏无圆角，三张卡片里夹一块方块，显得割裂。
         */
        margin: 24rpx;
        border-radius: 16rpx;
        background-color: #14171c;
        border: 1rpx solid rgba(255, 255, 255, 0.05);
        overflow: hidden;
    }

    &__item {
        height: 104rpx;
        padding: 0 28rpx;
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    /* 分隔线只画在中间，不顶到卡片边缘 —— 通栏线会让卡片显得像被切开 */
    &__item + .mine__item {
        border-top: 1rpx solid rgba(255, 255, 255, 0.06);
    }

    &__item-text {
        font-size: 30rpx;
        color: #e8eaed;
    }

    &__item-right {
        display: flex;
        align-items: center;
    }

    &__item-count {
        font-size: 26rpx;
        color: #6b7280;
        margin-right: 10rpx;
        font-variant-numeric: tabular-nums;
    }

    /*
     * 右向箭头：CSS 绘制而非「›」字符。
     * 字符箭头各机型字体不同、基线会漂，旋转 45° 的边框则完全一致
     * （导航栏的返回箭头用的是同一套做法）。
     */
    &__arrow {
        flex-shrink: 0;
        width: 14rpx;
        height: 14rpx;
        border-top: 3rpx solid #3d434e;
        border-right: 3rpx solid #3d434e;
        border-radius: 2rpx;
        transform: rotate(45deg);
    }

    &__tip {
        margin: 0 28rpx;
    }

    &__tip-text {
        font-size: 22rpx;
        line-height: 1.6;
        color: #4b5563;
    }

    &__footer {
        /* 用 padding 而非 margin：内容少时也不会把页脚顶到屏幕中间 */
        padding: 60rpx 0 40rpx;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    &__footer-text {
        font-size: 24rpx;
        color: #3d434e;
        letter-spacing: 1rpx;
    }
}

/* ---------- 昵称编辑弹窗 ---------- */

.nick {
    width: 560rpx;
    padding: 44rpx 40rpx 32rpx;
    border-radius: 20rpx;
    background-color: #14171c;

    &__title {
        display: block;
        font-size: 34rpx;
        font-weight: 600;
        color: #e8eaed;
        text-align: center;
    }

    &__hint {
        display: block;
        margin-top: 10rpx;
        font-size: 22rpx;
        color: #6b7280;
        text-align: center;
    }

    &__field {
        position: relative;
        margin-top: 36rpx;
        padding: 0 24rpx;
        height: 84rpx;
        display: flex;
        align-items: center;
        border-radius: 42rpx;
        background-color: #1d2128;
    }

    &__input {
        flex: 1;
        height: 100%;
        font-size: 30rpx;
        color: #e8eaed;
    }

    &__placeholder {
        color: #4b5563;
        font-size: 28rpx;
    }

    &__count {
        margin-left: 12rpx;
        font-size: 22rpx;
        color: #4b5563;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }

    &__ops {
        display: flex;
        margin-top: 36rpx;
        /*
         * 用 gap 控制两键间距，不用 `:first-child` ——
         * scoped 编译后 uni-app 会给选择器附加属性，:first-child
         * 在部分平台匹配不到，表现为「取消」键贴着「保存」键。
         */
        gap: 20rpx;
    }

    &__btn {
        flex: 1;
        height: 76rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 38rpx;
        background-color: #1d2128;
    }

    &__btn--primary {
        background-color: #f0a63c;
    }

    &__btn-text {
        font-size: 28rpx;
        color: #c9ced6;
    }

    &__btn-text--primary {
        color: #0b0d10;
        font-weight: 600;
    }
}
</style>
