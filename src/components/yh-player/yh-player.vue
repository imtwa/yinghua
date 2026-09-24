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
        currentIndex: { type: Number, default: 0 }
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
                 */
                episodes: this.collections.map(c => ({ id: c.id, name: c.name })),
                currentIndex: this.currentIndex
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

.vp-spin { position: absolute; left: 50%; top: 50%; width: 30px; height: 30px;
    margin: -15px 0 0 -15px; border: 2px solid rgba(255,255,255,.22);
    border-top-color: #f0a63c; border-radius: 50%; animation: vp-rot .75s linear infinite; }
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
            spinEl: null,
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

            if (!el) return;
            el.muted = !!this.props.muted;
            el.style.objectFit = this.props.objectFit || 'contain';
            if (this.props.poster) el.poster = this.props.poster;
            if (this.props.playbackRate) {
                el.playbackRate = this.props.playbackRate;
                if (this.rateEl) this.rateEl.textContent = rateLabel(this.props.playbackRate);
                if (this.rateItems) {
                    for (const it of this.rateItems) {
                        it.el.classList.toggle('is-on', Math.abs(it.rate - this.props.playbackRate) < 0.001);
                    }
                }
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
        },

        /* ---------------- 加载浮层（进度 + 网速） ---------------- */

        /**
         * 刷新进度条下方的常驻信息行（网速 + 加载进度）。
         *
         * 与 updateLoading 的区别：这一行**始终可见**（只要控件显示），
         * 不依赖是否卡顿。用户随时能看到「下得多快、加载了多少」。
         *
         * 关于「加载 100%」：hls.js 默认只预缓冲 maxMaxBufferLength=600 秒，
         * 长片永远不会真正下完整部，因此 100% 只在短片（≤600s）出现。
         * 无论哪种情况，网速都会随之归零 —— 此时显示「已加载全部」而不是
         * 一个孤零零的破折号，否则用户会以为播放器坏了。
         */
        updateStat() {
            const el = this.videoEl;
            if (!el) return;

            // 缓冲水位：优先「当前播放区间缓冲到哪 / 总时长」，其次 hls 水位
            let pct = -1;
            if (el.buffered && el.buffered.length && el.duration > 0) {
                const cur = el.currentTime || 0;
                let end = el.buffered.end(el.buffered.length - 1);
                for (let i = 0; i < el.buffered.length; i++) {
                    if (el.buffered.start(i) <= cur && cur <= el.buffered.end(i)) {
                        end = el.buffered.end(i);
                        break;
                    }
                }
                pct = Math.min((end / el.duration) * 100, 100);
            } else if (this.hlsBufferPct !== null) {
                pct = this.hlsBufferPct;
            }

            /*
             * 两侧各司其职，互不代偿：
             *   左 = 网速（始终是网速，停了就是 0 KB/s）
             *   右 = 加载进度
             * 早先版本在网速为 0 时把左侧改成「已加载」「待播」这类状态词，
             * 那是把两种信息混在一格里 —— 用户看左侧就是想看速度。
             */
            const loadedAll = pct >= 99.5;

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
                    // 只报百分比：空间有限，且百分比已足够判断
                    this.statBufEl.textContent = `加载 ${pct.toFixed(0)}%`;
                }
            }

            // 加载进度偏低时把提示点亮，让用户知道可能要卡
            if (this.statEl) {
                this.statEl.classList.toggle('is-weak', pct >= 0 && !loadedAll && pct < 10);
            }
        },

        /**
         * 显示/隐藏加载浮层并刷新进度与网速文案。
         *
         * 进度优先取 hls.js 给出的缓冲水位（level 内已缓冲比例），
         * 取不到时退回「已缓冲时长 / 总时长」。
         */
        updateLoading() {
            // 常驻信息行跟着一起刷新
            this.updateStat();

            if (!this.loadEl) return;
            const el = this.videoEl;
            if (!el) return;

            // 能正常播放时不打扰
            const stalled = el.readyState < 3 && !el.paused;
            const show = this.switching || stalled;
            this.loadEl.classList.toggle('is-on', show);
            if (!show) return;

            if (this.switching) {
                // 换集时已有专门的遮罩，这里不再叠一层
                this.loadEl.classList.remove('is-on');
                return;
            }

            // 进度：优先 hls 缓冲水位，其次 buffered/duration
            let pct = 0;
            let known = false;
            if (this.hlsBufferPct !== null) {
                pct = this.hlsBufferPct;
                known = true;
            } else if (el.buffered && el.buffered.length && el.duration > 0) {
                const end = el.buffered.end(el.buffered.length - 1);
                pct = Math.min((end / el.duration) * 100, 100);
                known = true;
            }

            if (this.loadRingEl) {
                this.loadRingEl.style.setProperty('--vp-p', `${pct.toFixed(0)}%`);
                this.loadRingEl.classList.toggle('is-known', known);
            }
            if (this.loadTextEl) {
                this.loadTextEl.textContent = known ? `正在加载 ${pct.toFixed(0)}%` : '正在加载';
            }
            if (this.loadSubEl) {
                /*
                 * 浮层里的网速与常驻行不同：浮层只在卡顿时出现，
                 * 此时网速为 0 说明可能已经断开，留空比显示 0 更含蓄。
                 */
                this.loadSubEl.textContent = this.speed > 0 ? formatSpeed(this.speed) : '';
            }
        },

        /** 一次全程滑动对应的高度比例，越小越灵敏 */

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

            this.showSpinner(true);

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
                        const hls = new Hls({
                            enableWorker: true,
                            lowLatencyMode: false,
                            // 用包装过的 loader 统计真实下载字节（见 makeMeteredLoader）
                            loader: this.makeMeteredLoader(Hls)
                        });
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

            hls.on(Hls.Events.ERROR, (_e, data) => {
                if (data && data.fatal) {
                    this.showSpinner(false);
                    this.updateLoading();
                    this.emit('error', { type: data.type, details: data.details });
                }
            });
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
                this.updateStat();
            }, 500);
        },

        stopSpeedTicker() {
            if (this.speedTimer) {
                clearInterval(this.speedTimer);
                this.speedTimer = null;
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
                        el.src = this.props && this.props.fallbackSrc ? this.props.fallbackSrc : '';
                        return;
                    }

                    // 自定义 loader：命中本地文件则读本地，否则交回默认实现
                    const LocalLoader = this.makeLocalLoader(Hls, dir);

                    const hls = new Hls({
                        enableWorker: true,
                        lowLatencyMode: false,
                        loader: LocalLoader,
                        pLoader: LocalLoader,
                        fLoader: LocalLoader
                    });
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
            });

            el.addEventListener('pause', () => {
                this.updateCenter(false);
                this.emit('pause');
                this.showLayer();
            });

            el.addEventListener('waiting', () => {
                this.showSpinner(true);
                this.updateLoading();
                this.emit('waiting');
            });

            el.addEventListener('playing', () => {
                this.showSpinner(false);
                // 新源真正出画了，揭开切换遮罩
                this.hideSwitch();
                this.updateLoading();
            });

            el.addEventListener('canplay', () => {
                this.showSpinner(false);
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
            el.addEventListener('progress', () => this.meterNative(el));

            el.addEventListener('ended', () => {
                this.updateCenter(false);
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
                this.updateLoading();
            });
            el.addEventListener('progress', () => {
                this.syncBuffer();
                this.updateLoading();
            });

            el.addEventListener('timeupdate', () => {
                this.syncTime();
                // 常驻信息行随之刷新（timeupdate 约每秒 4 次，频率足够）
                this.updateStat();
                this.emit('timeupdate', {
                    currentTime: el.currentTime || 0,
                    duration: el.duration || 0
                });
            });

            el.addEventListener('error', () => {
                this.showSpinner(false);
                this.emit('error', { code: el.error && el.error.code });
            });

            // 浏览器自动播放策略：非静音自动播放会被拦截，降级为静音起播
            el.addEventListener('loadeddata', () => {
                if (!this.props || !this.props.autoplay) {
                    this.updateCenter(false);
                    return;
                }
                const wantMuted = !!this.props.muted;
                el.muted = true;
                const p = el.play();
                if (p && p.then) {
                    p.then(() => {
                        el.muted = wantMuted;
                    }).catch(() => {
                        // 仍需用户手势，露出播放按钮
                        this.updateCenter(false);
                    });
                }
            });
        },

        /* ---------------- 控件 ---------------- */

        buildControls(mount) {
            const layer = document.createElement('div');
            layer.className = 'vp-layer';
            this.layerEl = layer;

            layer.innerHTML =
                '<div class="vp-scrim-top"></div>' +
                '<div class="vp-scrim-bottom"></div>' +
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

        /** 应用倍速（由面板点击或逻辑层指令调用）。 */
        applyRate(rate) {
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
             * 点击画面切换控件显隐。
             *
             * 关键：必须绑在 **video 元素本身**上。
             * 若只绑 layer，控件隐藏后 layer 的 pointer-events 为 none，
             * 点击会直接穿透到 video，永远无法唤出控制条。
             *
             * 显隐规则：控件已显示 → 立即隐藏；已隐藏 → 唤出并延时自隐。
             * 同时过滤拖拽与手势结束后浏览器补发的 click。
             */
            el.addEventListener('click', () => this.toggleLayer());

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
                    active: false
                };
            };

            const onMove = e => {
                const g = this.gesture;
                if (!g) return;
                const t = e.touches && e.touches[0];
                if (!t) return;

                const dx = t.clientX - g.startX;
                const dy = t.clientY - g.startY;

                if (!g.active) {
                    if (Math.abs(dy) < GESTURE_THRESHOLD) return;
                    if (Math.abs(dy) <= Math.abs(dx)) {
                        // 判定为水平手势，交还给进度条
                        this.gesture = null;
                        return;
                    }
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
                if (!g || !g.active) return;
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

        syncBuffer() {
            const el = this.videoEl;
            if (!el || !this.bufferEl || !el.buffered || !el.buffered.length) return;
            const dur = el.duration || 0;
            if (dur <= 0) return;
            const end = el.buffered.end(el.buffered.length - 1);
            this.bufferEl.style.width = `${Math.min((end / dur) * 100, 100)}%`;
        },

        updateCenter(playing) {
            if (!this.centerEl) return;
            this.centerEl.innerHTML = playing
                ? '<div class="vp-i-pause"></div>'
                : '<div class="vp-i-play"></div>';
        },

        showSpinner(on) {
            if (!this.layerEl) return;
            if (on) {
                if (this.spinEl) return;
                const spin = document.createElement('div');
                spin.className = 'vp-spin';
                this.layerEl.appendChild(spin);
                this.spinEl = spin;
            } else if (this.spinEl) {
                this.spinEl.remove();
                this.spinEl = null;
            }
        },

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
            this.emit('landscapechange', true);
        },

        /**
         * 退出全屏并还原环境。
         *
         * 关键：必须**先显式锁回竖屏**再 unlock。
         * `unlockOrientation()` 恢复的是「应用默认方向」，而 manifest 里
         * 为支持横屏全屏声明了 landscape-primary —— 手机横持时解锁后
         * 仍会被判为横屏，表现为「点缩小没回到播放页（还横着）」。
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
