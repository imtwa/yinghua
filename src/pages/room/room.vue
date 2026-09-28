<template>
    <view class="room">
        <yh-nav class="room__nav" title="一起看" />

        <!--
            播放器区。
            通话悬浮窗不在这一层 —— 见下方根层级浮层。
        -->
        <view class="room__stage">
            <yh-player
                v-if="playStore.playUrl"
                ref="playerRef"
                class="room__player"
                :src="playStore.playUrl"
                :autoplay="true"
                :initial-time="0"
                :playback-rate="playbackRate"
                :collections="collections"
                :current-index="currentIndex"
                :title="playerTitle"
                @timeupdate="onTimeUpdate"
                @ratechange="onRateChange"
                @landscapechange="onLandscapeChange"
                @orientationchange="onOrientationChange"
                @episodechange="onEpisodeChange"
                @play="onHostPlay"
                @pause="onHostPause"
                @seeked="onHostSeek"
                @error="onPlayError"
                @ended="onEnded" />

            <view v-else class="room__loading">
                <text class="room__loading-text">{{ loadingText }}</text>
                <view v-if="showWaitTip" class="room__loading-tip">
                    <text class="room__loading-tip-text">{{ waitTip }}</text>
                    <view v-if="isHost" class="room__pick tap tap-solid" @click="goPickVideo">
                        <text class="room__pick-text">搜索并选择影片</text>
                    </view>
                </view>
            </view>
        </view>

        <!--
            通话悬浮窗（参照腾讯会议小窗）。

            刻意放在**页面根层级**而不是播放器区域内部：
            播放器全屏时是 fixed + z-index 9999，且 .room__stage 会形成
            自己的层叠顺序；浮窗挂在页面根、用更高的 z-index 并走 fixed，
            才能保证「无论播放器是否全屏都在最上层」。

            两种形态：
              展开 —— 视频 + 底部悬浮按钮组（麦克风 / 摄像头 / 翻转 / 挂断）
              收起 —— 一条侧边小条，静音 / 挂断常驻，不占画面

            按钮**内嵌在视频里**而非另起一条底部浮层：
            全屏时底部横条会压住播放器的进度条，且遮挡画面下缘。

            注意：收起态**不能**用 v-if 卸载 yh-rtc ——
            那是 renderjs 组件，卸载等于挂断通话。
            这里只切 CSS（display:none），组件保持挂载、通话不断。
        -->
        <!--
            通话悬浮窗。

            **组件的挂载不再依赖「是否开启通话」**（见下方说明）：
            yh-rtc 从进房间起就常驻，因为房间同步的 dataChannel 挂在它上面。
            浮层的外观只由 pipPlaced + callEnabled 控制。

            注意 v-show 而非 v-if：
            用 v-if 会卸载 renderjs 组件 = 挂断通话，房间同步随之断掉。
        -->
        <view
            v-show="pipPlaced"
            class="room__pip"
            :class="{ 'room__pip--mini': pipMini, 'room__pip--hidden': !callEnabled }"
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
                :media-on="callEnabled"
                @status="onCallStatus"
                @remote="onRemoteChange"
                @peers="onPeersChange"
                @peername="onPeerName"
                @message="onChannelMessage"
                @channel="onChannelOpen"
                @localready="onLocalReady"
                @mediaerror="onMediaError"
                @broadcastfail="onBroadcastFail"
                @error="onCallError" />

            <!--
                展开态操作条，压在视频下缘：麦克风 / 摄像头 / 收起。

                收起是**独立按钮**，不再靠「点画面」——
                早先点任意处就收起，拖动或误触都会让窗口突然弹开或缩起，
                很反直觉。现在只有按钮能改变形态（双击画面改为调缩放）。

                图标用内联 SVG（data URI + mask）：
                CSS 手绘的几何图形在小尺寸下形状不清晰，
                SVG 是矢量、跨设备渲染一致，颜色还能随当前状态继承。
            -->
            <view class="room__pip-acts" @click.stop>
                <view
                    class="room__pact tap"
                    :class="{ 'room__pact--off': !audioOn }"
                    @click.stop="toggleAudio">
                    <view class="room__ico" :class="audioOn ? 'room__ico--mic' : 'room__ico--mic-off'" />
                </view>
                <view
                    class="room__pact tap"
                    :class="{ 'room__pact--off': !videoOn }"
                    @click.stop="toggleVideo">
                    <view class="room__ico" :class="videoOn ? 'room__ico--cam' : 'room__ico--cam-off'" />
                </view>
                <view class="room__pact tap" @click.stop="collapsePip">
                    <view class="room__ico room__ico--shrink" />
                </view>
            </view>

            <!--
                收起态：横向胶囊，三个按钮（麦克风 / 挂断 / 展开）。

                胶囊本体**不响应点击**，只有按钮改变形态 ——
                早先它是 40×76 的细竖条且点任意处就展开，
                拖动时极易误触，一碰就弹开挡画面。

                挂断只在这里给：全屏时页面的通话条是隐藏的，
                收起态若不给挂断入口，用户在全屏里就没法挂断了。
            -->
            <view class="room__mini">
                <view
                    class="room__mini-act tap"
                    :class="{ 'room__mini-act--off': !audioOn }"
                    @click.stop="toggleAudio">
                    <view class="room__ico" :class="audioOn ? 'room__ico--mic' : 'room__ico--mic-off'" />
                </view>
                <view class="room__mini-act room__mini-act--hangup tap" @click.stop="endCall">
                    <view class="room__ico room__ico--hangup" />
                </view>
                <view class="room__mini-act tap" @click.stop="expandPip">
                    <view class="room__ico room__ico--expand" />
                </view>
            </view>
        </view>

        <!--
            下半部分：只在这一层滚动。
            导航栏与播放器区固定不动 —— 与播放页保持一致，
            否则向上滑时视频会被滚出屏幕，看不见画面。
        -->
        <scroll-view class="room__body" scroll-y :show-scrollbar="false">
            <!--
                通话控制条。

                **仅非全屏时显示**：全屏时同样的按钮已内嵌在通话悬浮窗里，
                若再浮一条横条会与它重复，并且横条会压住播放器的进度条。
            -->
            <view v-if="!playerFullscreen" class="room__call-bar">
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
                放在最上方：进房间后用户第一个想知道的就是「现在在播什么」。
                房主右侧多一个「换片」入口 —— 换片全程不离开房间、不断通话。
            -->
            <view class="room__now">
                <text class="room__now-label">正在看</text>
                <view class="room__now-body">
                    <text v-if="nowPlayingText" class="room__now-name">{{ nowPlayingText }}</text>
                    <text v-else class="room__now-name room__now-name--idle">{{ nowPlayingEmptyText }}</text>
                    <text v-if="episodeLabel" class="room__now-ep">{{ episodeLabel }}</text>
                </view>
                <view v-if="isHost" class="room__now-switch tap tap-solid" @click="goPickVideo">
                    <text class="room__now-switch-text">{{ nowPlayingText ? '换片' : '选片' }}</text>
                </view>
            </view>

            <!--
                选片中的明确提示。
                房主离开页面去选片时，双方都显示 —— 此前观众只有一句静态的
                「等待房主选片」，房主真在挑片时反而看不出任何变化。
            -->
            <view v-if="hostPicking" class="room__picking">
                <view class="room__picking-dot" />
                <text class="room__picking-text">
                    {{ isHost ? '正在选片，选好会自动切过去' : '房主正在选片，稍等一下' }}
                </text>
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
                <view class="room__chip" :class="{ 'room__chip--warn': callStatus === 'error' }">
                    <text class="room__chip-text">{{ statusText }}</text>
                </view>
                <view class="room__chip">
                    <text class="room__chip-text">{{ playbackRate }}×</text>
                </view>
            </view>

            <!-- 同步状态提示 -->
            <view v-if="!isHost && syncHint" class="room__hint">
                <text class="room__hint-text">{{ syncHint }}</text>
            </view>

            <!--
                房间同步未建立的提示（房主侧）。
                房主以为一切正常、观众却在干等，是最难自查的故障 ——
                把「消息发不出去」直接说出来，用户能立刻意识到是通话没连上。
            -->
            <view v-if="isHost && syncBroken && callEnabled" class="room__hint room__hint--warn">
                <text class="room__hint-text">
                    房间同步未建立：对方还没接入通话。请让对方用同一房间号加入。
                </text>
            </view>

            <!-- 摄像头/麦克风不可用：不影响看片同步，故单独提示并提供重试 -->
            <view v-if="callEnabled && rtcMediaError" class="room__hint room__hint--warn">
                <text class="room__hint-text">{{ rtcMediaError }}</text>
                <view class="room__hint-btn tap tap-solid" @click="retryMedia">
                    <text class="room__hint-btn-text">重试摄像头</text>
                </view>
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
            选集（页面内，无需进全屏）。
            房主可点选，观众只读 —— 选集由房主统一决定，
            否则两端各自切集会立刻不同步。

            早先只能在播放器全屏后的面板里选，且那份数据还没传进去
            （播放器拿不到剧集列表），等于完全没法选集。
        -->
        <view v-if="collections.length" class="room__episodes">
            <view class="room__episodes-head">
                <text class="room__episodes-title">选集</text>
                <text class="room__episodes-count">
                    {{ collections.length }} 集{{ isHost ? '' : ' · 由房主选择' }}
                </text>
            </view>
            <scroll-view class="room__episodes-scroll" scroll-y :show-scrollbar="false">
                <yh-episode
                    :collections="collections"
                    :current-index="currentIndex"
                    @select="onGridSelect" />
            </scroll-view>
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

        <!-- 底部留白，避免最后一块内容贴着屏幕底边 -->
        <view class="room__tail" />
        </scroll-view>
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
import { onBackPress, onHide, onLoad, onShow, onUnload } from '@dcloudio/uni-app';
import type { Collection } from '@/api/types';
import { resolvePlayUrl } from '@/services/play';
import { getVodDetail } from '@/services/video';
import { usePlayStore } from '@/stores/play';
import { useUserStore } from '@/stores/user';
import { createLogger } from '@/utils/logger';
import {
    DRIFT_THRESHOLD,
    clearActiveRoom,
    clearPendingPick,
    generateRoomId,
    isRoomCode,
    loadActiveRoom,
    loadPendingPick,
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

/**
 * 观众侧当前是否处于「正在播放」状态。
 *
 * 用途是**去重**：房主每 3 秒广播一次 state，
 * 若每次都无脑下发 play/pause 指令，会把播放器反复打断
 * （尤其 play 会触发重新缓冲）。只在状态真正翻转时才下发。
 */
let isGuestPlaying = false;
const resolving = ref(false);
const syncHint = ref('');

/** 通话状态 */
const callEnabled = ref(false);
const callStatus = ref<'idle' | 'connecting' | 'connected' | 'error'>('idle');

/**
 * 房主是否正在选片页挑影片。
 *
 * 用来守住 onHide —— 跳转到选片页也会触发 onHide，
 * 而 onHide 原本会销毁通话（那是为「切后台释放摄像头」设计的）。
 * 不加这个标志，房主一进选片页通话就断了。
 */
const pickingVideo = ref(false);

/**
 * 房间当前是否处于「房主正在选片」状态（双方都显示）。
 *
 * 房主：进入选片页时置 true，选完/返回时置 false。
 * 观众：收到房主广播的 picking 消息时同步。
 * 有它之前，观众侧只有一句静态的「等待房主选片」，
 * 房主换片过程中完全看不出发生了什么。
 */
const hostPicking = ref(false);
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

/**
 * 收起态：横向胶囊，三个按钮（麦克风 / 挂断 / 展开）。
 *
 * 做成横向且**不响应整条点击**：
 * 早先是 40×76 的竖条，点任意处就展开 —— 它又小又贴着边缘，
 * 拖动时极易误触，一碰就弹开挡画面。现在只有按钮能改变形态。
 */
const PIP_MINI_W = 104;
const PIP_MINI_H = 34;

/**
 * 展开态的尺寸档位（相对基准宽的倍数）。
 *
 * 双击画面循环切换：小 → 中 → 大 → 小。
 * 基准宽就是**最小档**，即改造前的大小。
 */
const PIP_SCALES = [1, 1.32, 1.72];

/** 当前尺寸档位下标 */
const pipScaleIdx = ref(0);

/** 当前缩放倍数，供样式里的 calc() 使用 */
const pipScale = computed(() => PIP_SCALES[pipScaleIdx.value]);

/**
 * 悬浮窗尺寸的约束基准：屏幕的**短边**。
 *
 * 不能直接拿屏宽做基准 —— 横屏全屏时屏宽会变成 800 之类的大值，
 * 于是「宽度上限 = 屏宽 62%」算出 496px，浮窗被撑得极宽；
 * 而浮窗高度是按「宽 / 0.75」反算的竖版比例，宽度一撑高就跟着涨，
 * 在只有 375px 高的横屏里几乎没有纵向余量：
 *
 *   实测 800x375 横屏 · 展开态中档 → 浮窗 174x272，纵向仅可拖 0..103px
 *
 * 结果就是「全屏时浮窗被钉在屏幕上方、拖不下来」。
 * 改用短边（横屏时即屏高）作基准，浮窗在横屏下自然变小，
 * 纵向才有足够的拖动空间。
 *
 * 注意 screenW/screenH 会被 syncViewport() 实时刷新，
 * 因此这里始终反映当前屏幕状态。
 */
const pipBasis = computed(() => Math.min(screenW.value, screenH.value));

/**
 * 底部操作条高度（px）。
 *
 * **固定值，不随档位缩放** —— 必须与样式里 `&__pip-acts` 的 height 一致，
 * 否则反算出的宽度会与实际渲染不符（画面区被撑变形）。
 *
 * 不随档位放大的理由见样式注释：浮窗高度有上限，
 * 操作条若跟着变大，最大档的画面区反而比中档小。
 */
const PIP_ACTS_H = 30;

/**
 * 展开态高度上限：短边的 62%。
 *
 * 上限的作用是保证纵向**留出足够的拖动余量** ——
 * 浮窗本就要能满屏放，若它自己占掉七成高度，可拖范围就只剩一小条，
 * 用户会觉得「拖不动」。横屏场景尤其明显：屏高仅 375px，
 * 浮窗按 3:4 竖版自然尺寸会长到 270px 以上，纵向只剩 105px。
 *
 * 取 62%（横屏约 232px）而非更小值，是为了让**三个档位仍有区分度**：
 * 上限压得太低时中档与最大档会双双顶到上限、尺寸完全一样，
 * 双击放大就没有效果了。
 */
const PIP_MAX_H_RATIO = 0.62;

/**
 * 展开态高度。
 *
 * **缩放档位作用在高度上**，宽度再由高度反算 —— 这样三个档位
 * 在两种屏幕方向下都保持「小 → 中 → 大」的单调递增。
 *
 * 早先的写法是「先算宽度再按 3:4 反算高度」，在横屏下会与
 * 高度上限互相打架：上限把高度截住后，宽度反而越大档位越窄。
 *
 * 基准取短边的 34%：横屏约 128、竖屏约 227，
 * 乘档位系数（1 / 1.32 / 1.72）后中档恰好接近上限、
 * 最大档顶到上限，三档尺寸因此分明。
 */
const pipHeight = computed(() => {
    if (pipMini.value) return PIP_MINI_H;
    const base = pipBasis.value * 0.34;
    const scaled = base * pipScale.value;
    const cap = pipBasis.value * PIP_MAX_H_RATIO;
    /*
     * 下限 150px。
     *
     * 横屏下短边仅 375，基准 34% 算出的最小档高度只有 127px，
     * 减去操作条后画面区只剩 97px —— 对方的脸几乎看不清。
     * 抬到 150px 后画面区约 120px，可用且与中档仍有区分度。
     */
    return Math.round(Math.max(Math.min(scaled, cap), 150));
});

/**
 * 展开态宽度。
 *
 * 由高度反算（去掉**当前档位**的操作条后按 3:4 竖版比例），
 * 再受短边 62% 约束 —— 保证竖屏下不会盖住大半个画面。
 */
const pipWidth = computed(() => {
    if (pipMini.value) return PIP_MINI_W;
    const byHeight = (pipHeight.value - PIP_ACTS_H) * 0.75;
    return Math.round(Math.min(byHeight, pipBasis.value * 0.62));
});

/** 悬浮窗内联样式：位置 + 尺寸 + 缩放系数（供内部 calc 用）。 */
const pipStyle = computed(() => ({
    left: `${pipX.value}px`,
    top: `${pipY.value}px`,
    width: `${pipWidth.value}px`,
    height: `${pipHeight.value}px`,
    '--pip-scale': String(pipScale.value)
}));

/**
 * 同步屏幕尺寸到响应式状态，并返回当前值。
 *
 * 不能依赖缓存值 —— 横屏锁定是**异步**的：播放器调 lockOrientation
 * 后立刻 emit landscapechange，此刻屏幕还没真正转过来，
 * `window.innerHeight` 仍是竖屏的 667。若此时把 667 记下来当屏高，
 * 横屏下就会算出 `maxY = 667 - 浮窗高` 这种远超真实屏幕的边界 ——
 * 表现为「浮窗能往下拖，但一拖就出屏，看起来像卡在上面」。
 *
 * 因此**每次拖动都现读**，并顺手写回 screenW/screenH，
 * 保证「浮窗尺寸」与「拖动边界」用的是同一份数据（否则两者错配，
 * 边界算出来会比浮窗实际需要的大或小）。
 */
function syncViewport() {
    let w = 0;
    let h = 0;

    // 优先用真实视口（CSS 铺满后的实际渲染尺寸）
    if (typeof window !== 'undefined') {
        w = window.innerWidth || 0;
        h = window.innerHeight || 0;
    }

    // 视口取不到时退回系统信息
    if (!w || !h) {
        try {
            const info = uni.getSystemInfoSync();
            w = info.windowWidth || info.screenWidth || 375;
            h = info.windowHeight || info.screenHeight || 667;
        } catch (e) {
            /* 忽略 */
        }
    }

    w = w || 375;
    h = h || 667;

    // 只在真正变化时写回，避免每次拖动都触发无关的响应式更新
    if (screenW.value !== w) screenW.value = w;
    if (screenH.value !== h) screenH.value = h;

    return { w, h };
}

/**
 * 把坐标夹在可视区域内。
 *
 * 只保留「不让窗口跑出屏幕」这一条最低约束 ——
 * 用户明确要求拖到哪里就是哪里、整个屏幕都能放，不要吸附也不要做
 * 上半屏之类的额外限制。否则窗口一旦被拖出可视区就再也抓不回来。
 *
 * 四周边距都取 0：允许贴着边缘，甚至压住导航栏与进度条，
 * 那属于用户自己的选择，随时能再拖走。
 */
function clampPip(x: number, y: number) {
    const { w, h } = syncViewport();
    const maxX = Math.max(0, w - pipWidth.value);
    const maxY = Math.max(0, h - pipHeight.value);

    return {
        x: Math.min(Math.max(0, x), maxX),
        y: Math.min(Math.max(0, y), maxY)
    };
}

/**
 * 默认停靠位置：贴右上角。
 *
 * 不区分方向与形态 —— 通话窗在两种形态下都是「竖向长条」，
 * 右上角既避开播放器常用的中心与底部区域，也不挡字幕。
 * 最终位置仍会过一遍 clampPip，全屏时自然被限制在上半屏。
 */
function placePipDefault() {
    pipX.value = Math.max(8, screenW.value - pipWidth.value - 10);
    pipY.value = isLandscapeScreen.value ? 10 : 84;
    const next = clampPip(pipX.value, pipY.value);
    pipX.value = next.x;
    pipY.value = next.y;
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
 * 结束拖动。
 *
 * **不做任何吸附** —— 用户明确要求「拖到哪里是哪里」。
 * 早先松手会自动贴到最近的左右边缘，导致窗口总在两边、
 * 想放在中间挡不到的位置却放不了。
 *
 * 这里只做一次边界夹取，防止拖出屏幕后抓不回来。
 */
function onPipTouchEnd() {
    if (!dragOrigin) return;
    dragOrigin = null;
    if (!dragMoved) return;

    const next = clampPip(pipX.value, pipY.value);
    pipX.value = next.x;
    pipY.value = next.y;
}

/**
 * 双击的判定间隔（毫秒）。
 * 移动端 WebView 的 dblclick 事件不可靠，这里自己按时间差判定。
 */
const DOUBLE_TAP_MS = 320;
/** 上一次点击的时间戳 */
let lastTapAt = 0;

/**
 * 点击画面：双击才切换缩放档位。
 *
 * 单击不做事 —— 早先单击就收起，拖动或误触会让窗口突然弹开，
 * 很反直觉。形态切换已收敛到操作条/胶囊上的专用按钮。
 *
 * 必须用 dragMoved 区分「点击」与「拖动」：
 * 拖动结束后 WebView 仍会补发一次 click，
 * 不判断的话每次拖完都会误判成一次点击。
 */
function onPipTap() {
    if (dragMoved) {
        dragMoved = false;
        lastTapAt = 0;
        return;
    }

    const now = Date.now();
    if (now - lastTapAt > DOUBLE_TAP_MS) {
        lastTapAt = now;
        return;
    }

    // 双击生效：小 → 中 → 大 → 小 循环
    lastTapAt = 0;
    cyclePipScale();
}

/**
 * 循环切换缩放档位。
 *
 * 到达最大档后回到最小档 —— 用户要的是「双击放大、到顶再双击缩小」，
 * 与其做方向判断（放大中/缩小中两个状态），循环更简单也不会卡住：
 * 无论当前在哪一档，双击都有确定的下一步。
 */
function cyclePipScale() {
    pipScaleIdx.value = (pipScaleIdx.value + 1) % PIP_SCALES.length;
    // 尺寸变化后原坐标可能越界，重新夹一次
    const next = clampPip(pipX.value, pipY.value);
    pipX.value = next.x;
    pipY.value = next.y;
}

/** 收起为胶囊。 */
function collapsePip() {
    if (pipMini.value) return;
    pipMini.value = true;
    // 胶囊很矮，收起后重新夹取，避免贴近下边缘时超出
    const next = clampPip(pipX.value, pipY.value);
    pipX.value = next.x;
    pipY.value = next.y;
}

/**
 * 从胶囊展开。
 *
 * 展开后视频容器重新可见，WebView 可能已暂停解码，
 * 需显式恢复播放，否则画面会停在最后一帧。
 */
function expandPip() {
    if (!pipMini.value) return;
    pipMini.value = false;

    const next = clampPip(pipX.value, pipY.value);
    pipX.value = next.x;
    pipY.value = next.y;

    // 等一帧让 DOM 先完成显示，再下发指令
    setTimeout(() => rtcRef.value?.resume?.(), 60);
}
/** 本地画面是否就绪（用于判断能否广播片源） */
const localReady = ref(false);

/**
 * 房间同步是否未建立（房主侧）。
 *
 * 由 rtc 的 broadcastfail 事件点亮、由 peers 事件熄灭。
 * 有了它，「观众一直等待房主选片」这类故障在房主侧也能被看见 ——
 * 否则房主看到自己的画面一切正常，完全想不到消息根本没发出去。
 */
const syncBroken = ref(false);

/** 摄像头/麦克风的失败原因（空串表示正常） */
const rtcMediaError = ref('');

const collections = ref<Collection[]>([]);
const currentIndex = ref(0);
const vodId = ref(0);
/** 当前影片名（房主广播给观众用） */
const vodName = ref('');

/** 观众侧：尚未拿到片源，属于正常等待状态（不是出错）。 */
const showWaitTip = computed(() => !playStore.playUrl && !resolving.value);

/**
 * 等待提示：区分房主与观众两种身份。
 *
 * 房主侧的文案要说明「不用离开房间」——
 * 这是本页最容易误解的地方：早先必须退回首页选片，
 * 而那会销毁房间、断掉通话。
 */
const waitTip = computed(() => {
    if (isHost.value) {
        return '点下面的「选片」搜索影片即可，房间和通话都不会中断。';
    }
    return '房主还没选片。留在这里就好，房主一开始播放就会自动同步过来。';
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

/**
 * 全屏顶部栏标题：片名 + 集数。
 *
 * 全屏时画面铺满、看不到下方的「正在看」信息，顶部栏要把这两项
 * 一并给出，否则用户不知道在看第几集。
 */
const playerTitle = computed(() => {
    const name = nowPlayingText.value;
    const ep = episodeLabel.value;
    if (!name) return ep;
    // 分集标题常常本身就含片名，重复时只留分集标题
    if (ep && ep.includes(name)) return ep;
    return ep ? `${name} ${ep}` : name;
});

let broadcastTimer: any = null;

/** 显示名：用本地昵称，随信令 metadata 发给对端。 */
const displayName = computed(() => userStore.nickname || '观影人');

/**
 * 连接状态文案。
 *
 * 注意这里描述的是**信令与房间同步**的状态，与「有没有开摄像头」无关 ——
 * 信令随进房间即建立，因此「未开始」只应出现在信令尚未连上时。
 */
const statusText = computed(() => {
    if (callStatus.value === 'error') return '连接异常';
    if (callStatus.value === 'connecting' || callStatus.value === 'idle') return '连接中…';
    return hasRemote.value ? '对方已接入' : '等待对方接入';
});

/* ---------------- 片源 ---------------- */

/**
 * 解析当前集的播放地址。
 *
 * **切集时绝不能先 `playStore.reset()`。**
 * reset 会清空 playUrl，使页面上的 `v-if="playStore.playUrl"` 判定为假，
 * 播放器组件被销毁重建 —— 全屏状态随之丢失，
 * 表现为「全屏里选一集，画面退出全屏重新加载」。
 * （播放页 play.vue 里有同样的说明，房间页此前漏了。）
 *
 * 切集只是换地址，`setResolved` 会直接覆盖，不需要先清空。
 * 只有**换片**才需要清（见 applyPendingPick），因为要丢弃整部影片的状态。
 */
async function resolve() {
    resolving.value = true;
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
        /*
         * 影片名必须在这里落地。
         * 早先只赋了 collections，vodName 一直是空串 ——
         * 全屏顶部栏的标题因此始终为空（只剩返回键），
         * 「正在看」那一栏也显示不出片名。
         */
        if (res?.vod_name) vodName.value = res.vod_name;
        collections.value = res?.vod_collection || [];
        await resolve();
    } catch {
        uni.showToast({ icon: 'none', title: '加载失败' });
    }
}

/**
 * 切到指定集数（唯一入口）。
 *
 * 房主切集必须广播 —— 早先只有 onEnded 里改了本地下标，
 * 观众完全不知情，会一直停在旧的一集。
 *
 * @param index   目标集下标
 * @param silent  观众侧跟随房主时传 true，避免再广播回去形成回环
 */
function switchToEpisode(index: number, silent = false) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= collections.value.length) return;
    if (i === currentIndex.value) return;

    currentIndex.value = i;
    resolve();

    // 房主的切集要立刻同步给观众，不等下一个 3 秒轮播
    if (!silent && isHost.value) {
        pushSource();
        /*
         * 新的一集从 0 秒开始，进度基准立刻重置。
         *
         * `playing` 取房主当前的真实状态，不写死 true ——
         * 若房主在暂停状态下切集，观众不该被强制播放起来。
         * 用逻辑层的 broadcastState（内部走 broadcast 指令通道）。
         */
        const state = { playing: playerRef.value?.isPlaying?.() ?? true, position: 0, updatedAt: Date.now() };
        playStore.updateRemoteState(state);
        broadcastState(state);
    }
}

/** 全屏内选集面板切集。 */
function onEpisodeChange(index: number) {
    if (!isHost.value) {
        uni.showToast({ icon: 'none', title: '选片选集由房主决定' });
        return;
    }
    switchToEpisode(index);
}

/** 播放页下方选集宫格切集。 */
function onGridSelect(_item: Collection, index: number) {
    onEpisodeChange(index);
}

/* ---------------- 播放同步 ---------------- */

/**
 * 房主定时广播播放状态 + 片源信息 + 倍速 + 选片状态。
 *
 * 四件事一起做：
 *   1. 进度对齐（观众按位置 seek）
 *   2. 片源对齐（观众侧若还没片源，或房主切了片，直接跟过去）
 *   3. 倍速对齐（倍速必须全体一致，否则进度会持续错位）
 *   4. 选片状态（中途加入的观众也能看到「房主在选片」）
 *
 * 观众侧进房时只带邀请码、不知道看什么，靠这里拿到
 * vodId / 集数，再自行解析播放地址（两端各自拉流，不走 RTC）。
 */
function startBroadcast() {
    if (!isHost.value) return;
    stopBroadcast();

    const push = () => {
        const state = currentPlayState();
        playStore.updateRemoteState(state);

        pushSource();
        broadcastState(state);
        // 倍速随状态一起下发：它是「全体一致」的参数
        rtcRef.value?.broadcast?.({ type: 'rate', rate: playbackRate.value });
        /*
         * 选片状态也随轮播下发。
         * 房主进选片页时会立即广播一次，但中途加入的观众收不到那次，
         * 因此每轮都带上当前值，保证任何时刻进来的人都能看到提示。
         */
        rtcRef.value?.broadcast?.({ type: 'picking', on: hostPicking.value });
    };

    push();
    broadcastTimer = setInterval(push, 3000);
}

/**
 * 采集房主当前的播放状态。
 *
 * `playing` 必须取自播放器真实状态，不能写死 true ——
 * 早先硬编码导致房主暂停后仍广播「正在播放」，
 * 观众侧会继续按「已流逝时间」推算进度，越推越离谱。
 */
function currentPlayState() {
    const position = playerRef.value?.getCurrentTime?.() || 0;
    const playing = playerRef.value?.isPlaying?.() ?? true;
    return { playing, position, updatedAt: Date.now() };
}

/**
 * 广播播放状态。
 *
 * 用逻辑层的 `broadcast` 而不是 `broadcastState`：
 * 后者只定义在渲染层，逻辑层（本页）调不到 ——
 * 早先这里写的是 `rtcRef.value?.broadcastState(state)`，
 * 可选链让调用静默失败，状态根本没发出去。
 */
function broadcastState(state: { playing: boolean; position: number; updatedAt: number }) {
    if (!isHost.value) return;
    rtcRef.value?.broadcast?.({ type: 'state', ...state });
}

/**
 * 房主的即时同步入口。
 *
 * 播放/暂停/快进都调它：立刻把当前状态推给观众，
 * 不等 3 秒轮播周期 —— 否则按了暂停对方还在播，观感很差。
 */
function syncNow() {
    if (!isHost.value) return;
    const state = currentPlayState();
    playStore.updateRemoteState(state);
    broadcastState(state);
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

/**
 * 一集播完：自动续下一集。
 *
 * 走统一的 switchToEpisode —— 它会顺带广播给观众，
 * 早先这里只改本地下标，观众不会跟着切。
 *
 * ⚠️ 只有房主能触发自动续集。观众侧播完若也调用，会自己切集
 * 并把 episode 广播出去，与房主的切集指令互相覆盖 ——
 * 两端各自往前跳一集，越跑越偏。
 * 观众的正确行为是等房主切（房主切完会广播新的 source）。
 */
function onEnded() {
    if (!isHost.value) return;
    const next = currentIndex.value + 1;
    if (next < collections.value.length) switchToEpisode(next);
}

/* ---------------- 播放控制同步 ---------------- */

/**
 * 房主开始播放 → 立刻广播。
 *
 * 早先只靠 3 秒轮播，观众最多要等 3 秒才跟上；
 * 暂停更是完全同步不了（广播里 playing 被写死为 true）。
 *
 * ⚠️ 必须拦观众：观众侧的 play 事件是**响应房主指令**产生的，
 * 若也走 syncNow 发出 state，就会与房主的广播来回反弹
 * （房主播→观众播→观众广播→房主收到但不跟随→…），
 * 在弱网下表现为进度持续抖动、两端互相 seek。
 */
function onHostPlay() {
    if (!isHost.value) return;
    syncNow();
}

/** 房主暂停 → 立刻广播，让观众一起停下。 */
function onHostPause() {
    if (!isHost.value) return;
    syncNow();
}

/**
 * 房主拖动进度条 → 立刻广播新的位置。
 *
 * @param target 松手时跳转到的秒数
 */
function onHostSeek(target: number) {
    if (!isHost.value) return;
    // 用播放器给的目标值，比读 currentTime 更准（后者可能还没更新）
    const state = { playing: playerRef.value?.isPlaying?.() ?? true, position: Number(target) || 0, updatedAt: Date.now() };
    playStore.updateRemoteState(state);
    broadcastState(state);
}

/** 播放出错：先看播放器是否在自愈，再决定换线路还是重新解析。 */
async function onPlayError(err: any) {
    log.error('播放出错', JSON.stringify(err), '当前地址', playStore.playUrl);

    /*
     * 播放器正在原地重试（网络抖动、坏分片）。
     *
     * 此时**不要**抢着换线路：播放器的重载往往几百毫秒就恢复，
     * 父页面一换线路等于把正在恢复的流又打断一次，两边互相拆台。
     */
    if (err && err.retrying) {
        log.info('播放器正在原地重试，暂不切换线路');
        return;
    }

    /*
     * 换线路。
     *
     * 观众侧**不能**自行换：片源地址是由房主同步过来的，
     * 观众私下换一条地址会与房主的进度基准错位。
     * 观众的正确做法是等下一次 source 同步。
     */
    if (!isHost.value) {
        log.warn('观众侧播放失败，等待房主重新同步片源');
        return;
    }

    if (playStore.switchToBackup()) {
        log.info('已切换备用线路', playStore.playUrl);
        return;
    }

    // 线路用尽：重新解析一次（可能拿到新的 CDN 地址）
    await resolve();
    // 重新解析完立刻把新地址推给观众，否则两端会不同步
    pushSource();
}

/* ---------------- 通话 ---------------- */

/**
 * 开启视频通话。
 *
 * **只负责开关媒体** —— 信令早已随组件挂载建立（见 onLoad 与模板注释）。
 * 早先这里等于「整个通话组件的挂载开关」，导致不开通话就收不到
 * 房主的片源同步；现在两者已彻底解耦。
 */
function startCall() {
    callEnabled.value = true;
}

/**
 * 关闭视频通话（释放摄像头/麦克风）。
 *
 * **只关媒体**：信令与 PeerConnection 保持，房间同步继续工作。
 *
 * 因此这里**不能**重置 callStatus / hasRemote —— 那两个反映的是
 * 「信令是否连上」「对方是否在房间里」，关摄像头并不改变它们。
 * 早先一并清掉，会让状态条显示成「连接中…」甚至「等待对方接入」，
 * 明明对方还在房间里、片源同步也照常。
 */
function endCall() {
    rtcRef.value?.stopMedia?.();
    callEnabled.value = false;
    localReady.value = false;
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

/**
 * 数据通道打开。
 *
 * 这是「房间同步真正可用」的准确时机 —— 比 connectionState==='connected'
 * 更早也更可靠：PeerConnection 连上时 dataChannel 可能仍在协商，
 * 此刻发消息会被静默丢弃。通道一 open 就立刻推一次片源，
 * 观众不必等下一个 3 秒轮播周期。
 */
function onChannelOpen() {
    log.info('同步通道已打开');
    syncBroken.value = false;
    if (isHost.value) {
        startBroadcast();
        // 立即推一次，让刚进来的观众马上拿到片源
        pushSource();
    }
}

/** 本地媒体就绪（false 表示摄像头不可用，但不影响房间同步）。 */
function onLocalReady(info: any) {
    localReady.value = !!(info && info.media);

    /*
     * 摄像头没拿到、但麦克风拿到了 → 本次是纯音频通话。
     *
     * 必须显式告知：此时通话能打通、能听到声音，只是双方都看不到画面，
     * 而组件内部不会抛错 —— 用户只会以为是「视频功能坏了」。
     * 早先这种情况完全静默，正是「能打电话但视频不行」的来源之一。
     */
    if (info && info.videoDropped) {
        rtcMediaError.value = '摄像头未启用，当前为纯音频通话';
        log.warn('摄像头未启用，已降级为纯音频');
    } else if (info && info.media) {
        // 恢复正常：清掉可能残留的降级提示
        rtcMediaError.value = '';
    }
}

/**
 * 摄像头/麦克风不可用。
 *
 * 与通话故障分开处理：此时信令与看片同步都正常，只是没有画面，
 * 因此提示要写清「不影响看片」，并给出重试入口。
 */
function onMediaError(e: any) {
    rtcMediaError.value = (e && e.message) || '无法访问摄像头';
    log.warn('媒体不可用', rtcMediaError.value);
}

/**
 * 房主广播失败：房间同步未建立。
 *
 * 判定要**排除「本来就没人进来」这种正常情况**：
 * 房主刚进房间时必然没有对端，此时每次轮播都会失败，
 * 若照样报警就会一直挂着一句「同步未建立」，让人误以为出了故障。
 *
 * 因此只在「已有对端、但消息仍发不出去」时才提示 ——
 * 那才是真正需要排查的状态（协商卡住、dataChannel 没打开）。
 */
function onBroadcastFail(e: any) {
    if (!isHost.value) return;
    // 没人接入属于正常，不提示
    if (peerCount.value === 0 && !hasRemote.value) return;
    if (syncBroken.value) return;
    syncBroken.value = true;
    log.warn('广播失败，房间同步未建立', (e && e.reason) || '');
}

/** 重试获取摄像头/麦克风（用户去系统设置放开权限后回来用）。 */
function retryMedia() {
    rtcMediaError.value = '';
    rtcRef.value?.retryMedia?.();
}

/**
 * 连接人数变化（多人观影）。
 *
 * 房主每次有人接入/离开都会收到，用于刷新人数展示。
 */
function onPeersChange(payload: { count: number; names: string[] }) {
    peerCount.value = Number(payload?.count) || 0;
    peerNames.value = Array.isArray(payload?.names) ? payload.names : [];
    // 有对端连上说明同步通道可用，撤掉「未建立」提示
    if (peerCount.value > 0) syncBroken.value = false;
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

    /*
     * 房主广播由**信令连接成功**驱动，而不是「本地摄像头就绪」。
     *
     * 这是「观众一直显示等待房主选片」的直接修复点：
     * 早先只在 onLocalReady（取流成功）里启动广播，摄像头一旦失败，
     * 广播永远不会开始 —— 而房间同步其实只需要信令与 dataChannel，
     * 跟摄像头毫无关系。
     */
    if (s === 'connected' && isHost.value) {
        startBroadcast();
        // 信令通了就重新评估同步状态（真正的判据是有没有对端）
        if (peerCount.value > 0) syncBroken.value = false;
    }
}

function onRemoteChange(on: boolean) {
    hasRemote.value = on;
    if (on) {
        log.info('对方已接入通话');
        // 有人进来了，同步通道可用，撤掉「未建立」提示
        syncBroken.value = false;
        // 房主在对方接入后立刻推一次片源，观众无需等待下一个广播周期
        if (isHost.value) startBroadcast();
    }
}

/**
 * 收到对端经数据通道发来的消息。
 *
 * 房主会发四类：
 *   source  —— 正在看什么（观众据此加载同一部影片）
 *   state   —— 播放进度（观众据此对齐）
 *   rate    —— 播放倍速（观众跟随，保证进度不错位）
 *   picking —— 房主正在选片（观众据此显示提示，不再干等）
 */
function onChannelMessage(msg: any) {
    if (!msg) return;

    if (msg.type === 'picking') {
        if (isHost.value) return;
        hostPicking.value = !!msg.on;
        return;
    }

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
        /*
         * 换片/切集后播放会从新位置开始，复位播放状态标记 ——
         * 否则紧接着收到的 state 会被去重逻辑挡住，
         * 观众端不会重新 play，画面停在首帧。
         */
        isGuestPlaying = false;
        loadDetail();
        return;
    }

    if (msg.type === 'state') {
        if (isHost.value) return;   // 房主是时间基准，不跟随

        const playing = !!msg.playing;
        playStore.updateRemoteState({
            playing,
            position: Number(msg.position) || 0,
            updatedAt: Number(msg.updatedAt) || Date.now()
        });

        /*
         * 真正驱动播放器 —— 早先只记录状态、不执行动作，
         * 所以房主按了暂停，观众画面照样在跑。
         *
         * 播放与暂停都直接下发指令：
         *   · 暂停必须立刻生效，晚一点对方就多看了几秒
         *   · 播放也让本地跟着走，具体位置由 onTimeUpdate 的对齐逻辑纠偏
         *     （这里不 seek，避免每次广播都跳一下）
         */
        if (playing) {
            if (!isGuestPlaying) {
                isGuestPlaying = true;
                playerRef.value?.play?.();
            }
        } else {
            isGuestPlaying = false;
            playerRef.value?.pause?.();
        }
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
 * 房主去挑影片（换片）。
 *
 * 关键：用 `navigateTo` 打开搜索页，**不用 switchTab 回首页**。
 * switchTab 会销毁房间页（触发 onUnload），通话当场断掉、
 * 观众被留在原地，回来还得重建房间重发邀请码。
 * navigateTo 只是把选片页压栈，房间页留在栈里，通话全程不断。
 *
 * 同时置 pickingVideo 标志，让 onHide 放行（见 onHide 的说明）。
 */
function goPickVideo() {
    pickingVideo.value = true;
    hostPicking.value = true;
    // 先广播给观众，让他们立刻看到「房主在选片」
    broadcastPicking(true);

    uni.navigateTo({
        url: '/pages/search/search?mode=pick',
        fail: () => {
            // 打开失败要复位，否则 onHide 会一直放行、通话不再随切后台释放
            pickingVideo.value = false;
            hostPicking.value = false;
            broadcastPicking(false);
            uni.showToast({ icon: 'none', title: '打开失败，请重试' });
        }
    });
}

/**
 * 广播「房主正在选片」状态。
 *
 * 观众据此在等待页显示明确提示，而不是干等。
 */
function broadcastPicking(on: boolean) {
    if (!isHost.value) return;
    rtcRef.value?.broadcast?.({ type: 'picking', on });
}

/**
 * 应用选片结果（房主从选片页返回时调用）。
 *
 * 换片等价于「换一部影片 + 重置到第 1 集」，因此要清掉旧的
 * 播放状态与剧集列表，再按新 vodId 重新加载详情。
 */
function applyPendingPick() {
    const pick = loadPendingPick();
    if (!pick) return;
    // 一次性消费，避免下次误用
    clearPendingPick();

    log.info('房主换片', pick.vodName);

    vodId.value = pick.vodId;
    vodName.value = pick.vodName;
    currentIndex.value = 0;
    collections.value = [];
    playStore.reset();

    // 记进房间，跨页返回时能恢复
    saveActiveRoom({
        roomId: roomId.value,
        isHost: isHost.value,
        vodId: vodId.value,
        index: 0
    });

    loadDetail();
    // 立刻推一次片源，观众无需等下一个广播周期
    pushSource();
}

/**
 * 立即广播一次当前片源。
 *
 * 正常广播是 3 秒一轮，换片这种「用户主动触发」的动作
 * 应当立刻生效，否则观众要盯着旧画面等 3 秒。
 */
function pushSource() {
    if (!isHost.value) return;
    rtcRef.value?.broadcast?.({
        type: 'source',
        vodId: vodId.value,
        index: currentIndex.value,
        vodName: vodName.value
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
 * 重新读取屏幕尺寸并夹取悬浮窗位置。
 *
 * 尺寸统一走 syncViewport（优先真实视口），不再自己判断是否全屏 ——
 * 播放器全屏是 CSS `position: fixed` 铺满，而 App 端 WebView 的
 * `windowWidth/Height` **不随全屏改变**（它反映页面视口，
 * 不是播放器的铺满区域），所以任何时候都该以真实视口为准。
 *
 * 另外横屏锁定是**异步**的：调用后屏幕要过一小会儿才真正转过来。
 * 这里额外延迟再同步一次，避免拿到「刚锁定、还没转」的旧尺寸 ——
 * 那会让横屏下的可拖范围算成竖屏的数值（拖下去就出屏）。
 */
function initPipPosition() {
    syncViewport();

    if (!pipPlaced.value) {
        placePipDefault();
    } else {
        // 已放过：重新夹一次边界（旋转后可用范围变了）
        const next = clampPip(pipX.value, pipY.value);
        pipX.value = next.x;
        pipY.value = next.y;
    }

    /*
     * 方向锁定是异步的，稍后再校正一次。
     *
     * 两次都用同一套逻辑，因此即使第一次拿到的还是旧尺寸，
     * 第二次也能把浮窗拉回正确范围；若第二次读到的尺寸没变，
     * syncViewport 内部的比对会让它成为空操作，不产生额外开销。
     */
    setTimeout(() => {
        syncViewport();
        const next = clampPip(pipX.value, pipY.value);
        pipX.value = next.x;
        pipY.value = next.y;
    }, 350);
}

/**
 * 返回键的优先顺序：先收全屏内的选集面板，再退全屏，最后才离开页面。
 *
 * 与播放页保持一致。若不这样处理，全屏下按返回会直接退出页面，
 * 而用户的本意通常只是「退出全屏」。
 *
 * 面板状态住在渲染层，逻辑层取不到，故用「请它收起」的方式询问：
 * 播放器返回是否真的收起了，据此决定要不要吃掉这次返回。
 */
onBackPress(() => {
    if (playerRef.value?.closeEpisodePanel?.()) {
        return true;
    }
    if (playerFullscreen.value) {
        playerRef.value?.exitFullscreen?.();
        return true;
    }
    return false;
});

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
 * 页面隐藏时释放摄像头。
 *
 * **只停媒体，不停信令。**
 *
 * 早先这里调 destroy 把整个通话组件清掉 —— 那会连同信令一起断开，
 * 于是「房主切后台看一眼消息」就导致房间同步中断、观众掉线。
 * 现在信令常驻（房间同步依赖它），切后台只释放摄像头/麦克风，
 * 避免长期占用与耗电。
 *
 * **例外：房主去选片页时要放行。**
 * onHide 对「切后台」与「页内跳转」一视同仁，而跳去选片页
 * 只是把新页面压栈、房间页仍在栈里活着。若无条件停媒体，
 * 房主一进选片页通话画面就断，观众被晾在原地。
 */
onHide(() => {
    if (pickingVideo.value) return;

    if (callEnabled.value) {
        // 只释放设备；信令与房间同步不受影响（故不动 callStatus / hasRemote）
        rtcRef.value?.stopMedia?.();
        callEnabled.value = false;
        localReady.value = false;
    }
});

/**
 * 页面重新显示。
 *
 * 房主从选片页返回时会走这里，检查是否有待应用的选片结果。
 * 用 onShow 而不是 onLoad —— onLoad 只在首次进入页面时触发一次，
 * 从选片页返回不会重新执行。
 */
onShow(() => {
    if (!pickingVideo.value) return;

    pickingVideo.value = false;
    hostPicking.value = false;
    broadcastPicking(false);

    // 房主选中了影片才需要换片；直接返回则什么都不做
    if (isHost.value) applyPendingPick();
});

onUnload(() => {
    stopBroadcast();
    rtcRef.value?.destroy?.();
    playStore.leaveRoom();
    playStore.reset();

    /*
     * 离开房间页即清除记录。
     *
     * 这条记录只服务于「房主去选片页再返回」这类**同一次会话内的跨页往返**
     * —— 那种情况不会触发 onUnload（页面仍在栈里）。
     * 一旦 onUnload 触发，说明用户真的离开了房间，记录就该失效，
     * 否则下次点「开一个」会复用已经散掉的房间号。
     *
     * 早先 clearActiveRoom 定义了却从未被调用，记录只能靠 TTL 过期，
     * 因此重启 App 后点「开一个」会残留上一次的房间与影片。
     */
    clearActiveRoom();
});
</script>

<style lang="scss" scoped>
.room {
    /*
     * 整页锁定视口高度：页面本身不滚动，滚动交给下方 scroll-view。
     *
     * 与播放页保持一致 —— 早先是 min-height + 自然滚动，
     * 向上滑时视频区会被滚出屏幕，用户看不到画面。
     */
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: #0b0d10;

    /* 导航栏固定不滚动：flex:none 保证不被下方内容挤压缩高 */
    &__nav {
        flex: none;
    }

    /* 播放器区固定不滚动 */
    &__stage {
        position: relative;
        flex: none;
        width: 100%;
        height: 420rpx;
        background-color: #000;
    }

    /* 滚动区：占满剩余高度 */
    &__body {
        flex: 1;
        /* min-height:0 必须加 —— flex 子项默认 min-height:auto，
           不加则内容撑开后整页会被顶出视口、滚动失效 */
        min-height: 0;
    }

    &__tail {
        height: calc(40rpx + env(safe-area-inset-bottom));
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
        border-radius: 12px;
        overflow: hidden;
        background-color: #0b0d10;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.16);
        /* 拖动跟手：禁掉浏览器默认手势与长按选中 */
        touch-action: none;
        user-select: none;
    }

    /*
     * 收起态：竖向小条。
     * 参照腾讯会议 —— 收起后仍保留静音与挂断，
     * 否则用户看不到画面时连自己是否静音都无从判断。
     *
     * 视频与按钮组用 display:none 藏起来 —— 注意**不能**用 v-if 卸载，
     * yh-rtc 是 renderjs 组件，卸载等于挂断通话。
     */
    &__pip--mini {
        border-radius: 8px;
        background-color: rgba(20, 23, 28, 0.94);
    }

    &__pip--mini .room__rtc,
    &__pip--mini .room__pip-acts {
        display: none;
    }

    /*
     * 未开启通话：整个浮窗隐藏（但组件**保持挂载**）。
     *
     * 用 display:none 而不是 v-if —— yh-rtc 是 renderjs 组件，
     * 卸载就等于销毁信令连接，房间同步（片源/进度/选集）会一起断掉。
     * display:none 下 DOM 与连接都还在，只是不显示，
     * 因此「不开摄像头也照样能同步看片」。
     */
    &__pip--hidden {
        display: none;
    }

    &__rtc {
        flex: 1;
        min-height: 0;
        width: 100%;
        background-color: #000;
    }

    /* ---------- 展开态：内嵌操作条 ---------- */

    /*
     * 压在视频下缘。
     *
     * 内嵌而非独立底部横条：全屏时横条会压住播放器进度条，
     * 也遮挡画面下缘；内嵌在通话窗里则完全不干扰影片。
     *
     * ⚠️ 高度**不随 --pip-scale 缩放**。
     *
     * 早先按档位等比放大，但浮窗高度有上限（短边 55%），
     * 到了最大档高度已顶到上限、无法再增，操作条却还在变大 ——
     * 结果画面区被反向压缩，双击「放大」反而更小：
     *   实测面积 12288 → 20800 → 17910（最大档比中档还小）
     * 而且放大浮窗并不会让这几个图标按钮更好点，
     * 固定尺寸既省空间，也保证画面区随档位单调递增。
     */
    &__pip-acts {
        flex: none;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 20px;
        background-color: #14171c;
    }

    /* 单个圆形按钮（同样固定尺寸，理由见上） */
    &__pact {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: rgba(255, 255, 255, 0.12);
    }

    /* 关闭态：转成警示红，一眼可辨 */
    &__pact--off {
        background-color: rgba(217, 139, 133, 0.28);
    }

    /*
     * ---------- 图标：内联 SVG（data URI + mask） ----------
     *
     * 为什么不用 CSS 手绘几何图形：小尺寸下由边框拼出的形状
     * 边缘会发虚、比例也难调（麦克风的圆头、挂断的话筒都很难看）。
     *
     * 也不用 emoji 与图标字体：前者在不同 Android WebView 上
     * 渲染差异大（彩色/单色/豆腐块），后者要额外加载字体文件。
     *
     * 做法：SVG 作为 mask，真实颜色由 background-color 决定，
     * 于是「正常白色 / 关闭红色」只需切换 CSS，无需两套图形。
     */
    &__ico {
        width: 14px;
        height: 14px;
        background-color: rgba(255, 255, 255, 0.94);
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-position: center;
        mask-position: center;
        -webkit-mask-size: contain;
        mask-size: contain;
    }

    /* 麦克风：话筒 + 底座支架 */
    &__ico--mic {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Crect x='9' y='2' width='6' height='11' rx='3'/%3E%3Cpath d='M5 11a7 7 0 0 0 14 0'/%3E%3Cpath d='M12 18v4'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Crect x='9' y='2' width='6' height='11' rx='3'/%3E%3Cpath d='M5 11a7 7 0 0 0 14 0'/%3E%3Cpath d='M12 18v4'/%3E%3C/svg%3E");
    }

    /* 麦克风（静音）：同一图形叠加一道斜杠 */
    &__ico--mic-off {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M15 9.5V5a3 3 0 0 0-5.9-.7'/%3E%3Cpath d='M9 9v2a3 3 0 0 0 4.2 2.7'/%3E%3Cpath d='M5 11a7 7 0 0 0 10.5 6.1'/%3E%3Cpath d='M12 18v4'/%3E%3Cpath d='M3 3l18 18'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M15 9.5V5a3 3 0 0 0-5.9-.7'/%3E%3Cpath d='M9 9v2a3 3 0 0 0 4.2 2.7'/%3E%3Cpath d='M5 11a7 7 0 0 0 10.5 6.1'/%3E%3Cpath d='M12 18v4'/%3E%3Cpath d='M3 3l18 18'/%3E%3C/svg%3E");
    }

    /* 摄像头：机身 + 右侧镜头 */
    &__ico--cam {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='6' width='13' height='12' rx='2'/%3E%3Cpath d='M15 10.5l6-3.5v10l-6-3.5'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='6' width='13' height='12' rx='2'/%3E%3Cpath d='M15 10.5l6-3.5v10l-6-3.5'/%3E%3C/svg%3E");
    }

    /* 摄像头（关闭）：同一图形叠加斜杠 */
    &__ico--cam-off {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10.7 6H13a2 2 0 0 1 2 2v.5l6-3.5v10l-2.6-1.5'/%3E%3Cpath d='M15 15v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1'/%3E%3Cpath d='M3 3l18 18'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10.7 6H13a2 2 0 0 1 2 2v.5l6-3.5v10l-2.6-1.5'/%3E%3Cpath d='M15 15v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1'/%3E%3Cpath d='M3 3l18 18'/%3E%3C/svg%3E");
    }

    /* 挂断：话筒横置 */
    &__ico--hangup {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000'%3E%3Cpath d='M12 9c-3.6 0-6.9 1.1-9.6 3.1-.4.3-.5.8-.3 1.2l1.5 2.6c.2.4.7.5 1.1.3l3-1.4c.3-.2.5-.5.5-.9v-1.6c1.2-.3 2.5-.5 3.8-.5s2.6.2 3.8.5v1.6c0 .4.2.7.5.9l3 1.4c.4.2.9.1 1.1-.3l1.5-2.6c.2-.4.1-.9-.3-1.2C18.9 10.1 15.6 9 12 9z'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000'%3E%3Cpath d='M12 9c-3.6 0-6.9 1.1-9.6 3.1-.4.3-.5.8-.3 1.2l1.5 2.6c.2.4.7.5 1.1.3l3-1.4c.3-.2.5-.5.5-.9v-1.6c1.2-.3 2.5-.5 3.8-.5s2.6.2 3.8.5v1.6c0 .4.2.7.5.9l3 1.4c.4.2.9.1 1.1-.3l1.5-2.6c.2-.4.1-.9-.3-1.2C18.9 10.1 15.6 9 12 9z'/%3E%3C/svg%3E");
    }

    /* 收起：向下双箭头（窗口缩小） */
    &__ico--shrink {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 4l6 6 6-6'/%3E%3Cpath d='M6 13l6 6 6-6'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 4l6 6 6-6'/%3E%3Cpath d='M6 13l6 6 6-6'/%3E%3C/svg%3E");
    }

    /* 展开：向上双箭头（窗口放大） */
    &__ico--expand {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 11l6-6 6 6'/%3E%3Cpath d='M6 20l6-6 6 6'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 11l6-6 6 6'/%3E%3Cpath d='M6 20l6-6 6 6'/%3E%3C/svg%3E");
    }

    /* ---------- 收起态：横向胶囊 ---------- */

    &__mini {
        display: none;
    }

    /*
     * 三个按钮横向排列：麦克风 / 挂断 / 展开。
     * 整条胶囊**不响应点击**，只有按钮能改变形态 ——
     * 早先是细竖条且点任意处就展开，拖动时极易误触。
     */
    &__pip--mini .room__mini {
        display: flex;
        flex: 1;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 0 6px;
    }

    &__mini-act {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: rgba(255, 255, 255, 0.12);
    }

    &__mini-act--off {
        background-color: rgba(217, 139, 133, 0.28);
    }

    /* 挂断：红底，与其他键明确区分 */
    &__mini-act--hangup {
        background-color: #b4534b;
    }

    /* 胶囊里的图标小一号，26px 的按钮放 14px 图标会顶边 */
    &__mini-act &__ico {
        width: 13px;
        height: 13px;
    }

    /* ---------- 通话控制条 ---------- */

    /*
     * 通话控制条（仅非全屏时渲染）。
     *
     * 全屏时按钮已内嵌在通话悬浮窗内，不再需要这条横条 —— 它既与悬浮窗
     * 内的按钮重复，又会压住播放器的进度条。
     */
    &__call-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        padding: 20rpx 24rpx 4rpx;
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

    /* 「换片 / 选片」入口：房主专属 */
    &__now-switch {
        flex-shrink: 0;
        margin-left: 16rpx;
        padding: 10rpx 26rpx;
        border-radius: 999rpx;
        background-color: rgba(240, 166, 60, 0.16);
    }

    &__now-switch-text {
        font-size: 24rpx;
        color: #f0a63c;
    }

    /* 选片中提示：带一个呼吸的小圆点，表明「正在进行」 */
    &__picking {
        display: flex;
        align-items: center;
        margin-bottom: 20rpx;
        padding: 16rpx 22rpx;
        border-radius: 12rpx;
        background-color: rgba(240, 166, 60, 0.12);
    }

    &__picking-dot {
        flex-shrink: 0;
        width: 12rpx;
        height: 12rpx;
        margin-right: 14rpx;
        border-radius: 50%;
        background-color: #f0a63c;
        animation: room-picking-blink 1.1s ease-in-out infinite;
    }

    &__picking-text {
        flex: 1;
        min-width: 0;
        font-size: 24rpx;
        color: #f0a63c;
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

    /*
     * 提示条。
     *
     * 普通态是橙色短句（如「已对齐到 120 秒」），走小字不加底；
     * 警示态加淡红底与内边距 —— 它承载的是「同步未建立」「摄像头不可用」
     * 这类需要用户动手处理的信息，与一闪而过的同步提示区分开。
     */
    &__hint {
        margin-top: 20rpx;
    }

    &__hint-text {
        font-size: 24rpx;
        color: #f0a63c;
    }

    &__hint--warn {
        display: flex;
        align-items: center;
        padding: 16rpx 20rpx;
        border-radius: 12rpx;
        background-color: rgba(217, 139, 133, 0.12);
    }

    &__hint--warn &__hint-text {
        flex: 1;
        min-width: 0;
        font-size: 23rpx;
        line-height: 1.5;
        color: #d98b85;
    }

    /* 提示条内的行动按钮：紧凑、不抢主按钮的视觉重量 */
    &__hint-btn {
        flex-shrink: 0;
        margin-left: 16rpx;
        padding: 8rpx 22rpx;
        border-radius: 999rpx;
        background-color: rgba(240, 166, 60, 0.16);
    }

    &__hint-btn-text {
        font-size: 22rpx;
        color: #f0a63c;
        white-space: nowrap;
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

    /* ---------- 选集 ---------- */

    /*
     * 与其它卡片同外观。
     * 宫格用限高滚动而非直接铺开：动辄上百集的剧会把页面撑得极长，
     * 下面的说明与操作都被推到很远。
     */
    &__episodes {
        margin: 24rpx;
        padding: 28rpx 28rpx 24rpx;
        border-radius: 16rpx;
        background-color: #14171c;
        border: 1rpx solid rgba(255, 255, 255, 0.05);
    }

    &__episodes-head {
        display: flex;
        align-items: baseline;
        margin-bottom: 20rpx;
    }

    &__episodes-title {
        font-size: 30rpx;
        font-weight: 600;
        color: #e8eaed;
    }

    &__episodes-count {
        flex: 1;
        margin-left: 14rpx;
        font-size: 22rpx;
        color: #6b7280;
    }

    &__episodes-scroll {
        /* 约 6 行的高度：够用又不至于占满整屏 */
        height: 520rpx;
    }
}

/*
 * 选片指示灯的呼吸动画。
 * 放在 .room 之外：keyframes 不需要选择器作用域，
 * 写在嵌套里会随 scoped 属性一起被重写，反而容易失效。
 */
@keyframes room-picking-blink {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.25;
    }
}
</style>
