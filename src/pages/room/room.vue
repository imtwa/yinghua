<template>
    <view class="room">
        <yh-nav title="一起看" />

        <!--
            播放器区。
            通话悬浮窗不在这一层 —— 见下方根层级浮层。
        -->        <view class="room__stage">
            <yh-player
                v-if="playStore.playUrl"
                ref="playerRef"
                class="room__player"
                :src="playStore.playUrl"
                :autoplay="true"
                :initial-time="0"
                :playback-rate="playbackRate"
                @timeupdate="onTimeUpdate"
                @ratechange="onRateChange"
                @landscapechange="onLandscapeChange"
                @orientationchange="onOrientationChange"
                @ended="onEnded" />

            <view v-else class="room__loading">
                <text class="room__loading-text">{{ loadingText }}</text>
                <view v-if="showWaitTip" class="room__loading-tip">
                    <text class="room__loading-tip-text">{{ waitTip }}</text>
                    <view v-if="isHost" class="room__pick tap tap-solid" @click="goPickVideo">
                        <text class="room__pick-text">去挑一部影片</text>
                    </view>
                </view>
            </view>
        </view>

        <!--
            通话悬浮窗（参照抖音「一起刷」）。

            刻意放在**页面根层级**而不是播放器区域内部：
            播放器全屏时是 fixed + z-index 9999，且 .room__stage 会形成
            自己的层叠顺序；浮窗挂在页面根、用更高的 z-index 并走 fixed，
            才能保证「无论播放器是否全屏都在最上层」。

            两种形态：
              收起 —— 只剩一条名字胶囊，几乎不挡画面
              展开 —— 小窗视频 + 标题栏，按方向停靠边缘

            注意：收起态**不能**用 v-if 卸载 yh-rtc ——
            那是 renderjs 组件，卸载等于挂断通话。
            这里只切 CSS（display:none），组件保持挂载、通话不断。
        -->
        <view
            v-if="callEnabled && pipPlaced"
            class="room__pip"
            :class="{ 'room__pip--mini': pipMini }"
            :style="pipStyle"
            @touchstart="onPipTouchStart"
            @touchmove.stop.prevent="onPipTouchMove"
            @touchend="onPipTouchEnd"
            @touchcancel="onPipTouchEnd"
            @click="onPipTap">
            <yh-rtc
                ref="rtcRef"
                class="room__rtc"
                :room-id="roomId"
                :display-name="displayName"
                :auto-start="true"
                @status="onCallStatus"
                @remote="onRemoteChange"
                @peers="onPeersChange"
                @peername="onPeerName"
                @message="onChannelMessage"
                @localready="onLocalReady"
                @error="onCallError" />

            <!--
                收起态内容：名字 + 通话状态点。
                展开态整体隐藏（含视频），只留这一条。
            -->
            <view class="room__pip-mini">
                <view class="room__pip-dot" :class="{ 'room__pip-dot--live': hasRemote }" />
                <text class="room__pip-mini-name">{{ miniLabel }}</text>
            </view>

            <!-- 展开态标题栏：昵称 + 收起 -->
            <view class="room__pip-bar">
                <text class="room__pip-name">{{ pipTitle }}</text>
                <text class="room__pip-mini-text">收起</text>
            </view>
        </view>

        <!--
            通话控制条。

            全屏时改为浮层（fixed + 高 z-index）—— 否则会被 z-index 9999 的
            全屏播放器整个盖住，用户在全屏里既看不到画面也点不到挂断键。
        -->
        <view class="room__call-bar" :class="{ 'room__call-bar--float': playerFullscreen }">
            <view v-if="!callEnabled" class="room__bar-btn room__bar-btn--primary tap tap-solid" @click="startCall">
                <text class="room__bar-text room__bar-text--primary">开启视频通话</text>
            </view>

            <template v-else>
                <view class="room__bar-btn tap tap-solid" :class="{ 'room__bar-btn--off': !audioOn }" @click="toggleAudio">
                    <text class="room__bar-text">{{ audioOn ? '麦克风' : '已静音' }}</text>
                </view>
                <view class="room__bar-btn tap tap-solid" :class="{ 'room__bar-btn--off': !videoOn }" @click="toggleVideo">
                    <text class="room__bar-text">{{ videoOn ? '摄像头' : '已关闭' }}</text>
                </view>
                <view class="room__bar-btn tap tap-solid" @click="switchCamera">
                    <text class="room__bar-text">翻转</text>
                </view>
                <view class="room__bar-btn room__bar-btn--danger tap tap-solid" @click="endCall">
                    <text class="room__bar-text room__bar-text--danger">挂断</text>
                </view>
            </template>
        </view>

        <!-- 房间信息 -->
        <view class="room__panel">
            <!--
                正在看的影片。
                放在最上方：进房间后用户第一个想知道的就是「现在在播什么」，
                此前这一栏完全缺失，只能靠下方的播放器画面自己猜。
            -->
            <view class="room__now">
                <text class="room__now-label">正在看</text>
                <view class="room__now-body">
                    <text v-if="nowPlayingText" class="room__now-name">{{ nowPlayingText }}</text>
                    <text v-else class="room__now-name room__now-name--idle">{{ nowPlayingEmptyText }}</text>
                    <text v-if="episodeLabel" class="room__now-ep">{{ episodeLabel }}</text>
                </view>
            </view>

            <!-- 房间号：最需要分享的信息，放大成主视觉 -->
            <view class="room__code">
                <text class="room__code-label">房间号</text>
                <text class="room__code-value">{{ roomId }}</text>
                <view class="room__code-copy tap tap-solid" @click="copyRoomId">
                    <text class="room__code-copy-text">复制</text>
                </view>
            </view>

            <!--
                状态徽标。
                把「身份 / 同看 / 同步 / 倍速」压成一行 chips：
                长句（如「房主（时间基准）」）读起来慢且占高度，
                徽标一眼就能扫完，也让页面从「表单」变成「状态面板」。
            -->
            <view class="room__chips">
                <view class="room__chip" :class="{ 'room__chip--accent': isHost }">
                    <text class="room__chip-text">{{ isHost ? '房主' : '观众' }}</text>
                </view>
                <view class="room__chip">
                    <text class="room__chip-text">{{ peerCount + 1 }} 人同看</text>
                </view>
                <view class="room__chip" :class="{ 'room__chip--accent': isHost, 'room__chip--warn': !isHost && !following }">
                    <text class="room__chip-text">{{ isHost ? '同步广播中' : following ? '跟随中' : '已取消跟随' }}</text>
                </view>
                <view class="room__chip" :class="{ 'room__chip--warn': callEnabled && callStatus === 'error' }">
                    <text class="room__chip-text">{{ callEnabled ? statusText : '通话未开启' }}</text>
                </view>
                <view class="room__chip">
                    <text class="room__chip-text">{{ playbackRate }}×</text>
                </view>
            </view>

            <!-- 同步状态提示 -->
            <view v-if="!isHost && syncHint" class="room__hint">
                <text class="room__hint-text">{{ syncHint }}</text>
            </view>

            <view class="room__actions">
                <view v-if="!isHost" class="room__btn tap tap-solid" @click="toggleFollow">
                    <text class="room__btn-text">{{ following ? '取消跟随' : '跟随房主' }}</text>
                </view>
                <view class="room__btn room__btn--primary tap tap-solid" @click="invite">
                    <text class="room__btn-text room__btn-text--primary">邀请好友</text>
                </view>
            </view>
        </view>

        <!--
            说明。
            只讲「怎么用」，不出现 WebRTC / 片源 / 信令 / CDN 这类技术词 ——
            用户不需要知道实现方式。
        -->
        <view class="room__note">
            <text class="room__note-text">
                把房间号发给好友，对方在「我的 → 一起看」里输入就能进来。
                进来后会看到同一部影片，进度自动保持一致；打开通话就能边看边聊。
            </text>
        </view>
    </view>
</template>

<script setup lang="ts">
/**
 * 双人视频房间页。
 *
 * 两条独立通道：
 *   1. **影片流**：两端各自拉 CDN，靠「进度对齐」同步（不走 RTC，省带宽、画质更好）
 *   2. **通话流**：WebRTC 传人像与语音（见 components/yh-rtc）
 *
 * 信令复用毕业设计在线的 lobby 服务，协议细节见 constants/rtc.ts。
 */

import { computed, ref } from 'vue';
import { onHide, onLoad, onUnload } from '@dcloudio/uni-app';
import type { Collection } from '@/api/types';
import { resolvePlayUrl } from '@/services/play';
import { getVodDetail } from '@/services/video';
import { usePlayStore } from '@/stores/play';
import { useUserStore } from '@/stores/user';
import { createLogger } from '@/utils/logger';
import {
    DRIFT_THRESHOLD,
    clearActiveRoom,
    generateRoomId,
    isRoomCode,
    loadActiveRoom,
    saveActiveRoom
} from '@/utils/room-sync';

const log = createLogger('room');

const playStore = usePlayStore();
const userStore = useUserStore();

const playerRef = ref<any>(null);
const rtcRef = ref<any>(null);

const roomId = ref('');
const isHost = ref(false);
const following = ref(true);
const resolving = ref(false);
const syncHint = ref('');

/** 通话状态 */
const callEnabled = ref(false);
const callStatus = ref<'idle' | 'connecting' | 'connected' | 'error'>('idle');
const hasRemote = ref(false);
const audioOn = ref(true);
const videoOn = ref(true);
/** 悬浮窗是否收起（只留一条名字胶囊，几乎不挡画面） */
const pipMini = ref(false);
/** 已连接的对端数量（实时值，谁进来加一、谁断开减一） */
const peerCount = ref(0);
/** 已连接的对端昵称列表（按连接建立顺序） */
const peerNames = ref<string[]>([]);
/** 当前播放倍速（房主为基准） */
const playbackRate = ref(1);

/**
 * 播放器是否处于全屏。
 *
 * 全屏时播放器是 fixed + z-index 9999，会盖住页面里的所有普通元素，
 * 因此通话控制条必须同步切换为浮层，否则用户在全屏下无法挂断。
 */
const playerFullscreen = ref(false);

/* ---------------- 通话悬浮窗（参照抖音「一起刷」） ---------------- */

/**
 * 悬浮窗位置。
 *
 * 用**左上角坐标**而非 right/bottom：拖动时改 left/top 最直观，
 * 且换到不同宽度屏幕上仍能按同样的边界规则夹取。
 */
const pipX = ref(0);
const pipY = ref(0);
/** 是否已按屏幕尺寸初始化过位置（避免 onLoad 时拿不到窗口尺寸） */
const pipPlaced = ref(false);
/** 屏幕尺寸（px），拖动边界与初始位置都依赖它 */
const screenW = ref(375);
const screenH = ref(667);

/** 当前是否横屏（横屏时悬浮窗停靠右侧，竖屏停靠上方） */
const isLandscapeScreen = computed(() => screenW.value > screenH.value);

/** 收起态：一条名字胶囊。 */
const PIP_MINI_W = 84;
const PIP_MINI_H = 26;
/** 展开态标题栏高度（px），与样式里的 &__pip-bar 对应 */
const PIP_BAR_H = 26;

/**
 * 展开态宽度（px）。
 *
 * 刻意做得**明显小**于按屏宽能放下的最大值：
 * 用户要的是「视频不要占满」，留位置给主画面。
 * 竖屏 112 / 横屏 132，约等于手机上一张缩略图的宽度。
 */
const pipWidth = computed(() => {
    if (pipMini.value) return PIP_MINI_W;
    return isLandscapeScreen.value ? 132 : 112;
});

/**
 * 展开态高度。
 *
 * 画面区按 3:4 竖版反算（宽 / 0.75）再加标题栏 ——
 * 通话是竖构图的半身像，用竖版比例比横版更省侧边空间。
 */
const pipHeight = computed(() => {
    if (pipMini.value) return PIP_MINI_H;
    return Math.round(pipWidth.value / 0.75) + PIP_BAR_H;
});

/** 悬浮窗内联样式：位置 + 尺寸。 */
const pipStyle = computed(() => ({
    left: `${pipX.value}px`,
    top: `${pipY.value}px`,
    width: `${pipWidth.value}px`,
    height: `${pipHeight.value}px`
}));

/**
 * 悬浮窗水平是否靠右。
 *
 * 展开态宽高比竖版（宽 < 高），贴左或贴右都不影响观感，
 * 但标签文字对齐要跟着变 —— 靠右时文字右对齐更自然。
 */
const pipAlignRight = computed(() => pipX.value + pipWidth.value / 2 > screenW.value / 2);

/**
 * 把坐标夹在可视区域内。
 *
 * 边距要避开真实的遮挡物：
 *   · 顶部：竖屏有状态栏 + 自定义导航栏，横屏则几乎没有
 *   · 底部：竖屏有通话控制条（随文档流），全屏时它变成底部浮层，
 *     两者都要留出高度，否则悬浮窗会被压在控制条下面点不到
 */
function clampPip(x: number, y: number) {
    const padTop = isLandscapeScreen.value ? 8 : 60;

    /*
     * 底部让位：
     *   全屏 —— 控制条是居中的底部浮层（底距 44 + 自身高约 36），留 88
     *   竖屏 —— 控制条与底部 tabbar 都在下方，留足 90
     *   横屏非全屏 —— 实际不会出现（横屏只在全屏内发生），留小边即可
     */
    let padBottom = 8;
    if (playerFullscreen.value) padBottom = 88;
    else if (!isLandscapeScreen.value) padBottom = 90;

    const maxX = Math.max(8, screenW.value - pipWidth.value - 8);
    const maxY = Math.max(padTop, screenH.value - pipHeight.value - padBottom);
    return {
        x: Math.min(Math.max(8, x), maxX),
        y: Math.min(Math.max(padTop, y), maxY)
    };
}

/**
 * 默认停靠位置。
 *
 * 参照抖音「一起刷」：小窗靠边、不压画面中心。
 *   · 竖屏 —— 贴右上角（主画面在下方，顶部留给小窗）
 *   · 横屏 —— 贴右侧居中（主画面横向铺开，右侧竖条最省视线）
 */
function placePipDefault() {
    const w = pipWidth.value;
    // 收起态统一贴右上角即可，不区分方向
    if (pipMini.value) {
        pipX.value = Math.max(8, screenW.value - w - 10);
        pipY.value = isLandscapeScreen.value ? 10 : 84;
        pipPlaced.value = true;
        return;
    }

    pipX.value = Math.max(8, screenW.value - w - 10);
    if (isLandscapeScreen.value) {
        // 右侧垂直居中
        const mid = Math.round((screenH.value - pipHeight.value) / 2);
        const next = clampPip(pipX.value, mid);
        pipY.value = next.y;
    } else {
        pipY.value = 76;
    }
    pipPlaced.value = true;
}

/* ---------------- 拖动 ---------------- */

/** 拖动起点：手指位置 + 窗口位置 */
let dragOrigin: { x: number; y: number; left: number; top: number } | null = null;
/** 是否真的发生了位移（用于区分「点击」与「拖动」） */
let dragMoved = false;

function onPipTouchStart(e: any) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    dragOrigin = { x: t.clientX, y: t.clientY, left: pipX.value, top: pipY.value };
    dragMoved = false;
}

function onPipTouchMove(e: any) {
    if (!dragOrigin) return;
    const t = e.touches && e.touches[0];
    if (!t) return;

    const dx = t.clientX - dragOrigin.x;
    const dy = t.clientY - dragOrigin.y;
    // 超过阈值才算拖动，否则手指轻微抖动会误吞点击
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 6) return;
    dragMoved = true;

    const next = clampPip(dragOrigin.left + dx, dragOrigin.top + dy);
    pipX.value = next.x;
    pipY.value = next.y;
}

/**
 * 结束拖动：吸附到最近的左右边缘。
 *
 * 微信小窗就是这个手感 —— 松手后自动贴边，不会停在屏幕正中挡画面。
 */
function onPipTouchEnd() {
    if (!dragOrigin) return;
    dragOrigin = null;
    if (!dragMoved) return;

    const w = pipWidth.value;
    const center = pipX.value + w / 2;
    const goLeft = center < screenW.value / 2;
    pipX.value = goLeft ? 8 : Math.max(8, screenW.value - w - 8);

    // 夹一次：缩小态吸附后高度变化可能越界
    const next = clampPip(pipX.value, pipY.value);
    pipX.value = next.x;
    pipY.value = next.y;
}

/** 点击（未拖动）时切换展开/缩小。 */
function onPipTap() {
    if (dragMoved) {
        dragMoved = false;
        return;
    }
    togglePipMini();
}
/** 本地画面是否就绪（用于判断能否广播片源） */
const localReady = ref(false);

const collections = ref<Collection[]>([]);
const currentIndex = ref(0);
const vodId = ref(0);
/** 当前影片名（房主广播给观众用） */
const vodName = ref('');

/** 观众侧：尚未拿到片源，属于正常等待状态（不是出错）。 */
const showWaitTip = computed(() => !playStore.playUrl && !resolving.value);

/** 等待提示：区分房主与观众两种身份。 */
const waitTip = computed(() => {
    if (isHost.value) {
        return '回到「首页」挑一部影片播放，双方即可同屏观看。';
    }
    return '房主还没开始播放。留在这里即可，房主一开始播放就会自动同步过来。';
});

/** 加载提示文案。 */
const loadingText = computed(() => {
    if (resolving.value) return '正在加载影片';
    return isHost.value ? '还没有选择影片' : '等待房主选片';
});

/* ---------------- 正在看什么 ---------------- */

/** 当前影片名；无影片时为空串。 */
const nowPlayingText = computed(() => (vodName.value || '').trim());

/** 空状态文案：按身份给出下一步该做什么。 */
const nowPlayingEmptyText = computed(() =>
    isHost.value ? '还没选片，去首页挑一部' : '等待房主选片'
);

/**
 * 当前集数标签。
 *
 * 剧集名（如「第 03 集」「HD 中字」）优先，取不到时退回「第 N 集」——
 * 各源的剧集字段命名不一，用序号兜底比显示空白好。
 */
const episodeLabel = computed(() => {
    if (!nowPlayingText.value) return '';
    const item = collections.value[currentIndex.value];
    if (item && item.title) return item.title;
    return `第 ${currentIndex.value + 1} 集`;
});

let broadcastTimer: any = null;

/** 显示名：用本地昵称，随信令 metadata 发给对端。 */
const displayName = computed(() => userStore.nickname || '观影人');

/** 通话状态文案。 */
const statusText = computed(() => {
    if (!callEnabled.value) return '未开始';
    if (callStatus.value === 'connecting') return '连接中…';
    if (callStatus.value === 'error') return '连接异常';
    return hasRemote.value ? '对方已接入' : '等待对方接入';
});

/**
 * 收起态的文案。
 *
 * 胶囊宽度只有 84px，塞不下「A 等 3 人」这类长文案，
 * 故只取第一个人的名字（多出来的用「+N」表示）。
 */
const miniLabel = computed(() => {
    const n = peerCount.value;
    const first = peerNames.value[0];
    if (n === 0) return '通话中';
    if (n === 1) return first || '好友';
    return `${first || '好友'} +${n - 1}`;
});

/**
 * 通话悬浮窗标题。
 *
 * 人数是**实时已连接的对端数**（谁进来加一、谁断开减一），
 * 并非预先知道会有几个人 —— 信令服务只下发「当前在线成员」。
 *
 * 名字一律取 peerNames（按连接建立顺序排列的名单）：
 * 早先用单个 peerName 变量会被每次新加入的人覆盖，
 * 多人时标题会变成「最后一个加入的人」，显示不稳定。
 */
const pipTitle = computed(() => {
    const n = peerCount.value;
    const first = peerNames.value[0] || '对方';

    if (n === 0) return '等待对方';
    if (n === 1) return first;
    // 「A 等 N 人」：N 是对端总人数（含 A），符合中文习惯
    return `${first} 等 ${n} 人`;
});

/* ---------------- 片源 ---------------- */

async function resolve() {
    resolving.value = true;
    playStore.reset();
    try {
        const current = collections.value[currentIndex.value];
        if (!current) throw new Error('无可用剧集');

        const resolved = await resolvePlayUrl(vodId.value, current.id);
        playStore.setResolved(resolved.url, resolved.backups);
    } catch {
        uni.showToast({ icon: 'none', title: '加载失败，请稍后重试' });
    } finally {
        resolving.value = false;
    }
}

async function loadDetail() {
    try {
        const res = await getVodDetail(vodId.value);
        collections.value = res?.vod_collection || [];
        await resolve();
    } catch {
        uni.showToast({ icon: 'none', title: '加载失败' });
    }
}

/* ---------------- 播放同步 ---------------- */

/**
 * 房主定时广播播放状态 + 片源信息 + 倍速。
 *
 * 三件事一起做：
 *   1. 进度对齐（观众按位置 seek）
 *   2. 片源对齐（观众侧若还没片源，或房主切了片，直接跟过去）
 *   3. 倍速对齐（倍速必须全体一致，否则进度会持续错位）
 *
 * 观众侧进房时只带邀请码、不知道看什么，靠这里拿到
 * vodId / 集数，再自行解析播放地址（两端各自拉流，不走 RTC）。
 */
function startBroadcast() {
    if (!isHost.value) return;
    stopBroadcast();

    const push = () => {
        const position = playerRef.value?.getCurrentTime?.() || 0;
        const state = { playing: true, position, updatedAt: Date.now() };
        playStore.updateRemoteState(state);

        // 片源信息：观众据此加载同一部影片
        rtcRef.value?.broadcast?.({
            type: 'source',
            vodId: vodId.value,
            index: currentIndex.value,
            vodName: vodName.value
        });
        rtcRef.value?.broadcastState(state);
        // 倍速随状态一起下发：它是「全体一致」的参数
        rtcRef.value?.broadcast?.({ type: 'rate', rate: playbackRate.value });
    };

    push();
    broadcastTimer = setInterval(push, 3000);
}

function stopBroadcast() {
    if (broadcastTimer) {
        clearInterval(broadcastTimer);
        broadcastTimer = null;
    }
}

/** 播放进度回调：观众侧做对齐。 */
function onTimeUpdate(payload: { currentTime: number }) {
    if (isHost.value || !following.value) return;

    const remote = playStore.remoteState;
    if (!remote) return;

    const elapsed = (Date.now() - remote.updatedAt) / 1000;
    const expected = remote.position + (remote.playing ? elapsed : 0);
    if (Math.abs(payload.currentTime - expected) > DRIFT_THRESHOLD) {
        syncHint.value = `已对齐到 ${Math.floor(expected)} 秒`;
        playerRef.value?.seek?.(expected);
        setTimeout(() => (syncHint.value = ''), 2000);
    }
}

function onEnded() {
    const next = currentIndex.value + 1;
    if (next < collections.value.length) {
        currentIndex.value = next;
        resolve();
    }
}

/* ---------------- 通话 ---------------- */

function startCall() {
    callEnabled.value = true;
}

function endCall() {
    rtcRef.value?.destroy?.();
    callEnabled.value = false;
    hasRemote.value = false;
    callStatus.value = 'idle';
    localReady.value = false;
    stopBroadcast();
}

/**
 * 收到对端昵称。
 *
 * 这里不维护自己的状态：昵称名单统一由 rtc 组件的 peers 事件下发，
 * 另存一份会在多人时互相覆盖，导致「最后一个加入的人」挤掉其他人。
 * 保留该回调是为了留日志，便于排查昵称交换是否成功。
 */
function onPeerName(payload: { id: string; name: string }) {
    if (payload && payload.name) log.info('对端昵称', payload.name);
}

/** 本地画面就绪：房主此时才开始广播（否则观众拿到空的片源信息）。 */
function onLocalReady(_info: any) {
    localReady.value = true;
    if (isHost.value) startBroadcast();
}

/**
 * 切换收起 / 展开。
 *
 * 两种形态的停靠位置刻意不同：
 *   收起 —— 统一挪到右上角。它只是个名字胶囊，放角落最不干扰。
 *   展开 —— 按方向停靠（竖屏贴上方、横屏贴右侧），并保留当前左右侧，
 *           避免用户刚拖到左边、一展开又跳回右边。
 */
function togglePipMini() {
    // 记下展开前的水平位置，展开时尽量保持在同一侧
    const wasLeft = !pipAlignRight.value;

    pipMini.value = !pipMini.value;

    if (pipMini.value) {
        // 收起：右上角
        pipX.value = Math.max(8, screenW.value - pipWidth.value - 10);
        pipY.value = isLandscapeScreen.value ? 10 : 76;
        return;
    }

    // 展开：按方向停靠，沿用之前所在的一侧
    const w = pipWidth.value;
    pipX.value = wasLeft ? 8 : Math.max(8, screenW.value - w - 10);
    const mid = Math.round((screenH.value - pipHeight.value) / 2);
    const targetY = isLandscapeScreen.value ? mid : 76;

    const next = clampPip(pipX.value, targetY);
    pipX.value = next.x;
    pipY.value = next.y;

    /*
     * 收起期间视频容器是 display:none，WebView 可能已暂停解码，
     * 展开后需显式恢复播放，否则画面会停在最后一帧。
     * 等一帧让 DOM 先完成显示，再下发指令。
     */
    setTimeout(() => rtcRef.value?.resume?.(), 60);
}

/**
 * 连接人数变化（多人观影）。
 *
 * 房主每次有人接入/离开都会收到，用于刷新人数展示。
 */
function onPeersChange(payload: { count: number; names: string[] }) {
    peerCount.value = Number(payload?.count) || 0;
    peerNames.value = Array.isArray(payload?.names) ? payload.names : [];
}

/**
 * 本地倍速被改变。
 *
 * 只有房主的改动需要广播 —— 倍速是全体一致的参数，
 * 若观众也能改，各端进度会立刻错位。
 */
function onRateChange(rate: number) {
    playbackRate.value = rate;
    if (!isHost.value) {
        // 观众侧改倍速会被下一次同步覆盖，这里明确告知原因
        uni.showToast({ icon: 'none', title: '倍速由房主统一控制' });
        return;
    }
    rtcRef.value?.broadcast?.({ type: 'rate', rate });
}

function onCallStatus(s: 'idle' | 'connecting' | 'connected' | 'error') {
    callStatus.value = s;
}

function onRemoteChange(on: boolean) {
    hasRemote.value = on;
    if (on) {
        log.info('对方已接入通话');
        // 房主在对方接入后立刻推一次片源，观众无需等待下一个广播周期
        if (isHost.value) startBroadcast();
    }
}

/**
 * 收到对端经数据通道发来的消息。
 *
 * 房主会发三类：
 *   source —— 正在看什么（观众据此加载同一部影片）
 *   state  —— 播放进度（观众据此对齐）
 *   rate   —— 播放倍速（观众跟随，保证进度不错位）
 */
function onChannelMessage(msg: any) {
    if (!msg) return;

    if (msg.type === 'source') {
        // 房主是片源基准，观众只跟随
        if (isHost.value) return;
        if (!msg.vodId) return;

        const sameVod = vodId.value === Number(msg.vodId);
        const sameIndex = currentIndex.value === Number(msg.index);
        if (sameVod && sameIndex && playStore.playUrl) return;

        log.info('跟随房主片源', msg.vodName, '第', Number(msg.index) + 1, '集');
        vodId.value = Number(msg.vodId);
        currentIndex.value = Number(msg.index) || 0;
        vodName.value = msg.vodName || '';
        loadDetail();
        return;
    }

    if (msg.type === 'state') {
        if (isHost.value) return;   // 房主是时间基准，不跟随
        playStore.updateRemoteState({
            playing: !!msg.playing,
            position: Number(msg.position) || 0,
            updatedAt: Number(msg.updatedAt) || Date.now()
        });
        return;
    }

    if (msg.type === 'rate') {
        if (isHost.value) return;   // 倍速由房主决定
        const r = Number(msg.rate);
        if (!(r > 0)) return;
        // 只在确有差异时下发指令，避免每次广播都打扰播放器
        if (Math.abs(r - playbackRate.value) < 0.001) return;

        log.info('跟随房主倍速', r);
        playbackRate.value = r;
        playerRef.value?.setRate?.(r);
        uni.showToast({ icon: 'none', title: `已切换为 ${r}×（房主设置）` });
        return;
    }
}

function onCallError(e: any) {
    log.error('通话异常', (e && e.message) || e);
    uni.showToast({ icon: 'none', title: (e && e.message) || '通话异常' });
}

function toggleAudio() {
    audioOn.value = !audioOn.value;
    rtcRef.value?.setAudio?.(audioOn.value);
}

function toggleVideo() {
    videoOn.value = !videoOn.value;
    rtcRef.value?.setVideo?.(videoOn.value);
}

function switchCamera() {
    rtcRef.value?.switchCamera?.();
}

function toggleFollow() {
    following.value = !following.value;
    uni.showToast({ icon: 'none', title: following.value ? '跟随房主' : '已取消跟随' });
}

function copyRoomId() {
    uni.setClipboardData({
        data: roomId.value,
        success: () => uni.showToast({ icon: 'none', title: '房间号已复制，发给好友即可加入' })
    });
}

/**
 * 房主去挑影片。
 *
 * 房间号已存进本地（见 saveActiveRoom），从首页选片后回到房间页
 * 会自动复用同一房间，因此这里只需回首页即可。
 */
function goPickVideo() {
    uni.switchTab({
        url: '/pages/index/index',
        fail: () => uni.navigateTo({ url: '/pages/index/index' })
    });
}

/**
 * 邀请好友。
 *
 * 优先调系统分享（App 端可直达微信等）；不可用时退回「复制 + 提示」，
 * 保证任何平台都能完成邀请。
 */
function invite() {
    const text = `一起看片吧！打开映话，在「我的」页输入房间号 ${roomId.value} 就能加入。`;
    // #ifdef APP-PLUS
    try {
        uni.share({
            provider: 'weixin',
            scene: 'WXSceneSession',
            type: 0,
            summary: '映话 · 一起看',
            href: 'https://yinghua.app',
            title: '一起看片',
            content: text,
            success: () => {},
            fail: () => {
                uni.setClipboardData({
                    data: text,
                    success: () => uni.showToast({ icon: 'none', title: '邀请文案已复制' })
                });
            }
        });
        return;
    } catch (e) {
        /* 落到下面的兜底 */
    }
    // #endif

    uni.setClipboardData({
        data: text,
        success: () => uni.showToast({ icon: 'none', title: '邀请文案已复制，发给好友即可' })
    });
}

/* ---------------- 生命周期 ---------------- */

/** 播放器内部按钮切了全屏：重算悬浮窗可用范围。 */
function onLandscapeChange(on: boolean) {
    playerFullscreen.value = !!on;
    // 横竖屏切换后 windowWidth/Height 互换，必须重新读取
    initPipPosition();
}

/**
 * 播放器内部切了方向。
 *
 * 全屏内切横竖屏时，windowWidth/Height 也会互换（真机锁屏方向会改视口），
 * 因此同样要重算，否则悬浮窗会停在屏幕外或压住边缘。
 */
function onOrientationChange() {
    initPipPosition();
}

/**
 * 初始化悬浮窗位置。
 *
 * 必须在拿到真实窗口尺寸后调用：初始位置依赖屏宽（右上角），
 * 写死数值在平板/小屏上会跑出可视区。
 */
function initPipPosition() {
    try {
        const info = uni.getSystemInfoSync();
        screenW.value = info.windowWidth || info.screenWidth || 375;
        screenH.value = info.windowHeight || info.screenHeight || 667;
    } catch (e) {
        /* 取不到就沿用默认值 */
    }
    if (!pipPlaced.value) placePipDefault();
    else {
        // 已在别处放过：只重新夹一次边界（旋转后宽高变了）
        const next = clampPip(pipX.value, pipY.value);
        pipX.value = next.x;
        pipY.value = next.y;
    }
}

onLoad(options => {
    const optVodId = Number(options?.vodId || 0);
    currentIndex.value = Number(options?.index || 0);

    /*
     * 三种进入方式：
     *   1. 从「我的」页输入邀请码 —— 只有 roomId，成为观众，
     *      片源由房主经通话通道同步过来
     *   2. 从播放页点「一起看」—— 带 vodId，成为房主
     *   3. 房主中途离开后再回来 —— 沿用已保存的房间，避免房间散掉
     */
    const joinId = String(options?.roomId || '').toUpperCase();

    if (joinId && isRoomCode(joinId)) {
        // 观众：加入既有房间
        roomId.value = joinId;
        isHost.value = false;
        vodId.value = optVodId;
    } else {
        // 房主：优先复用未结束的房间（比如从首页挑完片再回来）
        const saved = loadActiveRoom();
        if (saved && saved.isHost) {
            roomId.value = saved.roomId;
            isHost.value = true;
            vodId.value = optVodId || saved.vodId || 0;
            if (!optVodId && typeof saved.index === 'number') currentIndex.value = saved.index;
        } else {
            roomId.value = generateRoomId();
            isHost.value = true;
            vodId.value = optVodId;
        }
    }

    // 记住房间，供跨页返回时复用
    saveActiveRoom({
        roomId: roomId.value,
        isHost: isHost.value,
        vodId: vodId.value || undefined,
        index: currentIndex.value
    });

    playStore.enterRoom(roomId.value, isHost.value);
    userStore.refresh();

    if (vodId.value) {
        loadDetail();
    }
    // 观众侧不主动加载片源，等房主广播

    // 悬浮窗初始位置依赖窗口尺寸，在页面参数就绪后一次性放好
    initPipPosition();
});

/**
 * 切后台时挂断。
 *
 * 必须同时关掉悬浮窗（callEnabled=false），否则回到前台会看到
 * 一个「还在但已断开」的窗口，用户点屏幕没有任何反应。
 * 摄像头/麦克风也必须在后台释放，避免长期占用与耗电。
 */
onHide(() => {
    if (callEnabled.value) {
        rtcRef.value?.destroy?.();
        callEnabled.value = false;
        hasRemote.value = false;
        callStatus.value = 'idle';
        localReady.value = false;
        stopBroadcast();
    }
});

onUnload(() => {
    stopBroadcast();
    rtcRef.value?.destroy?.();
    playStore.leaveRoom();
    playStore.reset();
});
</script>

<style lang="scss" scoped>
.room {
    min-height: 100vh;
    min-height: 100dvh;
    background-color: #0b0d10;
    /* 底部安全区：说明文字会被 iPhone 小黑条压住 */
    padding-bottom: calc(60rpx + env(safe-area-inset-bottom));

    &__stage {
        position: relative;
        width: 100%;
        height: 420rpx;
        background-color: #000;
    }

    &__player {
        width: 100%;
        height: 100%;
    }

    &__loading {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    &__loading-text {
        font-size: 26rpx;
        color: #6b7280;
    }

    &__loading-tip {
        margin-top: 20rpx;
        padding: 0 60rpx;
    }

    &__loading-tip-text {
        font-size: 22rpx;
        line-height: 1.7;
        color: #4b5563;
        text-align: center;
    }

    &__pick {
        margin-top: 24rpx;
        align-self: center;
        padding: 14rpx 40rpx;
        border-radius: 34rpx;
        background-color: #f0a63c;
    }

    &__pick-text {
        font-size: 26rpx;
        font-weight: 600;
        color: #0b0d10;
    }

    /* ---------- 通话悬浮窗（微信小窗风格） ---------- */

    /*
     * 位置由 JS 用 left/top 精确控制（拖动 + 贴边吸附），
     * 因此这里不写 right/bottom，只保证层级与外观。
     *
     * z-index 取 99999：高于播放器全屏的 9999，也高于 uni-app 的
     * tabbar / 自定义导航栏（约 100），保证任何情况下都压在最上层。
     */
    &__pip {
        position: fixed;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        border-radius: 10rpx;
        overflow: hidden;
        background-color: #000;
        box-shadow: 0 8rpx 28rpx rgba(0, 0, 0, 0.72);
        border: 1rpx solid rgba(255, 255, 255, 0.18);
        /* 拖动跟手：禁掉浏览器默认手势与长按选中 */
        touch-action: none;
        user-select: none;
    }

    /*
     * 收起态：整个窗口缩成一条名字胶囊。
     * 视频与标题栏都用 display:none 藏起来 —— 注意**不能**用 v-if 卸载，
     * yh-rtc 是 renderjs 组件，卸载等于挂断通话。
     */
    &__pip--mini {
        border-radius: 999rpx;
        background-color: rgba(20, 23, 28, 0.92);
    }

    &__pip--mini .room__rtc,
    &__pip--mini .room__pip-bar {
        display: none;
    }

    /* 收起态默认隐藏，展开时才让位给视频 */
    &__pip-mini {
        display: none;
    }

    &__pip--mini .room__pip-mini {
        display: flex;
        flex: 1;
        align-items: center;
        gap: 6rpx;
        padding: 0 10rpx;
        height: 100%;
    }

    /* 通话状态点：接上了才发亮 */
    &__pip-dot {
        flex-shrink: 0;
        width: 10rpx;
        height: 10rpx;
        border-radius: 50%;
        background-color: rgba(255, 255, 255, 0.28);
    }

    &__pip-dot--live {
        background-color: #4ade80;
    }

    &__pip-mini-name {
        flex: 1;
        min-width: 0;
        font-size: 18rpx;
        color: #c9ced6;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &__rtc {
        flex: 1;
        min-height: 0;
        width: 100%;
        background-color: #000;
    }

    &__pip-bar {
        flex: none;
        height: 44rpx;
        padding: 0 10rpx;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6rpx;
        background-color: rgba(20, 23, 28, 0.94);
    }

    &__pip-name {
        flex: 1;
        min-width: 0;
        font-size: 18rpx;
        color: #c9ced6;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    /* 「收起」提示：点击窗口任意处都生效，这里只是个视觉提示 */
    &__pip-mini-text {
        flex-shrink: 0;
        font-size: 18rpx;
        color: #f0a63c;
    }

    /* ---------- 通话控制条 ---------- */

    &__call-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        padding: 20rpx 24rpx 4rpx;
    }

    /*
     * 全屏态：控制条升为浮层，压在播放器之上。
     *
     * 做成**居中的胶囊条**而不是整宽色带：
     * 播放器全屏时底部本来就有一条进度条，整宽浮层会把它整条盖住，
     * 用户看不到播放进度。胶囊只占中间一小段，两侧留空给进度条。
     * 位置略微上移，进一步避开进度条区域。
     */
    &__call-bar--float {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        bottom: calc(44px + env(safe-area-inset-bottom));
        z-index: 99998;
        flex-wrap: nowrap;
        justify-content: center;
        /* 尺寸全用 px：横屏下 rpx 会被放大（见下方按钮注释） */
        gap: 6px;
        padding: 5px 8px;
        border-radius: 999px;
        background-color: rgba(11, 13, 16, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
        /* 宽度由内容决定，不铺满 */
        width: auto;
        right: auto;
    }

    /*
     * 浮层态：**尺寸一律用 px，不用 rpx**。
     *
     * 横屏下 rpx 的基准是屏幕「长边」（约 780px），1rpx ≈ 1.04px，
     * 同一个 56rpx 会比竖屏下大一圈；而这个浮层只在全屏（横屏）时出现，
     * 于是必然偏大。改用 px 后尺寸与屏幕方向无关，稳定可控。
     *
     * 同时整体收紧：横屏的可视高度本来就矮，浮层不能占太多。
     */
    &__call-bar--float .room__bar-btn {
        margin: 0;
        height: 26px;
        padding: 0 11px;
        border-radius: 13px;
    }

    &__call-bar--float .room__bar-text {
        font-size: 12px;
    }

    &__bar-btn {
        height: 64rpx;
        padding: 0 28rpx;
        margin: 0 16rpx 16rpx 0;
        border-radius: 32rpx;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: #1d2128;
    }

    &__bar-btn--primary {
        background-color: #f0a63c;
    }

    &__bar-btn--off {
        background-color: #2a1f1f;
    }

    &__bar-btn--danger {
        background-color: #2a1f1f;
    }

    &__bar-text {
        font-size: 26rpx;
        color: #c9ced6;
        white-space: nowrap;
    }

    &__bar-text--primary {
        color: #0b0d10;
        font-weight: 600;
    }

    &__bar-text--danger {
        color: #d98b85;
    }

    /* ---------- 房间信息 ---------- */

    &__panel {
        margin: 24rpx;
        padding: 32rpx 28rpx;
        border-radius: 20rpx;
        background-color: #14171c;
        border: 1rpx solid rgba(255, 255, 255, 0.05);
    }

    /* 正在看：影片名 + 集数，进房第一眼要看到的信息 */
    &__now {
        display: flex;
        align-items: flex-start;
        padding-bottom: 24rpx;
        margin-bottom: 24rpx;
        border-bottom: 1rpx solid rgba(255, 255, 255, 0.07);
    }

    &__now-label {
        flex-shrink: 0;
        margin-right: 20rpx;
        padding-top: 4rpx;
        font-size: 24rpx;
        color: #6b7280;
    }

    &__now-body {
        flex: 1;
        min-width: 0;
    }

    &__now-name {
        /* 片名可能很长，最多两行后省略 */
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-size: 30rpx;
        font-weight: 600;
        color: #e8eaed;
        line-height: 1.45;
    }

    /* 空状态：弱化，不抢视线 */
    &__now-name--idle {
        font-weight: 400;
        color: #6b7280;
    }

    &__now-ep {
        display: block;
        margin-top: 8rpx;
        font-size: 24rpx;
        color: #f0a63c;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    /* 房间号：当作分享凭证，用大号等宽字突出 */
    &__code {
        display: flex;
        align-items: center;
        padding-bottom: 24rpx;
        border-bottom: 1rpx solid rgba(255, 255, 255, 0.07);
    }

    &__code-label {
        font-size: 24rpx;
        color: #6b7280;
        margin-right: 20rpx;
    }

    &__code-value {
        flex: 1;
        min-width: 0;
        font-size: 44rpx;
        font-weight: 700;
        letter-spacing: 4rpx;
        color: #e8eaed;
        /* 等宽字形：房间号逐位核对时不会因字形宽度不同而看串 */
        font-variant-numeric: tabular-nums;
    }

    &__code-copy {
        flex-shrink: 0;
        padding: 10rpx 26rpx;
        border-radius: 999rpx;
        background-color: rgba(240, 166, 60, 0.16);
    }

    &__code-copy-text {
        font-size: 24rpx;
        color: #f0a63c;
    }

    /* 状态徽标行 */
    &__chips {
        display: flex;
        flex-wrap: wrap;
        gap: 12rpx;
        margin-top: 24rpx;
    }

    &__chip {
        padding: 8rpx 20rpx;
        border-radius: 999rpx;
        background-color: rgba(255, 255, 255, 0.06);
    }

    /* 强调态：房主 / 正在广播 */
    &__chip--accent {
        background-color: rgba(240, 166, 60, 0.16);
    }

    &__chip--accent .room__chip-text {
        color: #f0a63c;
    }

    /* 警示态：观众已取消跟随，需要显眼 */
    &__chip--warn {
        background-color: rgba(217, 139, 133, 0.16);
    }

    &__chip--warn .room__chip-text {
        color: #d98b85;
    }

    &__chip-text {
        font-size: 22rpx;
        color: #9aa3af;
    }

    &__hint {
        margin-top: 20rpx;
    }

    &__hint-text {
        font-size: 24rpx;
        color: #f0a63c;
    }

    &__actions {
        display: flex;
        margin-top: 26rpx;
    }

    &__btn {
        height: 72rpx;
        padding: 0 36rpx;
        margin-right: 20rpx;
        border-radius: 36rpx;
        display: flex;
        align-items: center;
        justify-content: center;
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

    &__note {
        margin: 0 24rpx;
    }

    &__note-text {
        font-size: 24rpx;
        line-height: 1.7;
        color: #6b7280;
    }
}
</style>
