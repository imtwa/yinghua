<template>
    <!--
        注意：renderjs 的同步属性用自定义名（vsrc / vprops / vcmd），
        避免与 view 内置属性（如 src）冲突导致绑定失效。
    -->
    <view
        :id="wrapperId"
        class="vp-mount"
        :vseed="seed"
        :change:vseed="domPlayer.onSeedChange"
        :vsrc="src"
        :change:vsrc="domPlayer.onSrcChange"
        :vprops="viewport"
        :change:vprops="domPlayer.onViewportChange"
        :voffline="offline"
        :change:voffline="domPlayer.onOfflineChange"
        :vhint="hint"
        :change:vhint="domPlayer.onHintChange"
        :vcmd="command"
        :change:vcmd="domPlayer.onCommandChange" />
</template>

<script>
/**
 * 播放器 —— 逻辑层（Options API）。
 *
 * 为什么用 Options API：renderjs 只能通过
 * `$ownerInstance.callMethod(name)` 回调逻辑层的 methods，
 * 无法访问 `<script setup>` 的作用域。
 *
 * 本层只做桥接：把渲染层事件转成标准 Vue 事件，并提供控制方法。
 * 真正的播放逻辑全部在 renderjs 渲染层（可直接操作 DOM）。
 */
export default {
    name: 'VideoPlayer',
    props: {
        src: { type: String, default: '' },
        poster: { type: String, default: '' },
        autoplay: { type: Boolean, default: true },
        initialTime: { type: Number, default: 0 },
        objectFit: { type: String, default: 'contain' },
        muted: { type: Boolean, default: false },
        playbackRate: { type: Number, default: 1 },
        /**
         * 离线缓存信息。
         *
         * 传入时表示该集已缓存，播放器会**优先读本地文件**，
         * 无网络也能播放。结构见 `services/download.ts`：
         *   { key, dir, base, manifest, fallbackSrc }
         *   - dir         本地目录路径（以 / 结尾）
         *   - manifest    已保存的 m3u8 正文（地址已改写为绝对）
         *   - fallbackSrc 在线地址，用于个别分片缺失时回落
         * 缺省为 null，走正常在线播放。
         */
        offline: { type: Object, default: null },
        /**
         * 剧集列表，用于全屏内的选集面板。
         *
         * 面板由渲染层自绘（与倍速面板同一机制）：
         * 若做成页面级浮层，全屏播放器是 fixed + z-index 9999，
         * 在 App WebView 里会被裁切/压住 —— 表现为「点了选集没反应」。
         * 内建在播放器容器里则与画面同生共死，层级天然正确。
         *
         * 结构：`[{ id, name }]`，缺省为空数组（面板显示「暂无可选集」）。
         */
        collections: { type: Array, default: () => [] },
        /** 当前集下标，用于面板高亮。 */
        currentIndex: { type: Number, default: 0 },
        /**
         * 全屏顶部栏显示的标题（如「XXX 第 3 集」）。
         *
         * 为空时整条顶部栏仍会渲染（返回键必须有），只是不显示文字。
         * 标题过长会自动横向滚动（见 .vp-title 的动画）。
         */
        title: { type: String, default: '' }
    },
    data() {
        return {
            /** 多实例隔离 */
            seed: Math.floor(Math.random() * 100000000),
            /** 渲染层指令：'play' | 'pause' | 'seek:<秒>' | 'rate:<倍速>' | 'fullscreen' | 'exitfullscreen' | 'destroy' */
            command: '',
            /**
             * 切换遮罩状态。
             *
             * 带 seq 是为了让「同样的文案连续触发」也能同步到渲染层 ——
             * renderjs 只在值变化时推送属性，纯字符串会漏掉重复调用。
             */
            hint: { text: '', seq: 0 },
            hintSeq: 0,
            /** 逻辑层缓存的播放位置，供父组件读取 */
            currentTime: 0,
            duration: 0,
            playing: false,
            /** 当前是否处于全屏（横屏）状态 */
            fullscreenOn: false,
            /**
             * 选集面板是否展开（渲染层上报的镜像）。
             *
             * 逻辑层无法同步读取渲染层状态，故由渲染层主动上报，
             * 供 onBackPress 之类的同步判断使用。
             */
            episodePanelOn: false
        };
    },
    computed: {
        wrapperId() {
            return `vp-${this.seed}`;
        },
        /** 聚合需同步到渲染层的属性 */
        viewport() {
            return {
                autoplay: this.autoplay,
                objectFit: this.objectFit,
                muted: this.muted,
                playbackRate: this.playbackRate,
                poster: this.poster,
                initialTime: this.initialTime,
                /*
                 * 选集面板的数据源。
                 *
                 * 这里只传面板需要的两个字段：剧集名可能很长、
                 * 数量可达数百集，整对象同步会把属性桥压垮。
                 *
                 * 名称取 `title` 而不是 `name` —— Collection 里根本没有
                 * `name` 字段（见 api/types.ts），写 `c.name` 得到的是
                 * undefined，面板会把每一集都显示成裸序号「1 2 3…」。
                 */
                episodes: this.collections.map(c => ({ id: c.id, name: c.title })),
                currentIndex: this.currentIndex,
                /* 顶部栏标题：随集数变化，同步到渲染层 */
                title: this.title
            };
        }
    },
    watch: {
        command(val) {
            // 消费后复位，保证同名指令可重复触发
            if (val) {
                this.$nextTick(() => {
                    this.command = '';
                });
            }
        }
    },
    methods: {
        /** 渲染层唯一回调入口。 */
        onRenderEvent(payload) {
            const { event, data } = payload || {};
            if (event === 'timeupdate') {
                this.currentTime = (data && data.currentTime) || 0;
                this.duration = (data && data.duration) || 0;
            } else if (event === 'play') {
                this.playing = true;
            } else if (event === 'pause') {
                this.playing = false;
            } else if (event === 'landscapechange') {
                // 播放器内部按钮切换全屏时，同步自身状态并通知父组件
                this.fullscreenOn = !!data;
            } else if (event === 'episodepanel') {
                this.episodePanelOn = !!data;
            }
            this.$emit(event, data);
        },

        /* ---------- 供父组件调用 ---------- */

        play() {
            this.command = 'play';
        },
        pause() {
            this.command = 'pause';
        },
        seek(position) {
            this.command = `seek:${position}`;
        },
        /** 进入全屏（App 端同时锁定方向并隐藏系统状态栏）。 */
        requestFullscreen() {
            this.command = 'fullscreen';
        },
        /**
         * 进入竖屏全屏。
         *
         * 躺在床上竖持手机时用 —— 不再强制转横屏。
         */
        requestPortraitFullscreen() {
            this.command = 'fullscreen:portrait';
        },
        /** 在全屏内切换横竖屏。 */
        toggleOrientation() {
            this.command = 'orientation';
        },
        /**
         * 显示切换遮罩（黑场 + 提示文案）。
         *
         * 换集时调一次，让用户明确感知到「切了」；新源可播放后再调
         * `clearHint()` 揭开。seq 自增保证重复调用也能推到渲染层。
         */
        showHint(text) {
            this.hintSeq += 1;
            this.hint = { text: text || '', seq: this.hintSeq };
        },
        /** 揭开切换遮罩。 */
        clearHint() {
            this.hintSeq += 1;
            this.hint = { text: '', seq: this.hintSeq };
        },
        /**
         * 收起控制条。
         *
         * 供父组件在弹出选集抽屉等浮层前调用 ——
         * 浮层出现时控制条还悬在画面上会显得杂乱。
         */
        hideControls() {
            this.command = 'hidecontrols';
        },
        /**
         * 收起选集面板。
         *
         * **返回面板此前是否开着** —— 供 `onBackPress` 之类的同步逻辑
         * 决定要不要吃掉这次返回。返回值取自渲染层上报的镜像状态，
         * 而非渲染层的实时值：逻辑层无法同步调用渲染层方法取返回值，
         * 只有「逻辑层 → 渲染层」的单向指令通道。
         */
        closeEpisodePanel() {
            const wasOpen = this.episodePanelOn;
            if (wasOpen) {
                this.episodePanelOn = false;
                this.command = 'closeepisodes';
            }
            return wasOpen;
        },
        /** 退出全屏并还原系统方向 / 状态栏 / 屏幕亮度。 */
        exitFullscreen() {
            this.command = 'exitfullscreen';
        },
        /**
         * 销毁播放器：退出全屏、还原屏幕亮度、释放播放源。
         *
         * 页面卸载时必须调用 —— 亮度与屏幕方向是「全局副作用」，
         * 不还原会残留到其它页面甚至其它 App。
         */
        destroy() {
            this.command = 'destroy';
        },
        /** 设置倍速。 */
        setRate(rate) {
            this.command = `rate:${rate}`;
        },
        /** 当前播放位置（秒） */
        getCurrentTime() {
            return this.currentTime;
        },
        /** 总时长（秒） */
        getDuration() {
            return this.duration;
        },
        isPlaying() {
            return this.playing;
        },
        isFullscreen() {
            return this.fullscreenOn;
        }
    }
};
</script>

<script module="domPlayer" lang="renderjs">
/**
 * 播放器 —— 渲染层（renderjs）。
 *
 * App（vue 页面）与 H5 都走这里：两端均为 WebView 渲染，
 * 可直接创建并操作原生 <video> 元素，因此：
 *   1. m3u8 用 hls.js 播放，两端行为一致
 *   2. 控件完全自绘，样式与层级不受限制
 *   3. 可直接读写 currentTime，seek 精确
 *
 * 注意：renderjs 内**不能使用 import**，故 hls.js 通过
 * script 标签从 static/js 动态加载。
 *
 * 视觉基调：极简。半透明浮层 + CSS 绘制图标，
 * 不使用 emoji、字体图标或图片资源。
 *
 * 交互约定：
 *   - 点击画面：控件可见时**立即隐藏**，不可见时唤出后延时自隐
 *   - 左半屏竖直滑动：调亮度；右半屏竖直滑动：调音量
 *   - 全屏：App 端走 plus 真全屏（隐藏状态栏 + 锁定方向）；
 *           H5 端走 CSS 铺满 + 方向锁定（不用原生全屏，否则父页面浮层被裁掉）
 *   - 全屏内可切横竖屏；退出全屏时先锁回竖屏再解锁
 *   - 全屏内控制条有选集入口，点它 emit('episodes') 由父页面弹出抽屉
 *   - 换集：遮罩压黑并提示目标集数，新源出画后自动揭开
 */

/** 注入的样式 id，保证全局只注入一次 */
const STYLE_ID = 'vp-render-style';

/**
 * hls.js 静态资源路径。
 *
 * App 端 renderjs 的资源路径相对**根目录**计算（官方文档：`./static/test.js`），
 * H5 端则用绝对路径 `/static/...`，故需按环境区分。
 */
const HLS_URL = (function () {
    const isApp = typeof window !== 'undefined' && (!!window.plus || /Html5Plus/i.test(navigator.userAgent || ''));
    return isApp ? './static/js/hls.min.js' : '/static/js/hls.min.js';
})();

/**
 * 倍速档位。
 *
 * 覆盖慢放到快进：0.5 / 0.75 / 1 / 1.25 / 1.5 / 1.75 / 2 / 2.5 / 3。
 * 含 1x 是为了让用户能从面板直接回到正常速度。
 */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 倍速档位的展示文案。 */
function rateLabel(r) {
    return `${r}×`;
}

/** 控件自动隐藏延时（毫秒） */
const HIDE_DELAY = 3200;

/** 手势激活的最小竖直位移（px），避免误触发 */
const GESTURE_THRESHOLD = 8;

/** 一次全程滑动对应的高度比例，越小越灵敏 */
const GESTURE_SPAN_RATIO = 0.62;

/**
 * 全屏下右滑退出全屏的最小横向位移（px）。
 *
 * 取 90：太短会在调节亮度/音量时被误判（手指横向抖动），
 * 太长则要划很大一段才生效，手感迟钝。
 */
const SWIPE_OUT_THRESHOLD = 90;

/**
 * 双击判定的最大间隔（毫秒）。
 *
 * 取 300：短于各家播放器常用的 250~350ms 区间。
 * 太长会把「点一下隐藏控件、再点一下唤出」误判成双击快进，
 * 用户会发现自己明明只想收控制条，进度却跳了 10 秒。
 */
const DOUBLE_TAP_MS = 300;

/** 双击快进/快退的步长（秒）。 */
const DOUBLE_TAP_SEEK = 10;

/** 双击提示的停留时间（毫秒）。 */
const SEEK_HUD_MS = 620;

/**
 * 长按加速倍速。
 *
 * 取 3 倍：与 RATES 的最高档一致，长按即「拉到最快」，
 * 松手回到原速，是看片时跳过片头的通行做法。
 */
const HOLD_RATE = 3;

/** 触发长按加速所需的最短按压时间（毫秒）。 */
const HOLD_DELAY = 520;

/** 前向缓冲低于该秒数时视为「随时可能卡」，信息行点亮提醒。 */
const BUFFER_LOW_SEC = 6;

/**
 * 前向缓冲低于该秒数即进入「缓冲中」状态并显示转圈。
 *
 * 取 1.5 而不是 0：等到真正 stalled 才提示就晚了 ——
 * 那时画面已经定住，用户已经感知到卡顿。
 */
const BUFFER_STALL_SEC = 1.5;

/**
 * hls.js 缓冲目标。
 *
 * 默认 maxBufferLength 是 30 秒，短片段还好，但采集源的 m3u8
 * 多为 10 秒一片 —— 30 秒只有 3 片，网络一抖就断粮。
 * 拉到 60 秒（约 6 片）能明显减少卡顿，代价是内存与首次起播稍慢；
 * maxBufferSize 相应放宽到 90MB，避免长片把内存吃满。
 */
const HLS_MAX_BUFFER_LEN = 60;
const HLS_MAX_BUFFER_SIZE = 90 * 1024 * 1024;

/** 卡顿超过该时长仍未恢复，判定为「网络很差」并在浮层给出提示。 */
const STALL_HINT_MS = 4000;

/**
 * 网速的滑动窗口（秒）。
 *
 * 分片是成块到达的（几百 KB 一次性完成），窗口太短会看到数字脉冲式跳动；
 * 太长则切换码率后跟不上变化。4 秒在两者间比较平衡。
 */
const SPEED_WINDOW = 4;

/**
 * 原生播放路径的码率估算值（字节/秒）。
 *
 * 仅用于 iOS 原生 HLS / mp4 直连 —— 那条路径拿不到真实字节数，
 * 只能由「缓冲秒数增量 × 码率」估算。取 1.5 Mbps
 * （≈187 KB/s，常见 720p 采集源码率）作为量级参考。
 */
const NATIVE_BITRATE_BPS_EST = 187 * 1024;

/**
 * 字节/秒 → 可读网速（如 "1.2 MB/s"）。
 *
 * 统一用 1024 进制，与加载浮层的体积量级一致，
 * 避免 KB/MB 混用导致用户误判。
 *
 * **为 0 时返回 "0 KB/s" 而不是空串**：这一格的位置是固定的，
 * 留空会让整行像缺了一块，用户也会怀疑是不是显示坏了。
 * 另外小于 1KB 一律归到 KB 档 —— 出现 "137 B/s" 这种量级
 * 只会让人分心，实际已接近停滞。
 */
function formatSpeed(bytesPerSec) {
    const v = Number(bytesPerSec) || 0;
    if (v < 1024) return '0 KB/s';
    if (v < 1048576) return `${(v / 1024).toFixed(0)} KB/s`;
    if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB/s`;
    return `${(v / 1073741824).toFixed(2)} GB/s`;
}

/**
 * URL → 本地文件名哈希（djb2）。
 *
 * 必须与 `services/download.ts` 的 hashUrl 保持一致 ——
 * 下载时用这个规则命名文件，离线播放时用同一规则定位。
 */
function hashUrl(url) {
    let h = 5381;
    for (let i = 0; i < url.length; i++) {
        h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** dataURL(base64) → ArrayBuffer。 */
function dataUrlToBuffer(dataUrl) {
    try {
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        const bin = atob(dataUrl.slice(comma + 1));
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    } catch {
        return null;
    }
}

/**
 * 字符串 → UTF-8 字节。
 *
 * 不用 TextEncoder：部分 Android 系统 WebView 版本较老不支持，
 * 手写编码在 m3u8 这种纯 ASCII 场景下完全够用。
 */
function encodeText(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c < 0x80) {
            bytes.push(c);
        } else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdbff) {
            // 代理对
            const c2 = text.charCodeAt(++i);
            c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            bytes.push(
                0xf0 | (c >> 18),
                0x80 | ((c >> 12) & 0x3f),
                0x80 | ((c >> 6) & 0x3f),
                0x80 | (c & 0x3f)
            );
        } else {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(bytes);
}

const CSS_TEXT = `
/* touch-action 不是可继承属性，必须同时写在容器与 video 上，
   否则手指落在 video 上时仍会被 webview 当滚动手势处理 */
.vp-box { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden;
    touch-action: none; -webkit-user-select: none; user-select: none; }
.vp-box video { width: 100%; height: 100%; display: block; background: #000;
    touch-action: none; }

/* 全屏：脱离文档流铺满视口，与系统横屏锁定配合 */
.vp-box.is-fs { position: fixed !important; left: 0 !important; top: 0 !important;
    right: 0 !important; bottom: 0 !important; width: auto !important; height: auto !important;
    z-index: 9999 !important; }

.vp-layer { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 2;
    opacity: 1; transition: opacity .22s ease; }
.vp-layer.is-hidden { opacity: 0; pointer-events: none; }

.vp-scrim-top { position: absolute; left: 0; top: 0; right: 0; height: 92px;
    background: linear-gradient(180deg, rgba(0,0,0,.5), rgba(0,0,0,0)); pointer-events: none; }
.vp-scrim-bottom { position: absolute; left: 0; right: 0; bottom: 0; height: 128px;
    background: linear-gradient(0deg, rgba(0,0,0,.7), rgba(0,0,0,0)); pointer-events: none; }

.vp-center { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
    width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; background: rgba(0,0,0,.32);
    border: 1px solid rgba(255,255,255,.22); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.vp-center:active { background: rgba(0,0,0,.48); }
.vp-i-play { width: 0; height: 0; margin-left: 5px;
    border-left: 18px solid rgba(255,255,255,.94);
    border-top: 11px solid transparent; border-bottom: 11px solid transparent; }
.vp-i-pause { width: 16px; height: 20px; position: relative; }
.vp-i-pause:before, .vp-i-pause:after { content: ""; position: absolute; top: 0;
    width: 5px; height: 20px; background: rgba(255,255,255,.94); border-radius: 1px; }
.vp-i-pause:before { left: 0; }
.vp-i-pause:after { right: 0; }

.vp-bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 14px 11px; }

/* ---------------- 顶部栏（仅全屏） ---------------- */

/*
 * 与 vp-bottom 同处 vp-layer，因此显隐完全同步 ——
 * 点画面一起出现、自动延时一起收起，行为与进度条一致。
 *
 * 默认 display:none：非全屏时顶部不需要返回键与剧名，
 * 画面本来就小，再加一条会挤压可视面积。
 */
.vp-top { position: absolute; left: 0; right: 0; top: 0; display: none;
    align-items: center; padding: 0 14px; height: 52px; }
.vp-box.is-fs .vp-top { display: flex; }
.vp-box.is-fs.is-portrait-fs .vp-top { height: 44px; }

/* 返回键：圆形底 + CSS 箭头，触控区放大到 40×40 */
.vp-back { flex-shrink: 0; width: 40px; height: 40px; margin-right: 10px;
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.32); }
.vp-back:active { background: rgba(255,255,255,.2); }
.vp-i-back { width: 11px; height: 11px; margin-left: 4px;
    border-left: 2px solid rgba(255,255,255,.94);
    border-bottom: 2px solid rgba(255,255,255,.94);
    border-radius: 1px; transform: rotate(45deg); }

/*
 * 标题容器：定宽 + 裁剪。
 * min-width:0 必须加 —— flex 子项默认 min-width:auto，
 * 长标题会把容器撑开、把返回键挤出屏幕。
 */
.vp-title-wrap { flex: 1; min-width: 0; overflow: hidden; position: relative; }

/*
 * 标题本体。
 *
 * 用 width: max-content 而不是 inline-block：让元素宽度等于
 * 文字的自然宽度（不被容器压缩），这样 JS 读 scrollWidth 才能
 * 拿到真实文字宽度、据此判断是否需要滚动。
 * 若用 inline-block + 容器约束，scrollWidth 会等于容器宽度，
 * 判定「是否溢出」就永远不成立 —— 短文字也会被误判成要滚。
 *
 * 默认静止：短标题固定显示在左侧，不做任何动画。
 */
.vp-title { display: block; width: max-content; white-space: nowrap;
    font-size: 14px; color: rgba(255,255,255,.94);
    text-shadow: 0 1px 3px rgba(0,0,0,.7); }
.vp-box.is-fs.is-portrait-fs .vp-title { font-size: 13px; }

/*
 * 仅当文字超长（JS 判定后加 is-scrolling）才滚动。
 *
 * 无缝滚动的做法：用 ::after 复制一份接在后面，整体左移 ——
 * 单份文字滚到末尾会露出空白，两份首尾相接才连贯。
 * 位移量由 JS 按实测文字宽度写入 --vp-title-shift。
 */
.vp-title-wrap.is-scrolling .vp-title {
    animation: vp-title-scroll 14s linear infinite;
}
.vp-title-wrap.is-scrolling .vp-title::after {
    content: attr(data-text);
    display: inline-block;
    /* 两份之间留出间隔，避免接缝处连成一串 */
    margin-left: 40px;
}
@keyframes vp-title-scroll {
    0% { transform: translateX(0); }
    100% { transform: translateX(calc(-1 * var(--vp-title-shift, 100%))); }
}

/* 全屏（横屏）：控件放大，便于点按 */
.vp-box.is-fs .vp-bottom { padding: 0 28px 20px; }
.vp-box.is-fs .vp-progress { height: 34px; }
.vp-box.is-fs .vp-track { height: 4px; }
.vp-box.is-fs .vp-center { width: 72px; height: 72px; }
.vp-box.is-fs .vp-rate { font-size: 15px; padding: 5px 12px; }
.vp-box.is-fs .vp-fs { width: 20px; height: 20px; }
.vp-box.is-fs .vp-hud.is-left { left: 64px; }
.vp-box.is-fs .vp-hud.is-right { right: 64px; }

/* 竖屏全屏：控件不必像横屏那样放大，留出安全区避免被刘海/手势条压住 */
.vp-box.is-fs.is-portrait-fs .vp-center { width: 64px; height: 64px; }
.vp-box.is-fs.is-portrait-fs .vp-bottom {
    padding: 0 16px calc(16px + env(safe-area-inset-bottom)); }
.vp-box.is-fs.is-portrait-fs .vp-scrim-top { height: 60px; }

.vp-progress { position: relative; height: 24px; display: flex; align-items: center;
    /* 关键：禁用浏览器默认的滚动/缩放手势，否则移动端拖拽会被页面滚动抢走 */
    touch-action: none; -webkit-user-select: none; user-select: none; }
.vp-track { position: relative; width: 100%; height: 3px; border-radius: 2px;
    background: rgba(255,255,255,.26); }
.vp-buffer { position: absolute; left: 0; top: 0; height: 100%; width: 0;
    border-radius: 2px; background: rgba(255,255,255,.38); }
.vp-fill { position: absolute; left: 0; top: 0; height: 100%; width: 0;
    border-radius: 2px; background: #f0a63c; }
.vp-thumb { position: absolute; left: 0; top: 50%; width: 11px; height: 11px; margin-left: -5.5px;
    border-radius: 50%; background: #f0a63c; transform: translateY(-50%) scale(.85);
    transition: transform .15s ease; }
.vp-progress:active .vp-thumb { transform: translateY(-50%) scale(1.25); }

.vp-row { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }

/* 左侧：时间 + 网速 + 加载进度，同排左对齐 */
.vp-left { display: flex; align-items: center; min-width: 0; flex: 1; }

/*
 * 网速/加载：紧跟在时间右侧，与时间同一行 ——
 * 独立成行会白占高度，小窗（非全屏）下尤其明显。
 */
.vp-stat { display: flex; align-items: center; margin-left: 10px;
    font-size: 11px; color: rgba(255,255,255,.62);
    font-variant-numeric: tabular-nums; letter-spacing: .2px;
    overflow: hidden; white-space: nowrap; }
.vp-stat-net { color: rgba(255,255,255,.78); }
.vp-stat-sep { margin: 0 5px; opacity: .45; }
.vp-stat-buf { opacity: .9; }
/* 加载进度偏低时点亮，提示可能卡顿 */
.vp-stat.is-weak .vp-stat-buf { color: #f0a63c; }

.vp-time { font-size: 12px; color: rgba(255,255,255,.8);
    font-variant-numeric: tabular-nums; letter-spacing: .3px; flex-shrink: 0; }
.vp-acts { display: flex; align-items: center; flex-shrink: 0; }
.vp-rate { font-size: 12px; color: rgba(255,255,255,.8); padding: 2px 8px;
    border-radius: 4px; background: rgba(255,255,255,.13); margin-right: 14px; }
.vp-rate:active { background: rgba(255,255,255,.24); }

/*
 * 倍速面板：浮在控制条上方。
 *
 * 挂在容器上（不在 .vp-layer 内），因此控件自动隐藏后仍可交互，
 * 也不会跟着控件层一起淡出 —— 选速度时控件若突然消失会很突兀。
 */
.vp-rates { position: absolute; right: 12px; bottom: 56px; z-index: 9;
    min-width: 108px; padding: 8px 0 6px; border-radius: 8px;
    background: rgba(20, 23, 28, .96);
    box-shadow: 0 6px 20px rgba(0, 0, 0, .55);
    border: 1px solid rgba(255,255,255,.1);
    opacity: 0; visibility: hidden; transform: translateY(6px);
    transition: opacity .16s ease, transform .16s ease, visibility .16s; }
.vp-rates.is-on { opacity: 1; visibility: visible; transform: translateY(0); }

.vp-rates-title { padding: 2px 12px 8px; font-size: 11px;
    color: rgba(255,255,255,.45); letter-spacing: .5px; }

.vp-rates-item { padding: 7px 14px; font-size: 13px; color: rgba(255,255,255,.85);
    text-align: center; font-variant-numeric: tabular-nums; }
.vp-rates-item:active { background: rgba(255,255,255,.1); }
.vp-rates-item.is-on { color: #f0a63c; font-weight: 600;
    background: rgba(240,166,60,.12); }

/* ---------------- 选集面板 ---------------- */

/*
 * 遮罩：压暗画面并拦截点击（点空白收起）。
 * 层级低于面板、高于控制条，避免控制条穿在面板之上。
 */
.vp-eps-mask { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 10;
    background: rgba(0,0,0,.5); opacity: 0; visibility: hidden;
    transition: opacity .18s ease, visibility .18s; }
.vp-eps-mask.is-on { opacity: 1; visibility: visible; }

/*
 * 面板本体。
 *
 * 形态按容器方向自动切换，**不用媒体查询**：
 * 播放器全屏时会加 is-portrait-fs（竖屏全屏），
 * 用类名判断比 media query 更贴合播放器自身状态。
 *
 * 默认（横屏全屏）：右侧抽屉，占 1/3 宽、满高。
 */
.vp-eps { position: absolute; z-index: 11; display: flex; flex-direction: column;
    background: #14171c; opacity: 0; visibility: hidden;
    transition: opacity .2s ease, visibility .2s ease, transform .2s ease;
    right: 0; top: 0; bottom: 0; width: 33.33%;
    border-radius: 10px 0 0 10px; transform: translateX(14px); }
.vp-eps.is-on { opacity: 1; visibility: visible; transform: translateX(0); }

/* 竖屏全屏：底部抽屉，占满宽、最高 62% */
.vp-box.is-portrait-fs .vp-eps { right: auto; left: 0; bottom: 0; top: auto;
    width: 100%; max-height: 62%; border-radius: 10px 10px 0 0;
    transform: translateY(14px); }
.vp-box.is-portrait-fs .vp-eps.is-on { transform: translateY(0); }

.vp-eps-head { flex: none; display: flex; align-items: center;
    padding: 12px 14px 10px; }
.vp-eps-title { font-size: 14px; font-weight: 600; color: #e8eaed; }
.vp-eps-count { flex: 1; margin-left: 8px; font-size: 11px;
    color: rgba(255,255,255,.42); font-variant-numeric: tabular-nums; }
.vp-eps-close { flex-shrink: 0; padding: 3px 12px; border-radius: 12px;
    background: rgba(255,255,255,.1); font-size: 11px; color: #f0a63c; }
.vp-eps-close:active { background: rgba(255,255,255,.18); }

/*
 * 滚动区：flex:1 + min-height:0 缺一不可 ——
 * flex 子项默认 min-height:auto，不加这行内容多时列表会被切掉不滚动。
 */
.vp-eps-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 0 12px 14px; display: grid; gap: 8px;
    grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
    align-content: start; }

.vp-eps-item { height: 30px; padding: 0 6px; border-radius: 5px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: rgba(255,255,255,.82);
    background: rgba(255,255,255,.07);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.vp-eps-item:active { background: rgba(255,255,255,.16); }
.vp-eps-item.is-on { color: #f0a63c; font-weight: 600;
    background: rgba(240,166,60,.16); }

.vp-eps-empty { grid-column: 1 / -1; padding: 24px 0; text-align: center;
    font-size: 12px; color: rgba(255,255,255,.4); }

/*
 * 选集入口：仅全屏时出现。
 *
 * 非全屏下选集列表就在播放器下方，不需要入口；全屏时画面铺满、
 * 列表被盖住，才需要这个按钮唤起抽屉。
 *
 * 触控区刻意放大到 32×26（图标 18×18 居中）——
 * 原先只有 18×18，在手机上几乎点不中，用户会以为「按钮坏了」。
 */
.vp-ep { display: none; width: 32px; height: 26px; position: relative;
    margin-right: 6px; border-radius: 4px; }
.vp-box.is-fs .vp-ep { display: block; }
.vp-ep:active { background: rgba(255,255,255,.16); }
.vp-ep:before { content: ""; position: absolute; left: 7px; right: 7px; top: 8px;
    height: 2px; border-radius: 1px; background: rgba(255,255,255,.88);
    box-shadow: 0 5px 0 rgba(255,255,255,.88), 0 10px 0 rgba(255,255,255,.88); }

/* 方向切换同样放大触控区 */
.vp-dir { display: none; width: 32px; height: 26px; position: relative; margin-right: 6px;
    border-radius: 4px; }
.vp-box.is-fs .vp-dir { display: block; }
.vp-dir:active { background: rgba(255,255,255,.16); }
.vp-dir:before { content: ""; position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%); width: 8px; height: 14px;
    border: 2px solid rgba(255,255,255,.88); border-radius: 2px; }
.vp-dir.is-landscape:before { width: 14px; height: 8px; }

/* 全屏切换也一并放大，三个按钮触控手感一致 */
.vp-fs { width: 32px; height: 26px; position: relative; border-radius: 4px; }
.vp-fs:active { background: rgba(255,255,255,.16); }
.vp-fs:before, .vp-fs:after { content: ""; position: absolute; width: 6px; height: 6px; }
.vp-fs:before { left: 9px; top: 7px; border-left: 2px solid rgba(255,255,255,.88);
    border-top: 2px solid rgba(255,255,255,.88); }
.vp-fs:after { right: 9px; bottom: 7px; border-right: 2px solid rgba(255,255,255,.88);
    border-bottom: 2px solid rgba(255,255,255,.88); }
.vp-fs.is-exit:before { left: auto; right: 9px; top: 7px; border-left: 0; border-top: 0;
    border-right: 2px solid rgba(255,255,255,.88); border-bottom: 2px solid rgba(255,255,255,.88); }
.vp-fs.is-exit:after { right: auto; left: 9px; bottom: 7px; border-right: 0; border-bottom: 0;
    border-left: 2px solid rgba(255,255,255,.88); border-top: 2px solid rgba(255,255,255,.88); }

/* 转圈动画被加载浮层的进度环与缓冲转圈共用，故保留关键帧 */
@keyframes vp-rot { from { transform: rotate(0); } to { transform: rotate(360deg); } }

/*
 * 加载浮层：缓冲进度环 + 实时网速。
 *
 * 只在下述时机出现，播得顺时不打扰：
 *   - 首次建立缓冲（尚未能播）
 *   - waiting / stalled（卡顿）
 * 文字形如「正在加载 · 1.2 MB/s · 45%」。
 */
.vp-load { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 7;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(0,0,0,.42); opacity: 0; visibility: hidden;
    transition: opacity .18s ease, visibility .18s ease; pointer-events: none; }
.vp-load.is-on { opacity: 1; visibility: visible; }

/* 用 conic-gradient 画进度环，避免引入 SVG 或图片资源 */
.vp-load-ring { width: 38px; height: 38px; border-radius: 50%; margin-bottom: 12px;
    background: conic-gradient(#f0a63c var(--vp-p, 0%), rgba(255,255,255,.18) 0);
    -webkit-mask: radial-gradient(circle at center, transparent 13px, #000 14px);
    mask: radial-gradient(circle at center, transparent 13px, #000 14px);
    /* 未知进度时整体缓慢旋转，给出「在动」的反馈 */
    animation: vp-rot 1.6s linear infinite; }
.vp-load-ring.is-known { animation: none; }

.vp-load-text { font-size: 12px; color: rgba(255,255,255,.88);
    font-variant-numeric: tabular-nums; letter-spacing: .3px; }
.vp-load-sub { margin-top: 5px; font-size: 11px; color: rgba(255,255,255,.6);
    font-variant-numeric: tabular-nums; }

/* 手势 HUD：独立于控件层，控件隐藏时依然可见 */
.vp-hud { position: absolute; top: 50%; transform: translateY(-50%); z-index: 6;
    display: flex; flex-direction: column; align-items: center;
    padding: 12px 10px; border-radius: 10px; background: rgba(0,0,0,.58);
    opacity: 0; transition: opacity .16s ease; pointer-events: none; }
.vp-hud.is-on { opacity: 1; }
.vp-hud.is-left { left: 30px; }
.vp-hud.is-right { right: 30px; }
.vp-hud-label { font-size: 11px; color: rgba(255,255,255,.72); letter-spacing: 1px; }
.vp-hud-bar { position: relative; width: 5px; height: 92px; margin: 8px 0 6px;
    border-radius: 3px; background: rgba(255,255,255,.22); overflow: hidden; }
.vp-hud-fill { position: absolute; left: 0; bottom: 0; width: 100%; height: 0%;
    border-radius: 3px; background: #f0a63c; }
.vp-hud-val { font-size: 11px; color: rgba(255,255,255,.86);
    font-variant-numeric: tabular-nums; }

/* 切换遮罩：换集时的黑场反馈，新源可播放后自动揭开 */
.vp-switch { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 8;
    display: flex; align-items: center; justify-content: center;
    background: #000; opacity: 0; visibility: hidden;
    transition: opacity .18s ease, visibility .18s ease; }
.vp-switch.is-on { opacity: 1; visibility: visible; }
.vp-switch-text { font-size: 13px; color: rgba(255,255,255,.82); letter-spacing: 1px; }

/*
 * 双击快进/快退提示。
 *
 * 只在双击的瞬间出现 600ms，位置固定在画面中央偏上 ——
 * 与控制条、手势 HUD 都不重叠，避免同一时刻出现三层浮层。
 */
.vp-seek-hud { position: absolute; left: 50%; top: 42%; transform: translate(-50%,-50%);
    z-index: 12; padding: 10px 18px; border-radius: 24px;
    background: rgba(0,0,0,.66); color: rgba(255,255,255,.94);
    font-size: 13px; letter-spacing: .5px; font-variant-numeric: tabular-nums;
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .16s ease, visibility .16s ease; }
.vp-seek-hud.is-on { opacity: 1; visibility: visible; }

/*
 * 长按倍速提示。
 *
 * 与手势 HUD 同样独立于控件层 —— 长按时控制条可能正好自动隐藏，
 * 提示若挂在控件层会跟着一起消失，用户就不知道「现在在 2 倍速」。
 */
.vp-hold-hud { position: absolute; left: 50%; top: 16%; transform: translateX(-50%);
    z-index: 12; padding: 6px 14px; border-radius: 16px;
    background: rgba(0,0,0,.66); color: #f0a63c;
    font-size: 12px; font-weight: 600; letter-spacing: .5px;
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .16s ease, visibility .16s ease; }
.vp-hold-hud.is-on { opacity: 1; visibility: visible; }

/*
 * 播放中的缓冲转圈（非首次加载）。
 *
 * 与 .vp-load 的区别：浮层是「还没出画」时的铺满提示，
 * 这个是「画面已出、暂时没数据」的轻量提示 ——
 * 半透明小环 + 不铺满，不遮挡已出画的画面。
 */
.vp-buf { position: absolute; left: 50%; top: 50%; width: 34px; height: 34px;
    margin: -17px 0 0 -17px; z-index: 7; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.16); border-top-color: rgba(255,255,255,.82);
    animation: vp-rot .8s linear infinite;
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .2s ease, visibility .2s; }
.vp-buf.is-on { opacity: 1; visibility: visible; }

/*
 * 错误态浮层：致命错误且重试耗尽后才出现。
 *
 * 复用 .vp-load 的排版，但文案与配色区分开，
 * 让用户一眼看出「不是卡住，是真的放不了」。
 */
.vp-err { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 9;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(0,0,0,.72); opacity: 0; visibility: hidden;
    transition: opacity .18s ease, visibility .18s ease; }
.vp-err.is-on { opacity: 1; visibility: visible; }
.vp-err-text { font-size: 13px; color: rgba(255,255,255,.86); letter-spacing: .5px; }
.vp-err-sub { margin-top: 6px; font-size: 11px; color: rgba(255,255,255,.45); }
.vp-err-retry { margin-top: 14px; padding: 7px 22px; border-radius: 18px;
    background: rgba(240,166,60,.16); color: #f0a63c;
    font-size: 12px; letter-spacing: .5px; }
.vp-err-retry:active { background: rgba(240,166,60,.28); }
`;

export default {
    data() {
        return {
            num: '',
            videoEl: null,
            boxEl: null,
            hls: null,
            layerEl: null,
            progressEl: null,
            fillEl: null,
            bufferEl: null,
            thumbEl: null,
            timeEl: null,
            rateEl: null,
            centerEl: null,
            fsEl: null,
            dirEl: null,
            epEl: null,
            hudEl: null,
            hudFillEl: null,
            hudValEl: null,
            hudLabelEl: null,
            loadEl: null,
            loadRingEl: null,
            loadTextEl: null,
            loadSubEl: null,
            /** 进度条下方的常驻信息行（网速 / 缓冲） */
            statEl: null,
            statNetEl: null,
            statBufEl: null,
            /** 全屏顶部栏（返回键 + 剧名） */
            topEl: null,
            backEl: null,
            titleEl: null,
            titleWrapEl: null,
            /** 播放中的缓冲转圈（区别于首次加载浮层的进度环） */
            bufEl: null,
            /** 双击快进/快退提示 */
            seekHudEl: null,
            /** 长按加速提示 */
            holdHudEl: null,
            /** 致命错误浮层（重试耗尽后出现） */
            errEl: null,
            errTextEl: null,
            errSubEl: null,
            /** 当前标题文本（用于去重，避免重复触发动画） */
            titleText: '',
            /** 倍速面板 */
            ratePanelEl: null,
            rateListEl: null,
            rateItems: null,
            ratePanelOn: false,
            /** 选集面板 */
            epPanelEl: null,
            epListEl: null,
            epCountEl: null,
            epMaskEl: null,
            epPanelOn: false,
            epItems: null,
            /** 逻辑层同步来的剧集数据 */
            episodeList: [],
            episodeIndex: 0,
            /**
             * 网速统计：累计下载量 + 滑动窗口采样。
             *
             * 为什么不用「单请求 stats.loaded 的增量」：
             *   hls.js 的 xhr loader 在下载途中只更新 stats.loaded，
             *   并不触发 callbacks.onProgress（反混淆源码已确认），
             *   onProgress 实际只在**请求结束时**调一次。
             *   而 hls 会**并发**下载多个分片，各分片的 stats.loaded
             *   互不相干，A 报 500KB、B 报 300KB 会被误判成「字节数回退」
             *   而不断重置基线 —— 这正是网速恒为 0 的根因。
             *
             * 改为只累加「每次请求完成的字节数」：
             * 累计值单调递增，并发下天然正确；
             * 再用滑动窗口算最近若干秒的平均速率，数字平稳不跳。
             */
            totalLoaded: 0,
            loadSamples: [],
            /** 上次记录的原生播放已缓冲秒数（仅 iOS 原生 HLS 路径用） */
            nativeBufferedSec: null,
            /** 最近一次拿到数据的时刻，用于无流量时让网速衰减到 0 */
            lastLoadedAt: 0,
            /** 平滑后的网速（字节/秒） */
            speed: 0,
            /** hls 给出的缓冲水位（0~100），未知为 null */
            hlsBufferPct: null,
            /** 网速刷新定时器 */
            speedTimer: null,
            /** 离线缓存信息（由逻辑层同步过来；不要与 prop 同名） */
            offlineInfo: null,
            /** 最近一次同步过来的播放地址（离线信息到达时要用） */
            currentSrc: '',
            switchEl: null,
            switchTextEl: null,
            /** 切换遮罩是否待揭开（等新源 canplay） */
            switching: false,
            /** 遮罩的兜底揭开定时器 */
            switchTimer: null,
            hudTimer: null,
            hideTimer: null,
            /** 双击快进提示的定时器 */
            seekHudTimer: null,
            /**
             * 长按加速状态。
             *
             * 定时器与起点都放在**实例**上而不是 bindControls 的闭包里 ——
             * 手势层（bindGesture）也需要取消长按：用户按住不动触发了加速，
             * 随后手指上滑想调亮度时，若不取消就会「一边 3 倍速一边改亮度」，
             * 两个手势互相打架。闭包里的变量跨方法取不到，故上提到实例。
             */
            holding: false,
            /** 长按判定定时器 */
            holdTimer: null,
            /** 取消长按的入口（由 bindControls 注入，供手势层复用） */
            cancelHold: null,
            /** 长按起点，用于判断是否已滑动 */
            holdStartX: 0,
            holdStartY: 0,
            /** 长按前的原速，松手时还原 */
            rateBeforeHold: 1,
            /** 最近一次从 props 同步过来的倍速，用于去重（避免覆盖用户手选值） */
            rateFromProps: 0,
            /** 上次点击的时间与位置，用于双击判定 */
            lastTapAt: 0,
            lastTapX: 0,
            /** 首次加载是否已完成（区分「正在打开」与「播放中卡顿」） */
            firstReady: false,
            /** 缓冲开始的时刻，用于判定「卡了很久」 */
            stallSince: 0,
            /** 是否已就当前这次卡顿上报过 waiting（避免高频重复 emit） */
            stallReported: false,
            /** 致命错误重试计数（原生播放路径用） */
            fatalRetries: 0,
            /** hls.js 致命错误的原地恢复次数 */
            hlsRetries: 0,
            /** 是否已进入不可恢复的错误态 */
            errored: false,
            /** 屏幕常亮句柄（App 端） */
            keepAwake: false,
            /** 重载后待恢复的播放位置（秒），由 loadedmetadata 消费 */
            pendingSeek: 0,
            /** 本次 loadSource 是否由错误自愈触发（决定是否保留重试计数） */
            reloading: false,
            dragging: false,
            /** 拖动中的进度比例（0~1），非拖动时为 null */
            dragRatio: null,
            /** 刚拖完的短暂标记，用于过滤浏览器补发的 click */
            justDragged: false,
            /** 手势刚结束的短标记，同样用于过滤补发的 click */
            suppressClick: false,
            /** 全屏状态 */
            landscapeOn: false,
            /** 全屏下的方向：true=横屏（默认），false=竖屏 */
            landscapeLayout: true,
            /** 当前手势会话 */
            gesture: null,
            /** 亮度（0~1），App 端映射到系统/应用屏幕亮度 */
            brightness: 1,
            /** 音量（0~1） */
            volume: 1,
            /** 进入页面时的原始亮度，用于退出时还原 */
            originBrightness: -1,
            /** 是否真正改过亮度 */
            brightnessTouched: false,
            /** 销毁标记，避免重复清理 */
            destroyed: false,
            /** 全局事件句柄（需持有引用才能解绑） */
            docMoveHandler: null,
            docUpHandler: null,
            props: {}
        };
    },
    computed: {
        boxId() {
            return `vp-${this.num}`;
        }
    },
    beforeUnmount() {
        this.destroy();
    },
    methods: {
        /**
         * 清理：还原亮度 / 系统方向 / 状态栏，销毁 hls 实例。
         *
         * 由 `destroy` 指令显式触发，`beforeUnmount` 作为兜底 ——
         * 退出全屏这类副作用必须可靠执行，不能只依赖生命周期时序。
         */
        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.clearHideTimer();
            this.stopSpeedTicker();
            if (this.hudTimer) {
                clearTimeout(this.hudTimer);
                this.hudTimer = null;
            }
            if (this.switchTimer) {
                clearTimeout(this.switchTimer);
                this.switchTimer = null;
            }
            if (this.seekHudTimer) {
                clearTimeout(this.seekHudTimer);
                this.seekHudTimer = null;
            }
            // 长按定时器：不清的话退出页面后还会触发一次倍速设置
            if (this.holdTimer) {
                clearTimeout(this.holdTimer);
                this.holdTimer = null;
            }
            this.holding = false;
            // 常亮是全局副作用，离开页面必须解除，否则会一直亮着耗电
            this.setKeepAwake(false);
            this.restoreBrightness();
            this.exitFullscreen(true);
            if (this.hls) {
                try {
                    this.hls.destroy();
                } catch (e) {
                    /* 忽略 */
                }
                this.hls = null;
            }
            if (this.docMoveHandler) document.removeEventListener('mousemove', this.docMoveHandler);
            if (this.docUpHandler) document.removeEventListener('mouseup', this.docUpHandler);
        },

        /* ---------------- 基础工具 ---------------- */

        isApple() {
            const ua = (navigator.userAgent || '').toLowerCase();
            return ua.indexOf('iphone') !== -1 || ua.indexOf('ipad') !== -1;
        },

        /** 是否运行在 App 环境（UA 判定，plus 可能尚未就绪）。 */
        isAppEnv() {
            return !!window.plus || /Html5Plus/i.test(navigator.userAgent || '');
        },

        /** plus 是否已就绪（决定全屏、亮度等能力走原生还是 H5 兜底）。 */
        isApp() {
            return !!(window.plus && window.plus.screen);
        },

        isHlsUrl(url) {
            return /\.m3u8($|\?)/i.test(url || '');
        },

        /** 秒 → mm:ss，超 1 小时显示 hh:mm:ss */
        fmt(sec) {
            const s = Math.max(0, Math.floor(sec || 0));
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const r = s % 60;
            const pad = n => String(n).padStart(2, '0');
            return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
        },

        /** 注入控件样式，全局一次。 */
        injectStyle() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.appendChild(document.createTextNode(CSS_TEXT));
            document.head.appendChild(style);
        },

        /** 动态加载 hls.js（renderjs 不能 import）。 */
        loadHlsLib() {
            return new Promise((resolve, reject) => {
                if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
                    resolve(window.Hls);
                    return;
                }
                const exist = document.querySelector(`script[data-vp-hls="1"]`);
                if (exist) {
                    exist.addEventListener('load', () => resolve(window.Hls));
                    exist.addEventListener('error', reject);
                    return;
                }
                const s = document.createElement('script');
                s.src = HLS_URL;
                s.setAttribute('data-vp-hls', '1');
                s.onload = () => resolve(window.Hls);
                s.onerror = () => reject(new Error('hls.js load failed'));
                document.head.appendChild(s);
            });
        },

        /* ---------------- 生命周期入口 ---------------- */

        /** 接收实例种子，用于计算挂载点 id。 */
        onSeedChange(seed) {
            this.num = seed;
        },

        onSrcChange(src) {
            if (!src) return;
            // 记住最近一次地址：离线信息到达时需要用它回退
            this.currentSrc = src;
            // 种子可能后到，确保 id 已就绪
            if (!this.num) {
                const el = document.querySelector('[id^="vp-"]');
                if (el) this.num = (el.id || '').replace('vp-', '');
            }
            this.$nextTick(() => this.setup(src, 0));
        },

        onViewportChange(props) {
            this.props = props || {};
            const el = this.videoEl;

            // 选集数据先落地：面板可能在 videoEl 就绪前就已被同步
            const episodes = this.props.episodes || [];
            const curIdx = Number(this.props.currentIndex) || 0;
            const listChanged =
                !this.episodeList ||
                this.episodeList.length !== episodes.length ||
                this.episodeList.some((it, i) => it.id !== episodes[i].id);
            const idxChanged = this.episodeIndex !== curIdx;

            this.episodeList = episodes;
            this.episodeIndex = curIdx;

            // 面板开着时实时刷新，否则等下次打开时重建
            if (this.epPanelOn && (listChanged || idxChanged)) this.buildEpisodePanel();

            // 顶部栏标题
            this.applyTitle(this.props.title);

            if (!el) return;
            el.muted = !!this.props.muted;
            el.style.objectFit = this.props.objectFit || 'contain';
            if (this.props.poster) el.poster = this.props.poster;

            /*
             * 倍速只在「prop 真的变了」时才写回元素。
             *
             * 早先这里无条件执行 `el.playbackRate = props.playbackRate`，
             * 而 viewport 是聚合属性 —— episodes / title / currentIndex
             * 任一变化都会推一次，于是每次切集、每次标题更新都会把
             * 用户刚选的 2 倍速悄悄打回 1 倍速（表现为「速度自己变回去了」）。
             * 长按加速期间更糟：会被这一行直接打断。
             */
            const propRate = Number(this.props.playbackRate) || 0;
            if (propRate > 0 && propRate !== this.rateFromProps && !this.holding) {
                this.rateFromProps = propRate;
                this.applyRate(propRate);
            }
        },

        /** 离线缓存信息变化：记录后重新装载播放源。 */
        onOfflineChange(info) {
            // 注意不要写 this.offline —— 那是 prop 名，renderjs 侧用 offlineInfo 承接
            this.offlineInfo = info || null;
            const src = this.currentSrc || this.offlineSrc() || '';
            if (!src && !this.offlineManifest()) return;
            if (!this.videoEl) return;
            this.$nextTick(() => this.loadSource(src));
        },

        /** 离线索引正文。 */
        offlineManifest() {
            return (this.offlineInfo && this.offlineInfo.manifest) || '';
        },

        /** 离线时用于回落的在线地址。 */
        offlineSrc() {
            return (this.offlineInfo && this.offlineInfo.fallbackSrc) || '';
        },

        /** 切换遮罩：按 seq 判断是「压黑」还是「揭开」。 */
        onHintChange(hint) {
            if (!hint || !hint.seq) return;
            if (hint.text) {
                this.showSwitch(hint.text);
            } else {
                this.hideSwitch();
            }
        },

        /** 压黑画面并显示提示，等待新源就绪后揭开。 */
        showSwitch(text) {
            this.switching = true;
            // 新源尚未出画，加载浮层与缓冲转圈都退场，避免与黑场叠成两层
            this.firstReady = false;
            this.showBuffer(false);
            if (this.switchTextEl) this.switchTextEl.textContent = text;
            if (this.switchEl) this.switchEl.classList.add('is-on');
            if (this.layerEl) this.layerEl.classList.add('is-hidden');

            /*
             * 兜底：正常路径由 canplay / playing 揭开，但若新源一直起不来
             * （片源挂掉、网络异常），遮罩必须自己退场，否则画面永远黑着。
             */
            if (this.switchTimer) clearTimeout(this.switchTimer);
            this.switchTimer = setTimeout(() => this.hideSwitch(), 8000);
        },

        /** 揭开切换遮罩。 */
        hideSwitch() {
            if (!this.switching) return;
            this.switching = false;
            if (this.switchTimer) {
                clearTimeout(this.switchTimer);
                this.switchTimer = null;
            }
            if (this.switchEl) this.switchEl.classList.remove('is-on');
            // 遮罩退场后由加载态接管（可能仍是黑屏等首帧）
            this.updateLoading();
        },

        /* ---------------- 加载浮层（进度 + 网速） ---------------- */

        /**
         * 计算「当前播放位置之后已缓冲的秒数」。
         *
         * 必须取**包含 currentTime 的那一段** buffered 区间，而不是
         * 简单取最后一段的 end：
         *
         *   拖动进度条后，浏览器会保留/新拉出多段不连续的 buffered，
         *   末段的 end 可能远在播放点之后（也可能是已跳过的旧区间）。
         *   用 `end(last) - currentTime` 会算出「已经缓冲 300 秒」这种
         *   明显错误的值，进度条缓冲段与加载百分比都会跟着失真。
         *
         * 找不到包含 currentTime 的区间时（seek 落点尚未入缓冲），
         * 返回 0 —— 此时确实是「一点都没有」，符合直觉。
         */
        forwardBufferSec() {
            const el = this.videoEl;
            if (!el || !el.buffered || !el.buffered.length) return 0;

            const cur = el.currentTime || 0;
            try {
                for (let i = 0; i < el.buffered.length; i++) {
                    const start = el.buffered.start(i);
                    const end = el.buffered.end(i);
                    if (start <= cur && cur <= end) return Math.max(end - cur, 0);
                }
            } catch {
                return 0;
            }
            return 0;
        },

        /**
         * 全片已缓冲比例（0~100），取不到为 -1。
         *
         * 用于信息行「加载 N%」与加载浮层的进度环。
         * 同样必须按「包含播放点的那一段」算 —— 理由见 forwardBufferSec。
         */
        loadedPercent() {
            const el = this.videoEl;
            if (!el) return -1;

            const dur = el.duration || 0;
            if (dur <= 0 || !isFinite(dur)) return -1;

            /*
             * 优先用 hls.js 的前向缓冲水位：它反映的是「hls 已喂给
             * MediaSource 的量」，比 video.buffered 更贴近真实下载进度，
             * 尤其在 seek 后 buffered 尚未重排的那一小段时间里。
             */
            if (this.hlsBufferPct !== null) return this.hlsBufferPct;

            if (!el.buffered || !el.buffered.length) return -1;

            const cur = el.currentTime || 0;
            try {
                for (let i = 0; i < el.buffered.length; i++) {
                    const start = el.buffered.start(i);
                    const end = el.buffered.end(i);
                    if (start <= cur && cur <= end) {
                        return Math.min((end / dur) * 100, 100);
                    }
                }
            } catch {
                return -1;
            }
            return -1;
        },

        /**
         * 刷新进度条下方的常驻信息行（网速 + 加载进度）。
         *
         * 与 updateLoading 的区别：这一行**始终可见**（只要控件显示），
         * 不依赖是否卡顿。用户随时能看到「下得多快、加载了多少」。
         *
         * 关于「加载 100%」：hls.js 默认只预缓冲有限时长（见
         * HLS_MAX_BUFFER_LEN），长片永远不会真正下完整部，
         * 因此 100% 只在短片出现。无论哪种情况，网速都会随之归零 ——
         * 此时显示「已加载全部」而不是一个孤零零的破折号。
         */
        updateStat() {
            const el = this.videoEl;
            if (!el) return;

            const pct = this.loadedPercent();
            const loadedAll = pct >= 99.5;
            const bufSec = this.forwardBufferSec();

            if (this.statNetEl) {
                // 网速恒显数值：为 0 就是 0，不做状态替换
                this.statNetEl.textContent = formatSpeed(this.speed);
            }

            if (this.statBufEl) {
                if (pct < 0) {
                    this.statBufEl.textContent = '加载 —';
                } else if (loadedAll) {
                    this.statBufEl.textContent = '已加载全部';
                } else {
                    this.statBufEl.textContent = `加载 ${pct.toFixed(0)}%`;
                }
            }

            /*
             * 前向缓冲见底时点亮，提示随时可能卡。
             *
             * 用「前向缓冲秒数」而不是「全片加载百分比」作为判据：
             * 一部 40 集的片子加载到 2% 完全正常（后面还没看到），
             * 但前向缓冲只剩 1 秒就真的要卡了 —— 后者才是有意义的信号。
             */
            if (this.statEl) {
                const weak = el.readyState < 3 || bufSec < BUFFER_LOW_SEC;
                this.statEl.classList.toggle('is-weak', weak && !el.paused);
            }
        },

        /**
         * 刷新加载/缓冲浮层。
         *
         * 分三种状态，互不叠加：
         *   1. 换集中（switching）—— 黑场遮罩已在负责，这里完全退场
         *   2. 首次加载（尚未 firstReady）—— 铺满浮层 + 进度环 + 网速
         *   3. 播放中卡顿（waiting/前向缓冲见底）—— 轻量转圈，不遮画面
         */
        updateLoading() {
            // 常驻信息行跟着一起刷新
            this.updateStat();

            const el = this.videoEl;
            if (!el || !this.loadEl) return;

            // 换集时有专门的遮罩，这里不再叠一层
            if (this.switching) {
                this.loadEl.classList.remove('is-on');
                this.showBuffer(false);
                return;
            }

            const stalled = el.readyState < 3 && !el.paused;
            const lowBuffer = !el.paused && !el.ended && this.forwardBufferSec() < BUFFER_STALL_SEC;

            /*
             * 首次加载：还没成功出过画。
             *
             * 用「铺满的浮层」而不是小转圈 —— 此时画面本来就是黑的，
             * 大浮层能把「进度 + 网速 + 目标集数」一次说清，
             * 用户知道它在干活，不会以为卡死了。
             */
            if (!this.firstReady) {
                const show = stalled || el.readyState < 3;
                this.loadEl.classList.toggle('is-on', show);
                this.showBuffer(false);
                if (!show) return;
                this.paintLoadRing();
                return;
            }

            /*
             * 播放中：只给轻量转圈，绝不铺满浮层。
             *
             * 画面已经出来了，铺一层半透明黑幕会让「小卡一下」
             * 看起来像「整段黑屏」，观感比不提示更差。
             */
            this.loadEl.classList.remove('is-on');
            this.showBuffer(stalled || lowBuffer);
        },

        /** 刷新首次加载浮层里的进度环与文案。 */
        paintLoadRing() {
            const pct = this.loadedPercent();
            const known = pct >= 0;

            if (this.loadRingEl) {
                this.loadRingEl.style.setProperty('--vp-p', `${known ? pct.toFixed(0) : 0}%`);
                this.loadRingEl.classList.toggle('is-known', known);
            }
            if (this.loadTextEl) {
                this.loadTextEl.textContent = known ? `正在加载 ${pct.toFixed(0)}%` : '正在加载';
            }
            if (this.loadSubEl) {
                /*
                 * 浮层里的网速与常驻行不同：浮层只在起播/卡顿时出现，
                 * 此时网速为 0 说明可能已经断开，留空比显示 0 更含蓄。
                 * 卡顿超过 STALL_HINT_MS 才把「网络较慢」说出口 ——
                 * 刚缓冲一两秒就报「网络慢」会误伤正常的起播等待。
                 */
                if (this.speed > 0) {
                    this.loadSubEl.textContent = formatSpeed(this.speed);
                } else if (this.stallSince && Date.now() - this.stallSince > STALL_HINT_MS) {
                    this.loadSubEl.textContent = '网络较慢，正在重试…';
                } else {
                    this.loadSubEl.textContent = '';
                }
            }
        },

        /** 播放中的轻量缓冲转圈。 */
        showBuffer(on) {
            if (!this.bufEl) return;
            this.bufEl.classList.toggle('is-on', !!on);
        },

        onCommandChange(cmd) {
            if (!cmd) return;
            if (cmd === 'destroy') {
                this.destroy();
                return;
            }
            if (cmd === 'fullscreen') {
                this.toggleFullscreen();
                return;
            }
            if (cmd === 'hidecontrols') {
                /*
                 * 立即收起控制条（用于弹出选集抽屉等浮层前）。
                 * 不判 paused —— 暂停态下控制条本就常驻，但浮层要盖上来时
                 * 仍应让它退场，否则会和抽屉叠在一起。
                 */
                this.hideLayer();
                return;
            }
            if (cmd === 'closeepisodes') {
                this.hideEpisodePanel();
                return;
            }
            if (cmd === 'fullscreen:portrait') {
                // 已全屏时只切方向，避免重复进入全屏
                if (this.landscapeOn) {
                    if (this.landscapeLayout) this.toggleOrientation();
                } else {
                    this.enterFullscreen(false);
                }
                return;
            }
            if (cmd === 'orientation') {
                this.toggleOrientation();
                return;
            }
            if (cmd === 'exitfullscreen') {
                if (this.landscapeOn) this.exitFullscreen();
                return;
            }

            const el = this.videoEl;
            if (!el) return;
            if (cmd === 'play') {
                el.play();
            } else if (cmd === 'pause') {
                el.pause();
            } else if (cmd.indexOf('rate:') === 0) {
                const rate = Number(cmd.slice(5));
                if (!Number.isNaN(rate) && rate > 0) this.applyRate(rate);
            } else if (cmd.indexOf('seek:') === 0) {
                const pos = Number(cmd.slice(5));
                if (!Number.isNaN(pos)) this.applySeek(pos);
            }
        },

        /**
         * 定位到指定秒数。
         *
         * 元数据未就绪时直接写 currentTime 会被浏览器丢弃，
         * 因此挂一次 loadedmetadata 兜底 —— 切集续播依赖它。
         */
        applySeek(pos) {
            const el = this.videoEl;
            if (!el || !(pos > 0)) return;

            const doSeek = () => {
                try {
                    el.currentTime = pos;
                } catch (e) {
                    /* 忽略 */
                }
            };

            if (el.readyState >= 1 && el.duration > 0) {
                doSeek();
            } else {
                const once = () => {
                    doSeek();
                    el.removeEventListener('loadedmetadata', once);
                };
                el.addEventListener('loadedmetadata', once);
            }
        },

        /* ---------------- 初始化 ---------------- */

        setup(src, retry) {
            this.injectStyle();

            const mount = document.getElementById(this.boxId);
            if (!mount) {
                // 属性到达顺序不确定，挂载点可能尚未渲染，稍后重试
                const times = retry || 0;
                if (times < 10) {
                    setTimeout(() => this.setup(src, times + 1), 30);
                }
                return;
            }

            // 已初始化过则只换源
            if (this.videoEl) {
                this.loadSource(src);
                return;
            }

            mount.classList.add('vp-box');
            this.boxEl = mount;

            const el = document.createElement('video');
            this.videoEl = el;
            el.setAttribute('playsinline', 'true');
            el.setAttribute('webkit-playsinline', 'true');
            el.setAttribute('preload', 'auto');
            el.setAttribute('disablepictureinpicture', 'true');
            el.setAttribute('controlslist', 'nodownload');
            el.controls = false; // 控件自绘
            el.style.objectFit = (this.props && this.props.objectFit) || 'contain';
            if (this.props && this.props.poster) el.poster = this.props.poster;
            if (this.props && this.props.muted) el.muted = true;
            this.volume = typeof el.volume === 'number' ? el.volume : 1;

            this.bindVideoEvents(el);
            this.buildControls(mount);
            this.bindGesture();

            mount.insertBefore(el, mount.firstChild);
            this.initBrightness(0);
            this.startSpeedTicker();
            this.loadSource(src);
        },

        /** 装载播放源。 */
        loadSource(src) {
            const el = this.videoEl;
            if (!el) return;

            /*
             * 每次装载都重置「本次播放」的状态。
             *
             * firstReady 决定加载浮层走「铺满」还是「轻量转圈」，
             * 换集时新源尚未出画，必须退回「未就绪」；
             * 不清的话切集会沿用上一集的 true，新源的黑屏期
             * 只剩一个小转圈，用户看不到任何进度。
             */
            this.firstReady = false;
            this.stallReported = false;
            this.stallSince = 0;

            /*
             * 重试计数**只在换源时**归零，重载时保留。
             *
             * 这一条至关重要：错误自愈的流程是
             *   onMediaError → fatalRetries++ → reloadSource → loadSource
             * 若 loadSource 无条件把 fatalRetries 清零，
             * 那么每次重试前计数都被抹掉，「最多重试 2 次」这个上限
             * 永远不会被触及 —— 结果是坏源上无限重载、无限转圈。
             */
            if (!this.reloading) {
                this.hlsRetries = 0;
                this.fatalRetries = 0;
            }
            this.reloading = false;

            this.errored = false;
            this.hideError();

            /*
             * 立刻把加载浮层亮起来。
             *
             * 不能只等后续的 waiting/loadedmetadata 事件来刷 ——
             * 换源瞬间 readyState 可能仍残留上一集的值（>=3），
             * updateLoading 会据此判定「已经能播」而保持浮层隐藏，
             * 用户在新源出画前会看到一段没有任何提示的黑屏。
             *
             * 换集中除外：那时黑场遮罩已经承担了全部反馈，
             * 再叠一层浮层会在遮罩揭开前后闪一下。
             */
            if (this.loadEl && !this.switching) this.loadEl.classList.add('is-on');
            this.paintLoadRing();

            /*
             * 换源必须先清空网速统计。
             * 不清的话，上一集累计的 totalLoaded 会让滑动窗口里出现
             * 「旧集的字节量 + 新集的时间」，算出的速率虚高；
             * nativeBufferedSec 残留旧值也会让首帧增量算错。
             */
            this.totalLoaded = 0;
            this.loadSamples = [];
            this.nativeBufferedSec = null;
            this.speed = 0;
            // hls 缓冲水位是上一集的，留着会让进度环一开屏就显示旧值
            this.hlsBufferPct = null;

            if (this.hls) {
                try {
                    this.hls.destroy();
                } catch (e) {
                    /* 忽略 */
                }
                this.hls = null;
            }

            const nativeHls = !!el.canPlayType('application/vnd.apple.mpegurl');

            // 续播定位交给 loadedmetadata 处理，见 bindVideoEvents。

            /*
             * 离线播放：该集已缓存时，m3u8 正文与全部分片都在本机，
             * 通过自定义 loader 直接从沙箱读取，完全不碰网络。
             */
            if (this.offlineManifest()) {
                this.playOffline(el);
                return;
            }

            // 非 Safari 的 m3u8 需要 hls.js
            if (this.isHlsUrl(src) && !nativeHls) {
                this.loadHlsLib()
                    .then(Hls => {
                        if (!Hls || !Hls.isSupported()) {
                            el.src = src;
                            return;
                        }
                        const hls = new Hls(this.hlsConfig(this.makeMeteredLoader(Hls)));
                        this.hls = hls;
                        hls.loadSource(src);
                        hls.attachMedia(el);
                        this.bindHlsEvents(Hls, hls);
                    })
                    .catch(() => {
                        el.src = src;
                    });
            } else {
                el.src = src;
            }
        },

        /**
         * hls.js 实例配置。
         *
         * 相比默认值的调整及理由：
         *   - maxBufferLength / maxBufferSize：默认 30 秒缓冲对采集源的
         *     10 秒分片只够 3 片，网络一抖就断粮（见常量注释）
         *   - fragLoadingMaxRetry / manifestLoadingMaxRetry：默认重试次数偏少，
         *     采集源偶发 5xx 时直接判定致命错误，多给几次能自愈
         *   - fragLoadingRetryDelay：默认 1 秒起步，指数退避后仍然偏急，
         *     首片给 500ms 更利于快速恢复
         *   - backBufferLength：保留 30 秒已播数据，便于用户回拖不重新下载；
         *     默认值在部分版本为 Infinity，长片会持续占内存
         *   - startLevel：-1 表示自动选档，起播时按带宽估算挑一个合适的，
         *     避免「从最低清开始慢慢爬」
         *
         * @param loader 计量 loader（见 makeMeteredLoader），传空则用默认 loader
         */
        hlsConfig(loader) {
            const cfg = {
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: HLS_MAX_BUFFER_LEN,
                /*
                 * maxMaxBufferLength 保持默认量级（600 秒）。
                 *
                 * 它是「低码率档位下允许缓冲的上限」，只有多档位 ABR
                 * 且当前档位码率很低时才会被触及。采集源多为单档位，
                 * 这里不必收紧 —— 收紧反而会在低码率源上人为限流。
                 */
                maxMaxBufferLength: 600,
                maxBufferSize: HLS_MAX_BUFFER_SIZE,
                backBufferLength: 30,
                startLevel: -1,
                fragLoadingMaxRetry: 6,
                manifestLoadingMaxRetry: 4,
                levelLoadingMaxRetry: 4,
                fragLoadingRetryDelay: 500,
                fragLoadingMaxRetryTimeout: 8000
            };
            if (loader) cfg.loader = loader;
            return cfg;
        },

        /**
         * 生成「会计量」的 loader。
         *
         * 为什么不用 hls 的统计字段：
         *   `hls.levels[hls.currentLevel]` 在自动码率模式下 currentLevel 是 -1，
         *   levels[-1] 为 undefined，details 取不到 → 字节数恒 0。
         *
         * 为什么也不直接用 `callbacks.onProgress` 的 stats.loaded：
         *   反混淆 hls.min.js 后确认，xhr loader 的 onprogress 里只写
         *   `stats.loaded = e.loaded`，**并不回调 onProgress**；
         *   onProgress 实际只在请求结束时调一次（见 readystatechange 分支）。
         *   而 hls 会并发下载多个分片，各分片的 stats.loaded 互不相干，
         *   用「上一次的值」比较必然频繁回退、不断重置基线 ——
         *   这正是网速恒为 0 的根因。
         *
         * 现在改为：**每次请求各自单调累加**（闭包内记 reported），
         * 只把增量加到全局 totalLoaded。并发时各请求互不干扰，
         * 总量单调递增，统计必然正确。
         */
        makeMeteredLoader(Hls) {
            const self = this;
            const Base = (Hls.DefaultConfig && Hls.DefaultConfig.loader) || null;
            if (!Base) return undefined; // 拿不到基类就不包装，退回默认 loader

            return class MeteredLoader extends Base {
                load(context, config, callbacks) {
                    // 每个请求一份独立的已统计字节数（并发安全的关键）
                    let reported = 0;
                    const takeDelta = stats => {
                        if (!stats || typeof stats.loaded !== 'number') return;
                        const delta = stats.loaded - reported;
                        if (delta <= 0) return;   // 回退或重复上报，忽略
                        reported = stats.loaded;
                        self.addBytes(delta);
                    };

                    // 渐进式下载（highWaterMark 生效时）会在途中回调
                    const onProgress = callbacks.onProgress;
                    callbacks.onProgress = (stats, ctx, data, chunk) => {
                        takeDelta(stats);
                        if (onProgress) onProgress(stats, ctx, data, chunk);
                    };

                    // 请求完成必回调：兜住「没有渐进回调」的普通分片
                    const onSuccess = callbacks.onSuccess;
                    callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
                        takeDelta(stats);
                        if (onSuccess) onSuccess(response, stats, ctx, networkDetails);
                    };

                    return super.load(context, config, callbacks);
                }
            };
        },

        /**
         * 累加一次下载量并记录采样点。
         *
         * 只做「记账」，速率由 showSpeed() 在定时器里按滑动窗口算 ——
         * 分片到达是突发的（几百 KB 一次性完成），逐次算瞬时速率会剧烈跳动。
         */
        addBytes(bytes) {
            if (!(bytes > 0)) return;
            this.totalLoaded += bytes;
            this.lastLoadedAt = Date.now();
            this.loadSamples.push({ t: this.lastLoadedAt, b: this.totalLoaded });
            // 只保留窗口内的采样点，数组不会无限增长
            if (this.loadSamples.length > 64) {
                this.loadSamples.splice(0, this.loadSamples.length - 64);
            }
        },

        /**
         * 原生播放路径（iOS 原生 HLS / mp4 直连）的网速估算。
         *
         * 这条路径上浏览器自己管下载，不经过任何 loader，拿不到真实字节数。
         * 只能由 `buffered` 区间的增量反推：
         *
         *   新增字节 ≈ 新增缓冲秒数 × 估算码率
         *
         * 码率取值优先级：
         *   1. hls 当前 level 的 bitrate（原生路径下通常没有，仅兜底）
         *   2. 由已知的「总时长 + 影片体积」无法得到，故用经验默认值
         *
         * 结果只是量级正确的近似值，用于让用户看到「网速在动」，
         * 不追求与 loader 路径同等精度。
         */
        meterNative(el) {
            // 有 hls 实例时由 loader 精确统计，这里不重复计数
            if (this.hls) return;
            // 离线播放读本地文件，没有网络流量
            if (this.offlineInfo) return;

            let bufferedSec = 0;
            try {
                const b = el.buffered;
                for (let i = 0; i < b.length; i++) {
                    bufferedSec += b.end(i) - b.start(i);
                }
            } catch {
                return;
            }

            const last = this.nativeBufferedSec;
            this.nativeBufferedSec = bufferedSec;
            // 首次只记基线；回退（seek 后 buffer 被丢弃）时也重新记
            if (last === null || bufferedSec < last) return;

            const deltaSec = bufferedSec - last;
            if (deltaSec <= 0) return;

            this.addBytes(deltaSec * NATIVE_BITRATE_BPS_EST);
        },

        /**
         * 依据滑动窗口算平均速率。
         *
         * 窗口取最近 SPEED_WINDOW 秒：太短会随分片到达而脉冲式跳动，
         * 太长则切换码率后数字跟不上变化。
         */
        showSpeed(now) {
            const samples = this.loadSamples;
            const cutoff = now - SPEED_WINDOW * 1000;

            // 丢弃过期采样点（无流量时自然清空 → 速率归 0）
            while (samples.length > 1 && samples[0].t < cutoff) samples.shift();

            if (samples.length < 2) {
                this.speed = 0;
                return 0;
            }

            const first = samples[0];
            const last = samples[samples.length - 1];
            const dt = (last.t - first.t) / 1000;
            if (dt < 0.3) return this.speed;   // 数据太少，沿用上次

            const rate = (last.b - first.b) / dt;
            /*
             * 指数平滑：分片是成块到达的，不平滑会看到数字一跳一跳。
             * 首次有数据时直接采用，避免从 0 缓慢爬升显得迟钝。
             */
            this.speed = this.speed > 0 ? this.speed * 0.6 + rate * 0.4 : rate;
            return this.speed;
        },

        /**
         * 绑定 hls 的事件。
         *
         * 网速不在这里统计 —— 已改到 loader 层（见 makeMeteredLoader），
         * 因为 `hls.currentLevel` 在自动码率下是 -1，拿不到 levels 明细。
         * 这里只负责缓冲水位与致命错误。
         */
        bindHlsEvents(Hls, hls) {
            const onFrag = () => this.syncHlsBufferPct(hls);
            hls.on(Hls.Events.FRAG_LOADED, onFrag);
            hls.on(Hls.Events.FRAG_BUFFERED, onFrag);

            /*
             * 分片解析/追加失败也要刷新水位 —— 失败后前向缓冲可能
             * 已经不增长，不刷的话「加载 N%」会停在旧值上不动。
             */
            hls.on(Hls.Events.FRAG_PARSING_ERROR, onFrag);
            hls.on(Hls.Events.ERROR, (_e, data) => this.onHlsError(Hls, hls, data));
        },

        /**
         * hls.js 错误分级处理。
         *
         * 为什么不能「一 fatal 就报错给页面」：
         *   hls.js 把**网络类**致命错误（分片连续拉取失败）也标记为 fatal，
         *   但它同时提供了官方恢复路径 —— `startLoad()` 重新拉流、
         *   `recoverMediaError()` 换 MSE 缓冲。这两类占采集源实际故障的
         *   绝大多数，且**可自愈**。直接抛给页面会让页面去换线路甚至
         *   判定「片源不可用」，而其实原地重试就能接着播。
         *
         * 分级：
         *   1. 网络类 → startLoad()，限次
         *   2. 媒体类 → recoverMediaError()，限次
         *   3. 其它致命（含 MANIFEST 解析失败）→ 直接上报
         *   4. 重试次数用尽 → 上报给页面，由页面决定换线路
         */
        onHlsError(Hls, hls, data) {
            if (!data || !data.fatal) return;
            const type = data.type;
            const isNet = type === Hls.ErrorTypes.NETWORK_ERROR;
            const isMedia = type === Hls.ErrorTypes.MEDIA_ERROR;

            /*
             * 清单（m3u8 索引）解析失败属于「源本身坏了」，
             * 重试没有意义，直接交给页面换线路。
             */
            const isManifest =
                data.details && String(data.details).indexOf('manifest') !== -1;

            if (!isManifest && (isNet || isMedia) && this.hlsRetries < 3) {
                this.hlsRetries += 1;
                try {
                    if (isNet) {
                        /*
                         * startLoad 前要复位重试计数，否则 hls 内部
                         * 的 fragLoadingMaxRetry 已被耗尽，重新拉流仍会
                         * 立即判定致命 —— 这是「重试无效」的常见坑。
                         */
                        hls.startLoad();
                    } else {
                        hls.recoverMediaError();
                    }
                } catch (e) {
                    /* 恢复动作本身失败，直接判死 */
                    this.reportHlsFatal(data);
                    return;
                }
                this.updateLoading();
                return;
            }

            this.reportHlsFatal(data);
        },

        /** 把不可恢复的 hls 错误上报页面。 */
        reportHlsFatal(data) {
            this.showBuffer(false);
            this.errored = true;
            this.showError('播放失败', '片源暂时不可用');
            this.updateLoading();
            this.emit('error', { type: data && data.type, details: data && data.details });
        },
        },

        /**
         * 更新顶部栏标题。
         *
         * 只在**文字确实超出容器**时才滚动，短标题固定不动。
         *
         * 测量要点（这两点写错会导致短文字也被判为溢出、一起滚起来）：
         *   1. 必须量「文字的自然宽度」与「容器可用宽度」两个不同来源。
         *      若拿 .vp-title 的 scrollWidth 与它自己的 clientWidth 比，
         *      两者永远相等（inline-block 宽度由内容决定），判定必然失效。
         *   2. 必须等顶部栏**可见**后再量。全屏前它是 display:none，
         *      clientWidth 为 0，任何文字都会被算成溢出。
         */
        applyTitle(text) {
            const el = this.titleEl;
            const wrap = this.titleWrapEl;
            if (!el || !wrap) return;

            const next = String(text || '');
            if (this.titleText === next) return;
            this.titleText = next;

            el.textContent = next;
            /*
             * 同步写一份到 data-text。
             * 滚动的第二份文字由 ::after 的 content: attr(data-text) 生成，
             * 不写这个属性第二份就是空的，滚过去会露出一段空白。
             */
            el.setAttribute('data-text', next);
            this.resetTitleScroll();
            this.measureTitle();

            if (!next) return;
        },

        /** 复位滚动状态（去掉动画与位移，回到静止）。 */
        resetTitleScroll() {
            if (this.titleWrapEl) this.titleWrapEl.classList.remove('is-scrolling');
            if (this.titleEl) this.titleEl.style.removeProperty('--vp-title-shift');
        },

        /**
         * 测量标题是否需要滚动，并按需启用。
         *
         * 需要重复调用：全屏切换、横竖屏切换都会改变可用宽度，
         * 同一个标题在竖屏够宽、横屏可能就不够了（反之亦然）。
         */
        measureTitle() {
            const el = this.titleEl;
            const wrap = this.titleWrapEl;
            if (!el || !wrap || !el.textContent) return;

            /*
             * 顶部栏不可见时量不到有效宽度（clientWidth 为 0），
             * 此时直接跳过 —— 等它显示后由 enterFullscreen 再量一次。
             */
            const avail = wrap.clientWidth;
            if (avail <= 0) return;

            /*
             * 文字自然宽度：临时让它脱离容器约束来量。
             * 用 white-space:nowrap + position:absolute 的测量技巧
             * 成本较高，这里改用 scrollWidth —— 但前提是 .vp-title
             * 不设 width，其 scrollWidth 即内容宽度（见样式注释）。
             */
            const natural = el.scrollWidth;
            // 留 8px 容差，避免「刚好贴着边缘」也被判成溢出
            if (natural <= avail + 8) {
                this.resetTitleScroll();
                return;
            }

            /*
             * 位移 = 文字宽度 + 间距。
             * 要完整滚过一遍才能接上第二份，只滚「溢出的那部分」
             * 会在中途露出空白。
             */
            el.style.setProperty('--vp-title-shift', `${natural + 40}px`);
            wrap.classList.add('is-scrolling');
        },

        /**
         * 网速刷新定时器。
         *
         * 每 500ms 按滑动窗口重算一次速率并刷新信息行。
         * 速率不在 addBytes 里算：分片成块到达，逐次算会脉冲式跳动；
         * 定时重算能让数字平稳，且无流量时窗口自然清空、速率归 0。
         */
        startSpeedTicker() {
            this.stopSpeedTicker();
            this.speedTimer = setInterval(() => {
                this.showSpeed(Date.now());
                /*
                 * 卡顿期间 timeupdate 停摆，浮层里的「网络较慢」提示与
                 * 进度环全靠这个定时器推进 —— 不刷新的话卡住之后
                 * 浮层文字会永远停在最初那一帧。
                 */
                if (this.stallReported || this.switching) this.updateLoading();
                else this.updateStat();
            }, 500);
        },

        stopSpeedTicker() {
            if (this.speedTimer) {
                clearInterval(this.speedTimer);
                this.speedTimer = null;
            }
        },

        /**
         * 屏幕常亮。
         *
         * 播放中不熄屏是播放器的基本要求 —— 用户看完一集 40 分钟，
         * 中途屏幕黑掉会被当成「App 卡死了」。
         *
         * 仅 App 端有该能力（plus.device.setWakelock），H5 端无对应 API，
         * 交由浏览器/系统自己的策略处理。
         */
        setKeepAwake(on) {
            if (!this.isApp()) return;
            const want = !!on;
            // 状态未变就不重复调用，避免频繁走原生桥
            if (this.keepAwake === want) return;
            try {
                window.plus.device.setWakelock(want);
                this.keepAwake = want;
            } catch (e) {
                /* 个别机型不支持，静默降级 */
            }
        },

        /** 取 hls 的缓冲水位（0~100），用于进度环。 */
        syncHlsBufferPct(hls) {
            try {
                const buf = hls.mainForwardBufferInfo ? hls.mainForwardBufferInfo() : null;
                const el = this.videoEl;
                if (buf && el && el.duration > 0) {
                    // 已缓冲到的时间点 / 总时长
                    const reached = el.currentTime + buf.len;
                    this.hlsBufferPct = Math.min((reached / el.duration) * 100, 100);
                }
            } catch {
                this.hlsBufferPct = null;
            }
        },

        /**
         * 离线播放：用本地 m3u8 与本地分片。
         *
         * 关键点：
         *   1. m3u8 正文从 storage 读（下载时保存过）
         *   2. 分片请求由自定义 loader 拦截，按 URL 哈希查本地文件
         *   3. 未命中本地文件时才回落网络（避免个别分片缺失直接黑屏）
         */
        playOffline(el) {
            const info = this.offlineInfo || {};
            const dir = info.dir || '';
            const manifest = info.manifest || '';

            this.loadHlsLib()
                .then(Hls => {
                    if (!Hls || !Hls.isSupported()) {
                        // 不支持 hls.js 时无法喂本地分片，退回在线地址
                        el.src = this.offlineSrc();
                        return;
                    }

                    // 自定义 loader：命中本地文件则读本地，否则交回默认实现
                    const LocalLoader = this.makeLocalLoader(Hls, dir);

                    /*
                     * 复用同一套缓冲配置：本地读文件虽快，但分片要经
                     * plus.io 转 base64 再解码，比想象中慢（尤其大分片）。
                     * 缓冲目标给足能避免「本地播放反而卡」的怪象。
                     *
                     * 注意**不传计量 loader**：离线读的是本地文件，
                     * 没有网络流量，统计出来的「网速」是无意义的假象。
                     */
                    const hls = new Hls(
                        Object.assign(this.hlsConfig(), {
                            loader: LocalLoader,
                            pLoader: LocalLoader,
                            fLoader: LocalLoader
                        })
                    );
                    this.hls = hls;
                    hls.loadSource(this.makeLocalManifestUrl(manifest));
                    hls.attachMedia(el);
                    this.bindHlsEvents(Hls, hls);
                })
                .catch(() => {
                    /* 离线播放失败时保持黑屏，由父页面决定后续动作 */
                    this.updateLoading();
                });
        },

        /**
         * 构造本地索引的“虚拟 URL”。
         *
         * 不指向任何真实资源，只作为 hls 的占位；
         * 真正内容由 loader 的 load() 从本地读出。
         */
        makeLocalManifestUrl(manifest) {
            // 以本地目录为 base，便于相对地址解析
            return `${(this.offlineInfo && this.offlineInfo.base) || 'local://cache'}/index.m3u8`;
        },

        /**
         * 生成本地分片 loader。
         *
         * hls.js 的 loader 约定：实例需具备 load(context, config, callbacks)、
         * abort()、destroy()，并在成功时回调 onSuccess({ url, data })、
         * 进度时回调 onProgress({ loaded, total })。
         */
        makeLocalLoader(Hls, dir) {
            const self = this;
            const BaseLoader = (Hls.DefaultConfig && Hls.DefaultConfig.loader) || null;

            return class LocalLoader extends (BaseLoader || Object) {
                constructor(config) {
                    /*
                     * 必须继承 hls 的默认 loader，不能退化成 Object：
                     * 默认 loader 的构造里会初始化 xhr / 事件绑定，
                     * 省掉它能省一点内存，但会让「本地缺失时回落网络」失效。
                     */
                    if (BaseLoader) {
                        super(config);
                    }
                    this.stats = { aborted: false, loaded: 0, retry: 0, total: 0 };
                    this.context = null;
                    this.callbacks = null;
                    /** 本次 load 的序号，用于丢弃过期回调 */
                    this._seq = 0;
                    this._base = null;
                }

                load(context, config, callbacks) {
                    const url = context && context.url ? context.url : '';
                    this.context = context;
                    this.callbacks = callbacks;
                    // 每次 load 都要复位：同一实例会被复用来取多个分片
                    this.stats.aborted = false;

                    // 索引：直接用内存里的正文
                    if (/\.m3u8(\?|$)/i.test(url)) {
                        const text = self.offlineManifest ? self.offlineManifest() : '';
                        if (text) {
                            const data = encodeText(text);
                            this.stats.loaded = data.length;
                            this.stats.total = data.length;
                            callbacks.onProgress?.(this.stats, context, data);
                            callbacks.onSuccess?.({ url, data: data.buffer }, this.stats, context, data);
                            return;
                        }
                    }

                    // 分片：按 URL 哈希查本地文件
                    const name = self.localFileNameOf(url);
                    if (dir && name) {
                        const path = `${dir}${name}`;
                        /*
                         * 读文件是异步的：若期间发生 abort 或又发起了新的 load，
                         * 旧回调不能再触发 onSuccess，否则 hls 会收到过期数据。
                         */
                        const seq = ++this._seq;
                        self.readLocalFile(path).then(buf => {
                            if (this.stats.aborted || seq !== this._seq) return;
                            if (buf) {
                                this.stats.loaded = buf.byteLength;
                                this.stats.total = buf.byteLength;
                                callbacks.onProgress?.(this.stats, context, buf);
                                callbacks.onSuccess?.({ url, data: buf }, this.stats, context, buf);
                            } else {
                                // 本地缺失：回落网络，避免个别分片缺失直接黑屏
                                this.fallback(context, config, callbacks);
                            }
                        });
                        return;
                    }

                    this.fallback(context, config, callbacks);
                }

                /** 本地文件缺失时交回默认 loader。 */
                fallback(context, config, callbacks) {
                    if (BaseLoader) {
                        const base = new BaseLoader(config);
                        base.load(context, config, callbacks);
                        this._base = base;
                    } else {
                        callbacks.onError?.(
                            { code: 404, text: '本地文件缺失' },
                            context,
                            null,
                            null
                        );
                    }
                }

                abort() {
                    this.stats.aborted = true;
                    if (this._base) this._base.abort();
                }

                destroy() {
                    if (this._base) this._base.destroy();
                }
            };
        },

        /**
         * 由分片 URL 推出本地文件名。
         *
         * 规则必须与下载时（services/download.ts 的 localFileNameOf）**完全一致**，
         * 否则哈希对不上、离线时找不到文件。
         */
        localFileNameOf(url) {
            if (!url) return '';
            const isMp4 = /\.mp4(\?|$)/i.test(url) || /\.m4s(\?|$)/i.test(url);
            return `${hashUrl(url)}${isMp4 ? '.mp4' : '.ts'}`;
        },

        /**
         * 读取本地文件为 ArrayBuffer。
         *
         * renderjs 无法 import 模块，但可以**直接用 plus.io**（同处一个 WebView），
         * 因此这里重写一遍读取逻辑，而不是靠父组件传函数进来
         * （跨实例传函数会丢，renderjs 通信只保证可序列化数据）。
         */
        readLocalFile(path) {
            return new Promise(resolve => {
                if (!window.plus || !window.plus.io) {
                    resolve(null);
                    return;
                }
                try {
                    window.plus.io.resolveLocalFileSystemURL(
                        path,
                        entry => {
                            entry.file(
                                file => {
                                    try {
                                        const reader = new window.plus.io.FileReader();
                                        reader.onload = e => {
                                            const url = String(
                                                (e && e.target && e.target.result) || reader.result || ''
                                            );
                                            resolve(dataUrlToBuffer(url));
                                        };
                                        reader.onerror = () => resolve(null);
                                        reader.readAsDataURL(file);
                                    } catch (err) {
                                        resolve(null);
                                    }
                                },
                                () => resolve(null)
                            );
                        },
                        () => resolve(null)
                    );
                } catch (err) {
                    resolve(null);
                }
            });
        },

        /** 绑定原生事件并回传逻辑层。 */
        bindVideoEvents(el) {
            el.addEventListener('play', () => {
                this.updateCenter(true);
                this.emit('play');
                this.scheduleHide();
                // 重新开播即视为已出过画，后续卡顿改走轻量提示
                this.firstReady = true;
                this.errored = false;
                this.setKeepAwake(true);
            });

            el.addEventListener('pause', () => {
                this.updateCenter(false);
                this.emit('pause');
                this.showLayer();
                // 暂停时不显示缓冲转圈：此时没有「正在等数据」这回事
                this.showBuffer(false);
                this.updateLoading();
                this.setKeepAwake(false);
            });

            el.addEventListener('waiting', () => {
                /*
                 * waiting 可能被浏览器高频重复触发（每次缓冲不足都来一次），
                 * 因此只在「本次卡顿的第一次」上报逻辑层与记录起点，
                 * 否则页面侧会收到一串重复的 waiting。
                 */
                if (!this.stallReported) {
                    this.stallReported = true;
                    this.stallSince = Date.now();
                    this.emit('waiting');
                }
                this.updateLoading();
            });

            el.addEventListener('playing', () => {
                // 出画了：清掉卡顿标记，揭开换集遮罩
                this.stallReported = false;
                this.stallSince = 0;
                this.firstReady = true;
                this.hideSwitch();
                this.updateLoading();
                this.emit('playing');
            });

            el.addEventListener('canplay', () => {
                this.updateLoading();
                this.emit('canplay');
            });

            el.addEventListener('stalled', () => this.updateLoading());
            el.addEventListener('suspend', () => this.updateLoading());
            el.addEventListener('emptied', () => this.updateLoading());

            /*
             * 原生播放路径的网速兜底。
             *
             * iOS 的 WKWebView 原生支持 HLS，会走 `el.src = src` 直连播放，
             * 完全不经过 hls.js 的 loader —— 计量 loader 在这条路径上拿不到
             * 任何数据，网速会恒为 0。mp4 直连同理。
             *
             * 这里用 `progress` 事件 + 已缓冲时长增量估算：
             *   progress 在浏览器预取数据时触发，可通过 buffered 区间
             *   算出新增的秒数，再乘码率得到近似字节数。
             * 精度不如 loader 层（码率是估算值），但足以让用户看到
             * 「网速在动」，而不是死板的 0。
             *
             * 只在没有 hls.js 实例时才生效，避免两条路径重复计数。
             */
            el.addEventListener('progress', () => {
                this.meterNative(el);
                this.syncBuffer();
                this.updateLoading();
            });

            el.addEventListener('ended', () => {
                this.updateCenter(false);
                this.showBuffer(false);
                this.emit('ended');
                this.showLayer();
            });

            el.addEventListener('loadedmetadata', () => {
                this.syncTime();
                /*
                 * 续播定位放在这里而不是 loadSource：
                 * renderjs 的属性同步顺序是 vsrc → vprops → voffline，
                 * loadSource 触发时 props 可能还是上一集的旧值，
                 * 而 loadedmetadata 必然晚于两者，读到的是本次的值。
                 */
                const start = (this.props && this.props.initialTime) || 0;
                if (start > 1 && Math.abs((el.currentTime || 0) - start) > 1) {
                    this.applySeek(start);
                }
                /*
                 * 错误自愈后的续位优先于续播点：重载是为了「接着刚才看」，
                 * 若被 initialTime 覆盖会跳回本集开头，用户会以为进度丢了。
                 */
                if (this.pendingSeek > 1) {
                    const pos = this.pendingSeek;
                    this.pendingSeek = 0;
                    this.applySeek(pos);
                }
                this.updateLoading();
            });

            el.addEventListener('timeupdate', () => {
                this.syncTime();
                // 常驻信息行随之刷新（timeupdate 约每秒 4 次，频率足够）
                this.updateStat();
                /*
                 * 卡顿期间 timeupdate 会停摆，此时由定时器负责刷新浮层 ——
                 * 这里补一次 updateLoading 是为了「卡顿刚开始的那一瞬」
                 * 就能把转圈显示出来，不必等下一个 500ms 周期。
                 */
                if (this.stallReported) this.updateLoading();
                this.emit('timeupdate', {
                    currentTime: el.currentTime || 0,
                    duration: el.duration || 0
                });
            });

            el.addEventListener('error', () => this.onMediaError(el));

            // 浏览器自动播放策略：非静音自动播放会被拦截，降级为静音起播
            el.addEventListener('loadeddata', () => {
                if (!this.props || !this.props.autoplay) {
                    /*
                     * 不自动播：源已就绪，等用户点播放。
                     *
                     * 必须把 firstReady 置真，否则「铺满的加载浮层」
                     * 会一直盖着中央播放按钮，用户看不到该点哪里，
                     * 只能盯着「正在加载」发呆。
                     */
                    this.firstReady = true;
                    this.updateCenter(false);
                    this.updateLoading();
                    return;
                }
                const wantMuted = !!this.props.muted;
                el.muted = true;
                const p = el.play();
                if (p && p.then) {
                    p.then(() => {
                        el.muted = wantMuted;
                    }).catch(() => {
                        /*
                         * 仍需用户手势：同样视为「就绪但待播」，
                         * 收起加载浮层，露出播放按钮让用户自己点。
                         */
                        this.firstReady = true;
                        this.updateCenter(false);
                        this.updateLoading();
                    });
                }
            });
        },

        /**
         * 原生 <video> 的错误处理。
         *
         * 关键点：**不要一报错就把画面交给错误页**。
         *
         * 采集源的片源质量参差，`MEDIA_ERR_NETWORK`（网络中断）与
         * `MEDIA_ERR_DECODE`（个别分片损坏）都是**偶发且可自愈**的：
         * 前者重载即可续上，后者 hls.js 会自动跳过坏片。
         * 直接弹「播放失败」会把一次抖动画成一次终局。
         *
         * 因此这里分级：
         *   1. 网络类错误 → 重载源，最多 FATAL_RETRY 次
         *   2. 超过次数 → 通知逻辑层换线路（父页面的 onPlayError 会处理）
         *   3. 逻辑层也换不到线路时，父页面重新解析或展示错误页
         */
        onMediaError(el) {
            if (this.errored) return;

            const code = el && el.error ? el.error.code : 0;
            /*
             * 1 = MEDIA_ERR_ABORTED（用户/脚本主动中止，常见于换源），
             * 不算错误，静默忽略 —— 否则每次切集都会多报一次 error。
             */
            if (code === 1) return;

            this.showBuffer(false);

            /*
             * 本地缓存播放失败时不重试网络：离线路径的失败原因
             * 通常是「该集尚未缓存完成」，重试只会反复失败。
             */
            const retryable =
                !this.offlineInfo && code !== 4 && this.fatalRetries < 2;

            if (retryable) {
                this.fatalRetries += 1;
                this.emit('error', { code, retrying: true });
                this.reloadSource();
                return;
            }

            this.errored = true;
            this.showError('播放失败', code === 4 ? '该视频格式不受支持' : '片源暂时不可用');
            this.emit('error', { code });
        },

        /**
         * 重载当前播放源（不换地址）。
         *
         * 用于网络抖动后的自愈：hls 实例销毁重建，播放位置保持不变 ——
         * 直接 `el.load()` 在 hls.js 接管 MediaSource 的场景下无效
         * （src 是 blob:，重新 load 只会重新拉一次 blob）。
         */
        reloadSource() {
            const src = this.currentSrc || this.offlineSrc() || '';
            const el = this.videoEl;
            if (!el) return;

            /*
             * 记住当前位置，重载后回到原处，用户几乎无感。
             *
             * 走 pendingSeek 而不是重载完立刻 seek：新源刚装载时
             * duration 还是 NaN，直接写 currentTime 会被浏览器丢弃。
             * 由 loadedmetadata 消费这个值才能保证生效。
             */
            this.pendingSeek = el.currentTime || 0;
            // 标记为自愈重载：loadSource 据此保留重试计数，上限才能生效
            this.reloading = true;
            this.loadSource(src);
        },

        /** 展示不可恢复的错误浮层。 */
        showError(text, sub) {
            if (this.errTextEl) this.errTextEl.textContent = text || '播放失败';
            if (this.errSubEl) this.errSubEl.textContent = sub || '';
            if (this.errEl) this.errEl.classList.add('is-on');
            this.showLayer();
        },

        /** 收起错误浮层。 */
        hideError() {
            this.errored = false;
            this.fatalRetries = 0;
            if (this.errEl) this.errEl.classList.remove('is-on');
        },

        /* ---------------- 控件 ---------------- */

        buildControls(mount) {
            const layer = document.createElement('div');
            layer.className = 'vp-layer';
            this.layerEl = layer;

            layer.innerHTML =
                '<div class="vp-scrim-top"></div>' +
                '<div class="vp-scrim-bottom"></div>' +
                /*
                 * 顶部栏：返回键 + 剧名。
                 *
                 * 与底部控制条同处 vp-layer，因此显隐完全同步 ——
                 * 点画面唤出、自动延时收起，行为与进度条一致（用户要求）。
                 * 返回键只退出全屏，不离开页面（离开由页面自己的返回键负责）。
                 */
                '<div class="vp-top">' +
                '<div class="vp-back" title="退出全屏"><div class="vp-i-back"></div></div>' +
                '<div class="vp-title-wrap"><span class="vp-title"></span></div>' +
                '</div>' +
                '<div class="vp-center"><div class="vp-i-play"></div></div>' +
                '<div class="vp-bottom">' +
                '<div class="vp-progress"><div class="vp-track">' +
                '<div class="vp-buffer"></div><div class="vp-fill"></div><div class="vp-thumb"></div>' +
                '</div></div>' +
                /* 时间 + 网速 + 加载进度 同一行，避免多占一行高度 */
                '<div class="vp-row">' +
                '<div class="vp-left">' +
                '<span class="vp-time">00:00 / 00:00</span>' +
                '<span class="vp-stat">' +
                '<span class="vp-stat-net">0 KB/s</span>' +
                '<span class="vp-stat-sep">·</span>' +
                '<span class="vp-stat-buf">加载 0%</span>' +
                '</span>' +
                '</div>' +
                '<div class="vp-acts">' +
                '<div class="vp-ep" title="选集"></div>' +
                '<div class="vp-dir is-landscape" title="切换横竖屏"></div>' +
                '<div class="vp-rate">1x</div>' +
                '<div class="vp-fs" title="全屏"></div>' +
                '</div></div></div>';

            mount.appendChild(layer);

            this.centerEl = layer.querySelector('.vp-center');
            this.progressEl = layer.querySelector('.vp-progress');
            this.fillEl = layer.querySelector('.vp-fill');
            this.bufferEl = layer.querySelector('.vp-buffer');
            this.thumbEl = layer.querySelector('.vp-thumb');
            this.timeEl = layer.querySelector('.vp-time');
            this.rateEl = layer.querySelector('.vp-rate');
            this.fsEl = layer.querySelector('.vp-fs');
            this.dirEl = layer.querySelector('.vp-dir');
            this.epEl = layer.querySelector('.vp-ep');
            this.statEl = layer.querySelector('.vp-stat');
            this.statNetEl = layer.querySelector('.vp-stat-net');
            this.statBufEl = layer.querySelector('.vp-stat-buf');
            this.topEl = layer.querySelector('.vp-top');
            this.backEl = layer.querySelector('.vp-back');
            this.titleEl = layer.querySelector('.vp-title');
            this.titleWrapEl = layer.querySelector('.vp-title-wrap');

            // 手势 HUD 独立挂在容器上，控件隐藏时也能显示
            const hud = document.createElement('div');
            hud.className = 'vp-hud is-left';
            hud.innerHTML =
                '<div class="vp-hud-label">亮度</div>' +
                '<div class="vp-hud-bar"><div class="vp-hud-fill"></div></div>' +
                '<div class="vp-hud-val">100%</div>';
            mount.appendChild(hud);

            this.hudEl = hud;
            this.hudFillEl = hud.querySelector('.vp-hud-fill');
            this.hudValEl = hud.querySelector('.vp-hud-val');
            this.hudLabelEl = hud.querySelector('.vp-hud-label');

            // 切换遮罩：层级高于控件层与 HUD，盖住整个画面
            const switcher = document.createElement('div');
            switcher.className = 'vp-switch';
            switcher.innerHTML = '<div class="vp-switch-text"></div>';
            mount.appendChild(switcher);

            this.switchEl = switcher;
            this.switchTextEl = switcher.querySelector('.vp-switch-text');

            /*
             * 倍速面板。
             *
             * 挂在容器而非控件层里：面板需要在控制条隐藏时也可交互，
             * 且不应随控件层的透明度一起淡出。
             */
            const ratePanel = document.createElement('div');
            ratePanel.className = 'vp-rates';
            ratePanel.innerHTML =
                '<div class="vp-rates-title">播放速度</div>' +
                '<div class="vp-rates-list"></div>';
            mount.appendChild(ratePanel);
            this.ratePanelEl = ratePanel;
            this.rateListEl = ratePanel.querySelector('.vp-rates-list');
            this.buildRateList();

            /*
             * 选集面板。
             *
             * 与倍速面板同机制：挂在容器上、由渲染层自管显隐。
             * 全屏时它是右侧抽屉（占 1/3 宽、满高），竖屏时是底部抽屉。
             * 两种形态只差一个类，用 CSS 控制即可。
             */
            const epPanel = document.createElement('div');
            epPanel.className = 'vp-eps';
            epPanel.innerHTML =
                '<div class="vp-eps-head">' +
                '<span class="vp-eps-title">选集</span>' +
                '<span class="vp-eps-count"></span>' +
                '<span class="vp-eps-close">收起</span>' +
                '</div>' +
                '<div class="vp-eps-body"></div>';
            mount.appendChild(epPanel);
            this.epPanelEl = epPanel;
            this.epListEl = epPanel.querySelector('.vp-eps-body');
            this.epCountEl = epPanel.querySelector('.vp-eps-count');
            this.buildEpisodePanel();

            // 面板背景：点击空白处收起（与倍速面板不同，这里需要拦截点击）
            const epMask = document.createElement('div');
            epMask.className = 'vp-eps-mask';
            epMask.addEventListener('click', e => {
                e.stopPropagation();
                this.hideEpisodePanel();
            });
            mount.appendChild(epMask);
            this.epMaskEl = epMask;

            epPanel.querySelector('.vp-eps-close').addEventListener('click', e => {
                e.stopPropagation();
                this.hideEpisodePanel();
            });
            // 面板内部点击不触发容器上的显隐切换
            epPanel.addEventListener('click', e => e.stopPropagation());

            /*
             * 阻断触摸事件冒泡。
             *
             * 手势监听绑在 box 上（亮度/音量、右滑退全屏），而弹窗是它的
             * 子元素 —— 手指在弹窗里上下滑时事件会冒泡上去，
             * 被判定成「调亮度」并 preventDefault，弹窗的滚动被整个吃掉，
             * 表现为「选集面板滚不动」。
             *
             * 这里把 touchmove 拦在弹窗内：既不冒泡给手势层，
             * 也不阻止默认行为，让 .vp-eps-body 的 overflow-y 正常工作。
             */
            const stopTouch = e => e.stopPropagation();
            epPanel.addEventListener('touchstart', stopTouch, { passive: true });
            epPanel.addEventListener('touchmove', stopTouch, { passive: true });
            epPanel.addEventListener('touchend', stopTouch, { passive: true });
            // 遮罩同样阻断：点空白处应只收起面板，不顺手把亮度也调了
            epMask.addEventListener('touchstart', stopTouch, { passive: true });
            epMask.addEventListener('touchmove', stopTouch, { passive: true });
            epMask.addEventListener('touchend', stopTouch, { passive: true });

            // 加载浮层：缓冲进度 + 网速
            const load = document.createElement('div');
            load.className = 'vp-load';
            load.innerHTML =
                '<div class="vp-load-ring"></div>' +
                '<div class="vp-load-text">正在加载</div>' +
                '<div class="vp-load-sub"></div>';
            mount.appendChild(load);

            this.loadEl = load;
            this.loadRingEl = load.querySelector('.vp-load-ring');
            this.loadTextEl = load.querySelector('.vp-load-text');
            this.loadSubEl = load.querySelector('.vp-load-sub');

            /*
             * 播放中的轻量缓冲转圈。
             *
             * 与首次加载浮层分开：浮层会铺满并压暗画面，只适合「还没出画」；
             * 已经出画后卡顿若也铺一层，观感上等于整段黑屏。
             */
            const buf = document.createElement('div');
            buf.className = 'vp-buf';
            mount.appendChild(buf);
            this.bufEl = buf;

            /*
             * 双击快进/快退提示。
             *
             * 挂在容器上而不是控件层：双击时控制条可能正好是隐藏的，
             * 挂在控件层会一起淡出，用户看不到「跳了 10 秒」的反馈。
             */
            const seekHud = document.createElement('div');
            seekHud.className = 'vp-seek-hud';
            mount.appendChild(seekHud);
            this.seekHudEl = seekHud;

            // 长按加速提示，同理独立于控件层
            const holdHud = document.createElement('div');
            holdHud.className = 'vp-hold-hud';
            mount.appendChild(holdHud);
            this.holdHudEl = holdHud;

            /*
             * 致命错误浮层。
             *
             * 层级高于加载浮层：错误态下不该再看到「正在加载」的转圈，
             * 否则用户会一直等一个永远不会来的画面。
             */
            const err = document.createElement('div');
            err.className = 'vp-err';
            err.innerHTML =
                '<div class="vp-err-text">播放失败</div>' +
                '<div class="vp-err-sub"></div>' +
                '<div class="vp-err-retry">重新加载</div>';
            mount.appendChild(err);
            this.errEl = err;
            this.errTextEl = err.querySelector('.vp-err-text');
            this.errSubEl = err.querySelector('.vp-err-sub');
            // 重试按钮：原地重载源，不清空播放地址
            err.querySelector('.vp-err-retry').addEventListener('click', e => {
                e.stopPropagation();
                this.hideError();
                this.hlsRetries = 0;
                this.reloadSource();
            });
            // 浮层内部点击不要触发控件显隐切换
            err.addEventListener('click', e => e.stopPropagation());

            this.bindControls();
            this.scheduleHide();
        },

        /**
         * 构建倍速档位列表。
         *
         * 每个档位是一个普通 div，点击即切到该速度；
         * 选中的档位用 is-on 高亮，方便一眼看到当前值。
         */
        buildRateList() {
            if (!this.rateListEl) return;
            const cur = (this.videoEl && this.videoEl.playbackRate) || 1;

            this.rateListEl.innerHTML = '';
            this.rateItems = [];

            for (const r of RATES) {
                const item = document.createElement('div');
                item.className = 'vp-rates-item' + (Math.abs(r - cur) < 0.001 ? ' is-on' : '');
                item.textContent = rateLabel(r);
                item.addEventListener('click', e => {
                    e.stopPropagation();
                    this.applyRate(r);
                    this.hideRatePanel();
                });
                this.rateListEl.appendChild(item);
                this.rateItems.push({ rate: r, el: item });
            }
        },

        /** 切换倍速面板显隐。 */
        toggleRatePanel() {
            if (this.ratePanelOn) {
                this.hideRatePanel();
            } else {
                this.showRatePanel();
            }
        },

        showRatePanel() {
            // 每次打开都重建，保证高亮与当前实际速度一致
            this.buildRateList();
            this.ratePanelOn = true;
            if (this.ratePanelEl) this.ratePanelEl.classList.add('is-on');
            this.clearHideTimer();
        },

        hideRatePanel() {
            this.ratePanelOn = false;
            if (this.ratePanelEl) this.ratePanelEl.classList.remove('is-on');
            this.scheduleHide();
        },

        /**
         * 应用倍速（由面板点击或逻辑层指令调用）。
         *
         * @param rate   目标倍速
         * @param silent 为真时**不上报** ratechange。
         *
         *   长按加速用它：那只是「临时快进看一眼」的瞬时动作，
         *   并不是用户设定的播放速度。若照常上报，房间页会把
         *   3 倍速广播给所有观众 —— 一个人的长按把整屋人的速度改了，
         *   而且松手后的还原又广播一次，观众端会来回抖动。
         */
        applyRate(rate, silent) {
            const el = this.videoEl;
            if (!el || !(rate > 0)) return;

            el.playbackRate = rate;
            if (this.rateEl) this.rateEl.textContent = rateLabel(rate);
            // 更新面板高亮（面板可能正开着）
            if (this.rateItems) {
                for (const it of this.rateItems) {
                    it.el.classList.toggle('is-on', Math.abs(it.rate - rate) < 0.001);
                }
            }
            if (silent) return;
            this.emit('ratechange', rate);
        },

        /* ---------------- 选集面板 ---------------- */

        /**
         * 构建剧集按钮列表。
         *
         * 用普通 div 网格而非 flex 自适应：集数可能上百，
         * 固定列宽能保证每格大小一致、长集名可截断，
         * 比 flex 换行更整齐（flex 会让长短名混排出参差感）。
         */
        buildEpisodePanel() {
            if (!this.epListEl) return;

            const list = this.episodeList || [];
            const cur = Number(this.episodeIndex) || 0;
            if (this.epCountEl) this.epCountEl.textContent = list.length ? `${list.length} 集` : '';

            this.epListEl.innerHTML = '';
            this.epItems = [];

            if (!list.length) {
                const empty = document.createElement('div');
                empty.className = 'vp-eps-empty';
                empty.textContent = '暂无可选集';
                this.epListEl.appendChild(empty);
                return;
            }

            list.forEach((item, i) => {
                const cell = document.createElement('div');
                cell.className = 'vp-eps-item' + (i === cur ? ' is-on' : '');
                // 优先显示集名；名称为空时退回序号
                cell.textContent = item.name || String(i + 1);
                cell.addEventListener('click', e => {
                    e.stopPropagation();
                    if (i === this.episodeIndex) {
                        this.hideEpisodePanel();
                        return;
                    }
                    // 先收起再切集：切集要重新拉流，面板留着会盖住加载态
                    this.hideEpisodePanel();
                    this.emit('episodechange', i);
                });
                this.epListEl.appendChild(cell);
                this.epItems.push(cell);
            });

            // 打开时把当前集滚进视野，避免用户在大列表里找不到「正在播哪集」
            this.$nextTick(() => this.scrollToCurrentEpisode());
        },

        /** 让当前集在面板里居中可见。 */
        scrollToCurrentEpisode() {
            const cell = this.epItems && this.epItems[this.episodeIndex];
            if (!cell || !this.epListEl) return;
            const body = this.epListEl;
            // 面板尚未布局完成时高度为 0，等下一帧再试一次
            if (!body.clientHeight) {
                setTimeout(() => this.scrollToCurrentEpisode(), 30);
                return;
            }
            const target = cell.offsetTop - body.clientHeight / 2 + cell.clientHeight / 2;
            body.scrollTop = Math.max(0, target);
        },

        /** 切换选集面板显隐。 */
        toggleEpisodePanel() {
            if (this.epPanelOn) {
                this.hideEpisodePanel();
            } else {
                this.showEpisodePanel();
            }
        },

        showEpisodePanel() {
            // 每次打开都重建：集数、当前集可能在播放过程中变过
            this.buildEpisodePanel();
            this.epPanelOn = true;
            if (this.epPanelEl) this.epPanelEl.classList.add('is-on');
            if (this.epMaskEl) this.epMaskEl.classList.add('is-on');
            // 面板占位期间不要让控制条自动收起，否则看起来像「闪一下」
            this.clearHideTimer();
            // 面板与倍速面板互斥，避免两层浮层叠在一起
            this.hideRatePanel();
            /*
             * 上报给逻辑层。
             *
             * 面板状态住在渲染层，但逻辑层的 onBackPress 必须**同步**
             * 判断「面板是否开着」来决定要不要吃掉这次返回 ——
             * 而逻辑层无法同步调用渲染层方法取返回值，
             * 只能由渲染层主动上报、逻辑层存一份镜像。
             */
            this.emit('episodepanel', true);
        },

        hideEpisodePanel() {
            this.epPanelOn = false;
            if (this.epPanelEl) this.epPanelEl.classList.remove('is-on');
            if (this.epMaskEl) this.epMaskEl.classList.remove('is-on');
            this.scheduleHide();
            this.emit('episodepanel', false);
        },

        bindControls() {
            const el = this.videoEl;

            // 中央播放/暂停
            this.centerEl.addEventListener('click', e => {
                e.stopPropagation();
                if (el.paused) el.play();
                else el.pause();
            });

            /**
             * 点击画面切换控件显隐；双击快进/快退；长按加速。
             *
             * 关键：必须绑在 **video 元素本身**上。
             * 若只绑 layer，控件隐藏后 layer 的 pointer-events 为 none，
             * 点击会直接穿透到 video，永远无法唤出控制条。
             *
             * 显隐规则：控件已显示 → 立即隐藏；已隐藏 → 唤出并延时自隐。
             * 同时过滤拖拽与手势结束后浏览器补发的 click。
             */
            /*
             * 长按定时器用**实例字段**而非局部变量：
             * destroy() 里必须能清掉它，否则页面退出后定时器仍会
             * 在 520ms 后触发一次 applyRate，操作已销毁的 video 元素。
             */
            const clearHold = () => {
                if (this.holdTimer) {
                    clearTimeout(this.holdTimer);
                    this.holdTimer = null;
                }
            };

            /** 结束长按加速并还原原速。 */
            const endHold = () => {
                if (!this.holding) return;
                this.holding = false;
                this.applyRate(this.rateBeforeHold || 1, true);
                if (this.holdHudEl) this.holdHudEl.classList.remove('is-on');
                // 长按松手后浏览器会补发 click，屏蔽掉以免误切控件显隐
                this.suppressClick = true;
                setTimeout(() => {
                    this.suppressClick = false;
                }, 320);
            };

            /*
             * 把「取消长按」挂到实例上，供手势层复用。
             *
             * 手势层（bindGesture）在开始调亮度/音量前必须先取消长按，
             * 否则会出现「一边 3 倍速一边改亮度」的双手势并发。
             * 闭包变量跨方法取不到，故通过实例暴露一个入口。
             */
            this.cancelHold = () => {
                clearHold();
                endHold();
            };

            el.addEventListener(
                'touchstart',
                e => {
                    const t = e.touches && e.touches[0];
                    // 多指（缩放等）不参与长按判定
                    if (!t || (e.touches && e.touches.length > 1)) return;
                    this.holdStartX = t.clientX;
                    this.holdStartY = t.clientY;
                    clearHold();
                    this.holdTimer = setTimeout(() => {
                        this.holdTimer = null;
                        /*
                         * 暂停态或正在拖进度条时不加速：
                         * 前者没有「加速看下去」的语义，后者手指本来就在移动。
                         */
                        const v = this.videoEl;
                        if (this.dragging || !v || v.paused || this.errored) return;
                        this.holding = true;
                        this.rateBeforeHold = v.playbackRate || 1;
                        this.applyRate(HOLD_RATE, true);
                        if (this.holdHudEl) this.holdHudEl.classList.add('is-on');
                    }, HOLD_DELAY);
                },
                { passive: true }
            );

            el.addEventListener(
                'touchmove',
                e => {
                    const t = e.touches && e.touches[0];
                    if (!t || this.holding) return;
                    // 位移超过阈值说明是滑动手势（亮度/音量），放弃长按判定
                    if (
                        Math.abs(t.clientX - this.holdStartX) > 10 ||
                        Math.abs(t.clientY - this.holdStartY) > 10
                    ) {
                        clearHold();
                    }
                },
                { passive: true }
            );

            el.addEventListener('touchend', () => {
                clearHold();
                endHold();
            });
            el.addEventListener('touchcancel', () => {
                clearHold();
                endHold();
            });

            /*
             * 双击快进/快退。
             *
             * 用「上次点击时刻 + 落点半区」判定，**不引入等待定时器**：
             * 延迟 300ms 才能区分单双击，会让「点一下收控制条」——
             * 这个最高频的操作 —— 感觉明显迟钝。
             *
             * 代价是双击的第一次点击也会先切一次控件显隐（轻微闪动），
             * 这是各家播放器的通行取舍，换取单击的即时响应。
             *
             * 限定同一半区：避免「左边点一下、右边点一下」被误判成双击。
             */
            el.addEventListener('click', e => {
                if (this.suppressClick || this.justDragged) return;

                const rect = this.boxEl ? this.boxEl.getBoundingClientRect() : null;
                const x = rect && rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
                const now = Date.now();

                const isDouble =
                    now - this.lastTapAt < DOUBLE_TAP_MS && Math.abs(x - this.lastTapX) < 0.3;

                if (isDouble) {
                    // 清零，避免三连击被拆成两次双击
                    this.lastTapAt = 0;
                    const v = this.videoEl;
                    if (!v || !(v.duration > 0)) return;

                    const forward = x >= 0.5;
                    const target = Math.min(
                        Math.max(
                            (v.currentTime || 0) + (forward ? DOUBLE_TAP_SEEK : -DOUBLE_TAP_SEEK),
                            0
                        ),
                        v.duration
                    );
                    try {
                        v.currentTime = target;
                    } catch (err) {
                        /* 元数据未就绪，忽略 */
                    }
                    this.syncTime();
                    this.showSeekHud(
                        forward ? `快进 ${DOUBLE_TAP_SEEK} 秒` : `快退 ${DOUBLE_TAP_SEEK} 秒`
                    );
                    return;
                }

                this.lastTapAt = now;
                this.lastTapX = x;
                this.toggleLayer();
            });

            // 兜底：容器上也监听一次，覆盖 video 之外的边缘区域
            this.layerEl.addEventListener('click', () => this.toggleLayer());

            // 底部控制条内部点击不触发显隐切换
            const bottom = this.layerEl.querySelector('.vp-bottom');
            if (bottom) bottom.addEventListener('click', e => e.stopPropagation());

            /*
             * 倍速：点击展开面板，而非点一下循环一档。
             *
             * 循环式在只有 5 档时勉强能用，档位一多就要点七八次才能到目标，
             * 且看不到有哪些档位 —— 展开式一目了然。
             */
            this.rateEl.addEventListener('click', e => {
                e.stopPropagation();
                this.toggleRatePanel();
            });

            // 全屏切换（App 端真全屏 + 方向锁定）
            this.fsEl.addEventListener('click', e => {
                e.stopPropagation();
                this.toggleFullscreen();
                this.scheduleHide();
            });

            // 全屏内切换横竖屏（仅全屏时可见）
            if (this.dirEl) {
                this.dirEl.addEventListener('click', e => {
                    e.stopPropagation();
                    this.toggleOrientation();
                    this.scheduleHide();
                });
            }

            /*
             * 顶部栏返回键（仅全屏时可见）。
             *
             * 只退出全屏，**不离开页面** —— 这是播放器内部的全屏态，
             * 用户按返回的本意几乎总是「退出全屏看下面的信息」。
             * 真正离开页面由页面自己的返回键 / onBackPress 负责。
             */
            if (this.backEl) {
                this.backEl.addEventListener('click', e => {
                    e.stopPropagation();
                    this.exitFullscreen();
                });
            }

            /*
             * 选集入口（仅全屏时可见）。
             *
             * 直接开渲染层内建面板，不再 emit 回逻辑层让页面弹抽屉 ——
             * 全屏播放器是 fixed + z-index 9999，页面级浮层在 App WebView
             * 里会被裁切，表现为「点了没反应」。
             */
            if (this.epEl) {
                this.epEl.addEventListener('click', e => {
                    e.stopPropagation();
                    this.toggleEpisodePanel();
                });
            }

            /**
             * 进度拖拽（触摸 + 鼠标双支持）。
             *
             * 要点：
             * 1. `touchmove` 必须用 `passive: false` 才能 preventDefault，
             *    否则移动端会把手势当成页面滚动，拖拽直接失效。
             * 2. 拖动过程中要**实时更新进度条外观**（fill/thumb/时间），
             *    否则用户看不到任何反馈，会以为拖拽无效。
             * 3. 拖动时记录 dragRatio，避免被 timeupdate 回写覆盖。
             */
            const seekAt = e => {
                if (!this.progressEl) return;
                const rect = this.progressEl.getBoundingClientRect();
                if (!rect.width) return;

                const point = e.touches && e.touches.length ? e.touches[0] : e;
                const ratio = Math.min(Math.max((point.clientX - rect.left) / rect.width, 0), 1);

                this.dragRatio = ratio;

                // 实时刷新外观
                const pct = ratio * 100;
                if (this.fillEl) this.fillEl.style.width = `${pct}%`;
                if (this.thumbEl) {
                    this.thumbEl.style.left = `${pct}%`;
                    this.thumbEl.style.transform = 'translateY(-50%) scale(1.25)';
                }
                if (this.timeEl) {
                    const dur = this.videoEl ? this.videoEl.duration || 0 : 0;
                    if (dur > 0) {
                        this.timeEl.textContent = `${this.fmt(ratio * dur)} / ${this.fmt(dur)}`;
                    }
                }
            };

            const onDown = e => {
                e.stopPropagation();
                // 拖动时阻止默认行为，避免与页面滚动/长按菜单冲突
                if (e.cancelable) e.preventDefault();
                this.dragging = true;
                this.showLayer();
                this.clearHideTimer();
                seekAt(e);
            };

            const onMove = e => {
                if (!this.dragging) return;
                if (e.cancelable) e.preventDefault();
                seekAt(e);
            };

            const onUp = e => {
                if (!this.dragging) return;
                this.dragging = false;

                // 松手才真正跳转，避免拖动过程中频繁 seek
                if (el && el.duration && this.dragRatio !== null) {
                    const target = this.dragRatio * el.duration;
                    try {
                        el.currentTime = target;
                    } catch (err) {
                        /* 元数据未就绪，忽略 */
                    }
                    this.emit('seeked', target);
                }
                this.dragRatio = null;

                if (this.thumbEl) {
                    this.thumbEl.style.transform = 'translateY(-50%) scale(.85)';
                }
                if (e && e.cancelable) e.preventDefault();

                // 标记刚拖完，过滤浏览器补发的 click
                this.justDragged = true;
                setTimeout(() => {
                    this.justDragged = false;
                }, 260);

                this.syncTime();
                this.scheduleHide();
            };

            // 触摸：move 必须 passive:false 才能 preventDefault
            this.progressEl.addEventListener('touchstart', onDown, { passive: false });
            this.progressEl.addEventListener('touchmove', onMove, { passive: false });
            this.progressEl.addEventListener('touchend', onUp);
            this.progressEl.addEventListener('touchcancel', onUp);

            // 点击轨道直接跳转
            this.progressEl.addEventListener('click', e => {
                e.stopPropagation();
                if (this.justDragged) return;
                if (!this.progressEl) return;
                const rect = this.progressEl.getBoundingClientRect();
                if (!rect.width) return;
                const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
                if (el && el.duration) {
                    try {
                        el.currentTime = ratio * el.duration;
                    } catch (err) {
                        /* 忽略 */
                    }
                    this.syncTime();
                }
                this.scheduleHide();
            });

            // 鼠标（H5 桌面端）
            this.progressEl.addEventListener('mousedown', onDown);
            this.docMoveHandler = onMove;
            this.docUpHandler = onUp;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        },

        /* ---------------- 手势：左亮度 / 右音量 ---------------- */

        /**
         * 竖直滑动手势。
         *
         * 判定规则：
         * 1. 单指按下先记录起点，**不立即激活**；
         * 2. 竖直位移超过阈值且大于水平位移时才激活，避免与水平拖进度条冲突；
         * 3. 左半屏调亮度、右半屏调音量，向上滑为增大；
         * 4. 全程 `passive: false` + preventDefault，防止手势被页面滚动抢走。
         */
        bindGesture() {
            const box = this.boxEl;
            if (!box) return;

            const onStart = e => {
                if (this.dragging) return;
                const touches = e.touches;
                if (!touches || touches.length !== 1) return;
                const t = touches[0];
                const w = box.clientWidth || window.innerWidth;
                this.gesture = {
                    startX: t.clientX,
                    startY: t.clientY,
                    side: t.clientX < w / 2 ? 'brightness' : 'volume',
                    base: 0,
                    active: false,
                    // 全屏时记录「退出全屏」手势的判定状态
                    swipeOut: false
                };
            };

            const onMove = e => {
                const g = this.gesture;
                if (!g) return;
                const t = e.touches && e.touches[0];
                if (!t) return;

                const dx = t.clientX - g.startX;
                const dy = t.clientY - g.startY;

                /*
                 * 全屏下的「右滑退出全屏」。
                 *
                 * 与竖屏滑动手势的区别：全屏时用户最想做的事就是退出，
                 * 而返回键在横屏下不好按（部分机型还会被系统手势占用），
                 * 右滑是各家播放器的通行做法。
                 *
                 * 判定条件（三者同时满足才算）：
                 *   1. 横向位移占主导，避免与亮度/音量手势打架
                 *   2. 方向是向右（dx > 0）
                 *   3. 位移超过阈值，避免轻触误退出
                 */
                if (this.landscapeOn && !g.active && !g.swipeOut) {
                    if (Math.abs(dx) > SWIPE_OUT_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
                        g.swipeOut = true;
                        if (e.cancelable) e.preventDefault();
                        // 只退出全屏（回到竖屏），不离开页面
                        this.exitFullscreen();
                        return;
                    }
                }

                if (!g.active) {
                    if (Math.abs(dy) < GESTURE_THRESHOLD) return;
                    if (Math.abs(dy) <= Math.abs(dx)) {
                        // 判定为水平手势，交还给进度条
                        this.gesture = null;
                        return;
                    }
                    /*
                     * 确认是竖直手势了，先取消可能已触发的长按加速 ——
                     * 用户按住不动先触发了 3 倍速，接着上滑想调亮度，
                     * 不取消就会出现「一边加速一边改亮度」的并发。
                     */
                    if (this.cancelHold) this.cancelHold();
                    g.active = true;
                    g.startY = t.clientY;
                    g.base = g.side === 'brightness' ? this.brightness : this.volume;
                    this.showHud(g.side);
                }

                if (e.cancelable) e.preventDefault();

                const span = (box.clientHeight || window.innerHeight) * GESTURE_SPAN_RATIO;
                const next = Math.min(Math.max(g.base - (t.clientY - g.startY) / span, 0), 1);
                if (g.side === 'brightness') this.setBrightness(next);
                else this.setVolume(next);
            };

            const onEnd = () => {
                const g = this.gesture;
                this.gesture = null;
                // 手势结束，若长按还在计时也一并取消
                if (this.cancelHold) this.cancelHold();
                // 退出全屏的手势不做后续处理（HUD、点击屏蔽都不需要）
                if (!g || g.swipeOut) {
                    if (g && g.swipeOut) {
                        // 仍要屏蔽手势后补发的 click，否则会误切控件显隐
                        this.suppressClick = true;
                        setTimeout(() => {
                            this.suppressClick = false;
                        }, 320);
                    }
                    return;
                }
                if (!g.active) return;
                this.hideHudSoon();
                // 手势期间暂停了自动隐藏，结束后恢复计时
                this.scheduleHide();
                // 手势结束后浏览器会补发 click，屏蔽掉以免误切控件显隐
                this.suppressClick = true;
                setTimeout(() => {
                    this.suppressClick = false;
                }, 320);
            };

            box.addEventListener('touchstart', onStart, { passive: true });
            box.addEventListener('touchmove', onMove, { passive: false });
            box.addEventListener('touchend', onEnd);
            box.addEventListener('touchcancel', onEnd);
        },

        /**
         * 初始化亮度基准。
         *
         * App 端读取系统（应用）亮度作为起点，这样 HUD 显示的百分比与
         * 用户对手机亮度的直觉一致；H5 端无此能力，固定按 100% 处理。
         */
        initBrightness(retry) {
            if (!this.isAppEnv()) {
                this.brightness = 1;
                return;
            }
            const screen = window.plus && window.plus.screen;
            if (!screen) {
                // plus 尚未就绪，短暂重试
                if ((retry || 0) < 8) {
                    setTimeout(() => this.initBrightness((retry || 0) + 1), 150);
                }
                return;
            }
            try {
                const b = screen.getBrightness();
                if (typeof b === 'number' && b > 0 && b <= 1) {
                    this.brightness = b;
                    this.originBrightness = b;
                }
            } catch (e) {
                /* 取不到就保持 100% */
            }
        },

        /** 设置亮度：App 端写系统（应用）亮度，H5 端退化为画面亮度。 */
        setBrightness(v) {
            const val = Math.min(Math.max(v, 0), 1);
            this.brightness = val;
            this.brightnessTouched = true;

            if (this.isApp()) {
                // 原生亮度：不要再叠 CSS filter，否则暗得更狠、亮不回来
                if (this.videoEl) this.videoEl.style.filter = '';
                try {
                    window.plus.screen.setBrightness(val);
                } catch (e) {
                    /* 忽略 */
                }
            } else if (this.videoEl) {
                this.videoEl.style.filter =
                    val >= 0.999 ? '' : `brightness(${(0.25 + val * 0.75).toFixed(3)})`;
            }
            this.paintHud(val);
        },

        /** 还原进入页面时的亮度，避免把系统亮度留在别处。 */
        restoreBrightness() {
            if (!this.brightnessTouched) return;
            if (!this.isApp() || this.originBrightness <= 0) return;
            try {
                window.plus.screen.setBrightness(this.originBrightness);
            } catch (e) {
                /* 忽略 */
            }
        },

        /**
         * 设置音量。
         *
         * 优先改 video 元素音量（只影响本播放器，不改系统设置）；
         * iOS 上 volume 只读，此时回落到系统媒体音量。
         */
        setVolume(v) {
            const val = Math.min(Math.max(v, 0), 1);
            this.volume = val;

            const el = this.videoEl;
            let applied = false;
            if (el) {
                try {
                    el.volume = val;
                    applied = Math.abs(el.volume - val) < 0.02;
                    if (val > 0) el.muted = false;
                } catch (e) {
                    applied = false;
                }
            }
            if (!applied && this.isApp()) {
                try {
                    window.plus.device.setVolume(val);
                } catch (e) {
                    /* 忽略 */
                }
            }
            this.paintHud(val);
        },

        showHud(side) {
            if (!this.hudEl) return;
            // 手势期间不允许控件自动隐藏把 HUD 一起带走
            this.clearHideTimer();
            if (this.hudTimer) {
                clearTimeout(this.hudTimer);
                this.hudTimer = null;
            }
            this.hudEl.className = `vp-hud is-on ${side === 'brightness' ? 'is-left' : 'is-right'}`;
            if (this.hudLabelEl) {
                this.hudLabelEl.textContent = side === 'brightness' ? '亮度' : '音量';
            }
            this.paintHud(side === 'brightness' ? this.brightness : this.volume);
        },

        paintHud(v) {
            const pct = Math.round(Math.min(Math.max(v, 0), 1) * 100);
            if (this.hudFillEl) this.hudFillEl.style.height = `${pct}%`;
            if (this.hudValEl) this.hudValEl.textContent = `${pct}%`;
        },

        hideHudSoon() {
            if (this.hudTimer) clearTimeout(this.hudTimer);
            this.hudTimer = setTimeout(() => {
                if (this.hudEl) this.hudEl.className = 'vp-hud is-left';
                this.hudTimer = null;
            }, 700);
        },

        /* ---------------- 状态同步 ---------------- */

        syncTime() {
            const el = this.videoEl;
            if (!el) return;

            const dur = el.duration || 0;

            // 拖动中：保持拖动位置，不被播放进度回写覆盖
            if (this.dragging) {
                if (dur > 0 && this.dragRatio !== null && this.timeEl) {
                    this.timeEl.textContent = `${this.fmt(this.dragRatio * dur)} / ${this.fmt(dur)}`;
                }
                return;
            }

            const cur = el.currentTime || 0;
            if (dur > 0) {
                const pct = (cur / dur) * 100;
                if (this.fillEl) this.fillEl.style.width = `${pct}%`;
                if (this.thumbEl) this.thumbEl.style.left = `${pct}%`;
            }
            if (this.timeEl) this.timeEl.textContent = `${this.fmt(cur)} / ${this.fmt(dur)}`;
        },

        /**
         * 刷新进度条上的缓冲段宽度。
         *
         * 取「包含播放点的那一段」的末端，理由同 forwardBufferSec ——
         * 拖动后 buffered 会分成多段，取末段会把已跳过的旧区间也算进去，
         * 缓冲条会突然铺满到很远的位置，与实际情况不符。
         */
        syncBuffer() {
            const el = this.videoEl;
            if (!el || !this.bufferEl || !el.buffered || !el.buffered.length) return;
            const dur = el.duration || 0;
            if (dur <= 0 || !isFinite(dur)) return;

            const cur = el.currentTime || 0;
            let end = -1;
            try {
                for (let i = 0; i < el.buffered.length; i++) {
                    const start = el.buffered.start(i);
                    const stop = el.buffered.end(i);
                    if (start <= cur && cur <= stop) {
                        end = stop;
                        break;
                    }
                }
            } catch {
                return;
            }
            if (end < 0) return;
            this.bufferEl.style.width = `${Math.min((end / dur) * 100, 100)}%`;
        },

        updateCenter(playing) {
            if (!this.centerEl) return;
            this.centerEl.innerHTML = playing
                ? '<div class="vp-i-pause"></div>'
                : '<div class="vp-i-play"></div>';
        },

        /** 显示双击快进/快退的短暂提示。 */
        showSeekHud(text) {
            if (!this.seekHudEl) return;
            this.seekHudEl.textContent = text;
            this.seekHudEl.classList.add('is-on');
            if (this.seekHudTimer) clearTimeout(this.seekHudTimer);
            this.seekHudTimer = setTimeout(() => {
                if (this.seekHudEl) this.seekHudEl.classList.remove('is-on');
                this.seekHudTimer = null;
            }, SEEK_HUD_MS);
        },

        /**
         * 转圈的显隐已统一交给 updateLoading，这里不再保留独立机制。
         *
         * 早先这里是「往控件层插一个 .vp-spin」的实现，与加载浮层、
         * 缓冲转圈三套并存时会同时出现多个转圈（首次加载时浮层里一个、
         * 控件层又一个），画面很乱。
         *
         * 现在只有两个出口：
         *   - 尚未出画 → .vp-load 浮层内的进度环
         *   - 已出画卡顿 → .vp-buf 轻量转圈
         * 二者都由 updateLoading 依据 firstReady / readyState 判定。
         */
        showLayer() {
            if (!this.layerEl) return;
            this.layerEl.classList.remove('is-hidden');
            this.clearHideTimer();
        },

        /** 点击画面的显隐切换：可见则立即隐藏，不可见则唤出并延时自隐。 */
        toggleLayer() {
            if (this.suppressClick || this.justDragged) return;
            if (!this.layerEl) return;
            if (this.layerEl.classList.contains('is-hidden')) {
                this.showLayer();
                this.scheduleHide();
            } else {
                this.hideLayer();
            }
        },

        hideLayer() {
            this.clearHideTimer();
            if (this.layerEl) this.layerEl.classList.add('is-hidden');
            this.hideHudSoon();
        },

        scheduleHide() {
            this.clearHideTimer();
            this.hideTimer = setTimeout(() => {
                if (this.videoEl && !this.videoEl.paused) {
                    this.hideLayer();
                }
            }, HIDE_DELAY);
        },

        clearHideTimer() {
            if (this.hideTimer) {
                clearTimeout(this.hideTimer);
                this.hideTimer = null;
            }
        },

        /* ---------------- 全屏（含横屏） ---------------- */

        toggleFullscreen() {
            if (this.landscapeOn) this.exitFullscreen();
            else this.enterFullscreen();
        },

        /**
         * 在全屏内部切换方向：横屏 ↔ 竖屏。
         *
         * 仅全屏时可用。竖屏全屏时画面依然铺满视口（flex 列布局，
         * 视频 contain 居中），只是不再锁定横屏 —— 这样躺在床上
         * 竖持手机也能看，不必被强制转屏。
         */
        toggleOrientation() {
            if (!this.landscapeOn) return;
            this.landscapeLayout = !this.landscapeLayout;
            this.applyOrientation();
        },

        /** 按当前方向状态锁屏；App 走 plus，H5 走 Screen Orientation API。 */
        applyOrientation() {
            const target = this.landscapeLayout ? 'landscape-primary' : 'portrait-primary';

            if (this.isApp()) {
                try {
                    window.plus.screen.lockOrientation(target);
                } catch (e) {
                    /* 忽略 */
                }
            } else {
                const so = typeof screen !== 'undefined' ? screen.orientation : null;
                if (so && so.lock) {
                    try {
                        const p = so.lock(this.landscapeLayout ? 'landscape' : 'portrait');
                        if (p && p.catch) p.catch(() => {});
                    } catch (e) {
                        /* 忽略 */
                    }
                }
            }

            if (this.dirEl) this.dirEl.classList.toggle('is-landscape', this.landscapeLayout);
            this.boxEl && this.boxEl.classList.toggle('is-portrait-fs', !this.landscapeLayout);
            // 横竖切换后视口尺寸变了，重算一次进度条等依赖布局的尺寸
            this.$nextTick(() => this.syncTime());
            /*
             * 可用宽度也随方向变化（横屏更宽）。
             * 同一个标题在竖屏可能放不下、横屏却够 —— 反之亦然，
             * 因此每次切换方向都要重新判定是否需要滚动。
             */
            this.$nextTick(() => this.measureTitle());
            this.emit('orientationchange', this.landscapeLayout ? 'landscape' : 'portrait');
        },

        /**
         * 进入全屏。
         *
         * App 端：`plus.navigator.setFullscreen` 隐藏系统状态栏（状态栏不再压在画面上），
         *         `plus.screen.lockOrientation` 锁定方向 —— 这才是真正的全屏观感。
         * H5 端：**不**用浏览器原生 requestFullscreen，只做 CSS 铺满 + 方向锁定。
         *
         * 为什么 H5 端不用原生全屏：
         *   原生全屏会进入 top-layer，浏览器**只渲染该元素的子树**。
         *   父页面里的选集抽屉不在播放器子树内，会被整体裁掉 ——
         *   表现为「全屏后点选集没任何反应」。
         *   CSS 铺满（fixed + 100% 视口）视觉上等价，且浮层照常可见。
         *
         * @param {boolean} landscape 是否以横屏进入，默认 true
         */
        enterFullscreen(landscape) {
            const box = this.boxEl;
            if (!box) return;

            box.classList.add('is-fs');
            this.landscapeOn = true;
            this.landscapeLayout = landscape !== false;

            if (this.isApp()) {
                try {
                    window.plus.navigator.setFullscreen(true);
                } catch (e) {
                    /* 忽略 */
                }
            }

            this.applyOrientation();

            if (this.fsEl) this.fsEl.classList.add('is-exit');
            this.showLayer();
            this.scheduleHide();

            /*
             * 进入全屏后重新测量标题。
             *
             * 顶部栏非全屏时是 display:none，之前量到的可用宽度是 0，
             * 无法判断标题是否需要滚动（只能等显示后补测）。
             * 全屏切换会改变可用宽度，因此这里必须再量一次。
             */
            this.$nextTick(() => this.measureTitle());

            this.emit('landscapechange', true);
        },

        /**
         * 退出全屏并还原环境。
         *
         * 关键：必须**先显式锁回竖屏**再 unlock。
         *
         * `unlockOrientation()` 恢复的是「应用默认方向」，而本工程在
         * manifest.config.ts 里**只声明了 portrait-primary**（刻意不声明
         * 横屏，见该文件注释：一旦默认方向集含横屏，手机横持时退出全屏
         * 会仍被判为横屏，页面回不到正常竖屏形态）。
         *
         * 因此全屏横屏完全依赖运行时的 lockOrientation('landscape-primary')，
         * 退出时也就必须显式锁回竖屏 —— 只调 unlock 的话，若设备当前
         * 仍是横持姿态，会直接沿用横屏状态，表现为「点缩小没回到播放页」。
         *
         * @param {boolean} silent 组件销毁时调用，只做清理不再回调逻辑层
         */
        exitFullscreen(silent) {
            const box = this.boxEl;
            if (box) {
                box.classList.remove('is-fs');
                box.classList.remove('is-portrait-fs');
            }

            if (this.isApp()) {
                try {
                    // 先钉死竖屏，再解锁；两步缺一不可
                    window.plus.screen.lockOrientation('portrait-primary');
                } catch (e) {
                    /* 忽略 */
                }
                try {
                    window.plus.screen.unlockOrientation();
                } catch (e) {
                    /* 忽略 */
                }
                try {
                    window.plus.navigator.setFullscreen(false);
                } catch (e) {
                    /* 忽略 */
                }
            } else {
                // H5 端未使用原生全屏，只需解锁方向
                const so = typeof screen !== 'undefined' ? screen.orientation : null;
                if (so && so.unlock) {
                    try {
                        so.unlock();
                    } catch (e) {
                        /* 忽略 */
                    }
                }
            }

            this.landscapeOn = false;
            this.landscapeLayout = true;
            if (this.fsEl) this.fsEl.classList.remove('is-exit');
            if (this.dirEl) this.dirEl.classList.remove('is-landscape');
            if (!silent) this.emit('landscapechange', false);
        },

        /**
         * 回传逻辑层。
         *
         * 必须做存活检查：页面卸载时组件实例已失效，`$ownerInstance` 为 null，
         * 而 `timeupdate` 这类高频事件仍会在销毁瞬间触发回调 ——
         * 无保护地调用会让框架内部抛
         * `Cannot read property 'nodeId' of null`（见 uni-jsframework 的
         * subscribeHandler → emit 链路），表现为真机控制台刷屏报错。
         */
        emit(event, data) {
            if (this.destroyed) return;
            const owner = this.$ownerInstance;
            if (!owner || typeof owner.callMethod !== 'function') return;
            try {
                owner.callMethod('onRenderEvent', { event, data });
            } catch (e) {
                /* 实例已销毁，静默丢弃 */
            }
        }
    }
};
</script>

<style lang="scss" scoped>
.vp-mount {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    background-color: #000;
    /* 播放区域内禁止页面滚动与长按选中，避免手势被外层抢走 */
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
}
</style>
