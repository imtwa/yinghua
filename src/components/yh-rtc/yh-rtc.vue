<template>
    <!--
        WebRTC 通话组件。
        与 yh-player 同构：逻辑层只做桥接，真正的音视频逻辑全在 renderjs。
    -->
    <view
        :id="wrapperId"
        class="rtc-mount"
        :vseed="seed"
        :change:vseed="domRtc.onSeedChange"
        :vconf="config"
        :change:vconf="domRtc.onConfigChange"
        :vcmd="command"
        :change:vcmd="domRtc.onCommandChange" />
</template>

<script>
/**
 * 通话组件 —— 逻辑层（Options API）。
 *
 * 用 Options API 的原因同 yh-player：renderjs 只能通过
 * `$ownerInstance.callMethod()` 回调逻辑层，无法访问 script setup 作用域。
 */
export default {
    name: 'RtcCall',
    props: {
        /** 房间号（作为信令房间名） */
        roomId: { type: String, default: '' },
        /** 显示名，随信令 metadata 传给对端 */
        displayName: { type: String, default: '' },
        /** 进入后是否自动连接信令（默认 true） */
        autoStart: { type: Boolean, default: true },
        /** 初始是否开启摄像头 */
        initialVideo: { type: Boolean, default: true },
        /** 初始是否开启麦克风 */
        initialAudio: { type: Boolean, default: true },
        /**
         * 是否采集并推送本地音视频。
         *
         * **与信令无关** —— 信令始终连接（房间同步依赖它），
         * 这个开关只决定「要不要动摄像头/麦克风」。
         *
         * 拆开的理由：房间同步（片源、进度、选集）全部走 WebRTC 的
         * dataChannel，而 dataChannel 只需要信令与一条 PeerConnection，
         * 跟有没有摄像头毫无关系。早先二者绑在一起，导致「不开通话就
         * 收不到房主的片源」—— 观众会一直卡在「等待房主选片」。
         *
         * 默认 false：进房间不主动弹摄像头权限，用户点了「开启视频通话」
         * 才采集。
         */
        mediaOn: { type: Boolean, default: false }
    },
    data() {
        return {
            seed: Math.floor(Math.random() * 100000000),
            /** 渲染层指令：'start' | 'stop' | 'mute' | 'unmute' | 'camera:on' | 'camera:off' | 'switchcamera' | 'front' | 'back' | 'destroy' */
            command: '',
            /**
             * 待发送的指令队列。
             *
             * command 是字符串属性，同一帧内连续赋值会互相覆盖；
             * 一次操作要发多条指令时（如切集：先 source 再 state）
             * 必须排队，否则前一条会丢。
             */
            cmdQueue: [],
            /** 连接状态：idle / connecting / connected / error */
            status: 'idle',
            /** 远端是否已接入 */
            hasRemote: false,
            /**
             * 媒体是否就绪（摄像头/麦克风）。
             *
             * 与 status 分开：信令连上了但摄像头被拒时，
             * 房间同步照常工作，界面应显示「已连接（无画面）」
             * 而不是「连接异常」。
             */
            mediaReady: false,
            /** 媒体失败原因（供界面展示与重试） */
            mediaError: '',
            errorText: '',
            /**
             * 取流结果：是否真的拿到了视频/音频轨。
             *
             * 由 acquireLocal 写入。用途是让上层如实区分三种状态：
             *   · 有画面有声音（正常）
             *   · 只有声音（摄像头失败已降级，需提示用户）
             *   · 什么都没有（彻底失败）
             * 早先只上报「有没有流」，摄像头失败降级成纯音频时
             * 上层无从得知，用户只会觉得「视频坏了但没报错」。
             */
            mediaGotVideo: false,
            mediaGotAudio: false
        };
    },
    computed: {
        wrapperId() {
            return `rtc-${this.seed}`;
        },
        /** 对外暴露的配置（含房间号与显示名）。 */
        config() {
            return {
                roomId: this.roomId,
                displayName: this.displayName,
                autoStart: this.autoStart,
                initialVideo: this.initialVideo,
                initialAudio: this.initialAudio,
                mediaOn: this.mediaOn
            };
        }
    },
    watch: {
        command(val) {
            if (val) {
                /*
                 * 消费后复位，保证同名指令可重复触发。
                 *
                 * 注意：复位是异步的（$nextTick），因此**同一帧内连续调用
                 * 两次命令会互相覆盖** —— 后一次赋值把前一次顶掉，
                 * 前一条指令永远送不到渲染层。
                 *
                 * 这正是「切集后观众不跟随」的根因：切集时先 pushSource()
                 * 再 broadcast(state)，两条指令同帧发出，source 被覆盖，
                 * 观众只收到进度、收不到集数变化。
                 * 上层因此改用 sendCommand() 排队发送（见 methods）。
                 */
                this.$nextTick(() => {
                    if (this.command === val) {
                        this.command = '';
                        // 复位后立刻发队列里的下一条，避免指令滞留
                        this.$nextTick(() => this.flushCommandQueue());
                    }
                });
            }
        }
    },
    methods: {
        /**
         * 把命令排进队列，逐条发送。
         *
         * 每条指令在前一条被渲染层消费后再发出，避免同帧覆盖。
         * 上层凡是「一次操作要发多条指令」的场景都应走这里。
         */
        sendCommand(cmd) {
            if (!cmd) return;
            if (this.command) {
                // 上一条还没被消费，先排队
                this.cmdQueue.push(cmd);
                return;
            }
            this.command = cmd;
        },

        /** 队列里还有指令时继续发送。 */
        flushCommandQueue() {
            if (this.command) return;
            const next = this.cmdQueue.shift();
            if (next) this.command = next;
        },
        /** 渲染层唯一回调入口。 */
        onRenderEvent(payload) {
            const { event, data } = payload || {};

            if (event === 'status') {
                this.status = data;
            } else if (event === 'remote') {
                this.hasRemote = !!data;
            } else if (event === 'localready') {
                this.mediaReady = !!(data && data.media);
            } else if (event === 'mediaerror') {
                this.mediaReady = false;
                this.mediaError = (data && data.message) || '无法访问摄像头';
            } else if (event === 'error') {
                this.errorText = (data && data.message) || '通话失败';
            }
            this.$emit(event, data);
        },

        /* ---------- 供父组件调用 ---------- */

        /** 开始通话（请求摄像头/麦克风并连接信令）。 */
        start() {
            this.sendCommand('start');
        },
        /**
         * 重试获取摄像头/麦克风。
         *
         * 用户去系统设置里放开权限后回来调它，不影响已建立的连接
         * 与正在同步的播放进度。
         */
        retryMedia() {
            this.sendCommand('retrymedia');
        },
        /** 结束通话并释放设备。 */
        stop() {
            this.sendCommand('stop');
        },
        /** 开关麦克风。 */
        setAudio(on) {
            this.sendCommand(on ? 'unmute' : 'mute');
        },
        /** 开关摄像头。 */
        setVideo(on) {
            this.sendCommand(on ? 'camera:on' : 'camera:off');
        },
        /** 前后摄像头切换（移动端）。 */
        switchCamera() {
            this.sendCommand('switchcamera');
        },
        /**
         * 恢复视频播放。
         *
         * 悬浮窗收起时视频容器是 display:none，部分 WebView 会暂停解码；
         * 展开后需显式 play 一次，否则画面停在最后一帧。
         */
        resume() {
            this.sendCommand('resume');
        },
        /**
         * 开始采集并推送本地音视频（「开启视频通话」）。
         *
         * 信令此时早已连上（组件挂载即连），这里只动摄像头/麦克风 ——
         * 因此开摄像头是「锦上添花」，不影响房间同步。
         */
        startMedia() {
            this.sendCommand('startmedia');
        },
        /** 停止采集并释放设备（挂断），但保持信令与房间同步。 */
        stopMedia() {
            this.sendCommand('stopmedia');
        },
        /**
         * 向所有已连接的对端广播一条消息。
         *
         * 渲染层不能定义在 script setup 里，逻辑层也无法直接调它的方法，
         * 故复用既有的 command 通道：消息 JSON 经 encodeURIComponent
         * 编码后传递，避免内容里的特殊字符破坏指令格式。
         *
         * 必须走 sendCommand 排队：一次操作常要连发多条
         * （如切集先 source 再 state），直接写 this.command
         * 会让后一条覆盖前一条，导致集数变化丢失。
         */
        broadcast(msg) {
            try {
                this.sendCommand(`broadcast:${encodeURIComponent(JSON.stringify(msg))}`);
            } catch (e) {
                /* 不可序列化的内容直接丢弃 */
            }
        },
        /**
         * 销毁通话。
         *
         * **刻意不走队列**：销毁必须立即执行。
         * 若排在队尾，而前面还有未消费的指令（或组件正要卸载），
         * 它可能永远发不出去 —— 摄像头指示灯不灭、麦克风持续占用。
         * 清空队列，确保销毁是最后一个动作。
         */
        destroy() {
            this.cmdQueue = [];
            this.command = 'destroy';
        }
    }
};
</script>

<script module="domRtc" lang="renderjs">
/**
 * 通话组件 —— 渲染层（renderjs）。
 *
 * 为什么自己实现信令而不用 simple-signal-client：
 *   那个库依赖 Node 的 `cuid`/`inherits`/`nanobus` 与 `simple-peer`，
 *   在 renderjs（无 import、无 Node 模块）里无法使用。
 *   而它做的事情很薄 —— 只是把 socket.io 事件按固定名字转发，
 *   因此这里用 **socket.io + 原生 RTCPeerConnection** 复刻同一协议。
 *
 * 协议与服务端行为见 `constants/rtc.ts` 的注释。
 */

/** 静态资源路径（App 相对根目录，H5 用绝对路径）。 */
const SIO_URL = (function () {
    const isApp = typeof window !== 'undefined' && (!!window.plus || /Html5Plus/i.test(navigator.userAgent || ''));
    return isApp ? './static/js/socket.io.min.js' : '/static/js/socket.io.min.js';
})();

const EV = {
    discover: 'simple-signal[discover]',
    offer: 'simple-signal[offer]',
    signal: 'simple-signal[signal]',
    reject: 'simple-signal[reject]'
};

const SIGNAL_URL = 'https://weston-vue-webrtc-lobby.azurewebsites.net';
const REDISCOVER_INTERVAL = 3000;
const CONNECT_TIMEOUT = 15000;

/**
 * 等待对方 offer 的兜底时长（毫秒）。
 *
 * 超过它仍没收到 offer 才由本端补发起。取值要比「一次 offer 往返」明显长，
 * 否则 App 端弱网下会把正常的慢 offer 误判成丢失，反而制造 glare。
 */
const FALLBACK_OFFER_DELAY = 6000;

/**
 * disconnected 状态的最长容忍时间（毫秒）。
 *
 * 超过它仍未恢复 connected 就按失效处理并允许重建。取值要明显大于
 * 内核自愈所需时间（通常 1~3 秒），否则网络轻微抖动就把连接拆了。
 */
const RECOVER_TIMEOUT = 8000;

/*
 * ICE 服务器。
 *
 * renderjs 不能 import，因此这里与 constants/rtc.ts **各存一份** ——
 * 修改时必须两处同步，否则实际生效的是这一份。
 *
 * 配置多个 STUN 的原因见 constants/rtc.ts 的注释：单个服务器不一定可达，
 * 本机实测 stun.qq.com 就超时，只配它会导致收集不到公网候选。
 */
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' }
];

const CSS_TEXT = `
.rtc-box { position: relative; width: 100%; height: 100%; background: #0b0d10; overflow: hidden; }

/*
 * 远端画面区。
 *
 * 多人时每人一格（网格自动排布）；只有一人时铺满。
 * 用 grid + auto-fit 而非写死列数：2 人并排、3~4 人两行两列，
 * 无需为每种人数单独写规则。
 */
.rtc-grid { position: absolute; left: 0; top: 0; right: 0; bottom: 0;
    display: grid; gap: 2px; background: #000;
    grid-template-columns: repeat(auto-fit, minmax(45%, 1fr));
    align-content: stretch; }
.rtc-grid.is-single { grid-template-columns: 1fr; }

/* 单个对端画面 */
.rtc-tile { position: relative; overflow: hidden; background: #0d1014; }
.rtc-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 该对端关掉摄像头时用占位底色，避免一片死黑看不出区别 */
.rtc-tile.is-novideo { background: #16191f; }

/* 昵称标签：压在画面左下角，半透明底不抢视线 */
.rtc-tag { position: absolute; left: 5px; bottom: 5px; z-index: 3; max-width: calc(100% - 10px);
    padding: 2px 7px; border-radius: 9px; background: rgba(0,0,0,.58);
    font-size: 10px; color: rgba(255,255,255,.92);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* 麦克风静音角标 */
.rtc-tag.is-muted { color: rgba(255,255,255,.5); }

/*
 * 本地画面：始终显示，压在右下角。
 *
 * 位置与远端区分离，避免「本地流没显示」的误判 ——
 * 用户需要能随时确认自己的画面与声音状态。
 */
.rtc-local { position: absolute; right: 8px; bottom: 8px; z-index: 5;
    width: 30%; max-width: 120px; aspect-ratio: 3 / 4;
    border-radius: 8px; overflow: hidden; background: #000;
    border: 1px solid rgba(255,255,255,.24);
    box-shadow: 0 4px 14px rgba(0,0,0,.55); }
.rtc-local video { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 本地关掉摄像头：只留标签，不要黑框 */
.rtc-local.is-novideo video { visibility: hidden; }
.rtc-local.is-novideo { background: #16191f; }
.rtc-local .rtc-tag { left: 4px; right: 4px; bottom: 4px; text-align: center;
    padding: 2px 4px; font-size: 9px; max-width: none; }

/* 等待对方接入（无人时铺满） */
.rtc-wait { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 2;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: #0d1014; }
.rtc-wait-title { font-size: 13px; color: rgba(255,255,255,.86); }
.rtc-wait-sub { margin-top: 7px; font-size: 11px; color: rgba(255,255,255,.45);
    font-variant-numeric: tabular-nums; text-align: center; padding: 0 10px;
    line-height: 1.5; }
.rtc-wait.is-hidden { display: none; }
`;

export default {
    data() {
        return {
            num: '',
            conf: {},
            boxEl: null,
            /** 远端画面网格容器 */
            gridEl: null,
            /** sessionId -> { wrap, video, tag }（一个对端一格） */
            tiles: {},
            localVideoEl: null,
            localWrapEl: null,
            localTagEl: null,
            waitEl: null,
            waitSubEl: null,
            /** socket.io 实例 */
            socket: null,
            /** sessionId -> RTCPeerConnection */
            peers: {},
            /** sessionId -> RTCDataChannel（播放同步用） */
            channels: {},
            /** 远端 socket id -> 昵称（信令 metadata 交换得到） */
            peerNames: {},
            /** 已建立连接的远端 id，避免重复发起 */
            connectedIds: {},
            /**
             * 早到信令暂存：sessionId -> 消息数组。
             *
             * 候选/answer 与 offer 是两条独立通道，网络快时前者会**先于**
             * offer 到达。此时 `this.peers[sessionId]` 还不存在，
             * 旧实现直接 `return` 把消息丢了 —— 该连接的候选就此残缺，
             * 只能等 ICE 超时。
             *
             * 两人场景下 offer 与候选间隔极短，很少撞上；三人及以上时
             * 多条连接并发协商，交错概率大幅上升，表现为「某人一直连不上」。
             * 因此这里先收着，等 createPeer 之后补投。
             */
            earlySignals: {},
            /** 兜底发起定时器：远端 id -> timer（便于在 offer 到达时取消） */
            fallbackTimers: {},
            /** 连接超时定时器：sessionId -> timer（重复发起时先清旧的） */
            connectTimers: {},
            /** disconnected 恢复兜底定时器：sessionId -> timer */
            recoverTimers: {},
            /** 本地媒体流 */
            localStream: null,
            /**
             * 正在进行的取流任务（重入保护）。
             *
             * startMedia 有两条触发路径（prop 变化 + 指令），可能同帧先后到达；
             * 用这个在飞 Promise 让后来者复用同一次结果，避免并发 getUserMedia
             * 导致前一条流被覆盖而永不释放。
             *
             * 命名**不带下划线前缀**：Vue 2 的 isReserved() 会把 `_x`
             * 视为保留名而跳过 proxy，data 里的声明会变成死代码，
             * 实际值只落在实例的动态属性上 —— 能跑，但读代码时极易误判。
             */
            mediaTask: null,
            /** 取流是否已被取消（stopMedia 置位，doStartMedia 检查） */
            mediaCancelled: false,
            rediscoverTimer: null,
            destroyed: false,
            /** 是否正在监听设备 */
            running: false,
            /** 固化后的房间名（由 waitRoomId 落定，避免 conf 后续被覆盖） */
            roomIdFixed: ''
        };
    },
    computed: {
        boxId() {
            return `rtc-${this.num}`;
        }
    },
    beforeUnmount() {
        this.cleanup();
    },
    methods: {
        /* ---------------- 基础 ---------------- */

        isAppEnv() {
            return !!(window.plus) || /Html5Plus/i.test(navigator.userAgent || '');
        },

        injectStyle() {
            if (document.getElementById('rtc-render-style')) return;
            const style = document.createElement('style');
            style.id = 'rtc-render-style';
            style.appendChild(document.createTextNode(CSS_TEXT));
            document.head.appendChild(style);
        },

        /** 动态加载 socket.io（renderjs 不能 import）。 */
        loadSocketIO() {
            return new Promise((resolve, reject) => {
                if (window.__SocketIOClient && window.__SocketIOClient.io) {
                    resolve(window.__SocketIOClient.io);
                    return;
                }
                const exist = document.querySelector('script[data-rtc-sio="1"]');
                if (exist) {
                    exist.addEventListener('load', () => resolve(window.__SocketIOClient.io));
                    exist.addEventListener('error', () => reject(new Error('socket.io 加载失败')));
                    return;
                }
                const s = document.createElement('script');
                s.src = SIO_URL;
                s.setAttribute('data-rtc-sio', '1');
                s.onload = () => resolve(window.__SocketIOClient && window.__SocketIOClient.io);
                s.onerror = () => reject(new Error('socket.io 加载失败'));
                document.head.appendChild(s);
            });
        },

        /**
         * 回传逻辑层。
         *
         * 同样要做存活检查：通话的事件（状态、轨道、ICE 候选）在页面
         * 卸载后仍可能由 WebRTC 内部异步触发，此时 $ownerInstance 已失效，
         * 无保护调用会让框架抛 `Cannot read property 'nodeId' of null`。
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
        },

        setStatus(s) {
            this.emit('status', s);
        },

        /* ---------------- 生命周期入口 ---------------- */

        /**
         * 恢复所有视频播放。
         *
         * 悬浮窗收起时容器是 display:none，部分 WebView 会连带暂停解码，
         * 重新显示后画面可能停在最后一帧（看起来像卡死）。
         * 因此展开时显式 play 一次。
         */
        resumeVideos() {
            const vids = [this.localVideoEl];
            for (const tile of Object.values(this.tiles)) vids.push(tile.video);
            for (const v of vids) {
                if (v && typeof v.play === 'function') v.play().catch(() => {});
            }
        },

        onSeedChange(seed) {
            this.num = seed;
        },

        onConfigChange(conf) {
            const prev = this.conf || {};
            this.conf = conf || {};
            if (!this.num) {
                const el = document.querySelector('[id^="rtc-"]');
                if (el) this.num = (el.id || '').replace('rtc-', '');
            }
            this.$nextTick(() => this.setup());

            /*
             * mediaOn 变化即开关摄像头/麦克风。
             *
             * 页面把「开启视频通话」映射成这个 prop，因此这里要能双向响应：
             *   false → true  开摄像头
             *   true  → false 关摄像头并释放设备
             *
             * 注意只在**确实变化**时动作，否则 viewport 每次推送
             * （显示名、房间号等任一字段变动都会推）都会重启一次摄像头。
             */
            const was = !!prev.mediaOn;
            const now = !!(conf && conf.mediaOn);
            if (now && !was && this.running) {
                this.startMedia();
            } else if (!now && was) {
                /*
                 * 关闭时**不判断 localStream 是否存在**。
                 *
                 * 早先写成 `&& this.localStream` 才调 stopMedia —— 但取流失败时
                 * localStream 本就是 null，于是这次「关闭」被整个跳过：
                 * 各对端 sender 上的旧轨道没被解除，对端画面停在最后一帧，
                 * 而本地已经不再采集，双方状态就此不一致。
                 * stopMedia 内部对 null 流是安全的，无条件调用即可。
                 */
                this.stopMedia();
            }
        },

        onCommandChange(cmd) {
            if (!cmd) return;
            if (cmd === 'start') this.start();
            else if (cmd === 'stop') this.cleanup();
            else if (cmd === 'retrymedia') this.retryMedia();
            else if (cmd === 'startmedia') this.startMedia();
            else if (cmd === 'stopmedia') this.stopMedia();
            else if (cmd === 'mute') this.toggleAudio(false);
            else if (cmd === 'unmute') this.toggleAudio(true);
            else if (cmd === 'camera:on') this.toggleVideo(true);
            else if (cmd === 'camera:off') this.toggleVideo(false);
            else if (cmd === 'switchcamera') this.switchCamera();
            else if (cmd === 'destroy') this.cleanup();
            else if (cmd === 'resume') this.resumeVideos();
            else if (cmd.indexOf('broadcast:') === 0) {
                // 逻辑层下发的广播消息，JSON 经 URI 编码后传入
                try {
                    const msg = JSON.parse(decodeURIComponent(cmd.slice(10)));
                    this.broadcast(msg);
                } catch (e) {
                    /* 内容损坏则丢弃 */
                }
            }
        },

        /* ---------------- 初始化 ---------------- */

        setup(retry) {
            this.injectStyle();

            const mount = document.getElementById(this.boxId);
            if (!mount) {
                const times = retry || 0;
                if (times < 12) setTimeout(() => this.setup(times + 1), 30);
                return;
            }

            if (this.boxEl) return; // 已初始化

            mount.classList.add('rtc-box');
            this.boxEl = mount;

            /*
             * 远端画面区。
             *
             * 每个对端一格，由 addRemoteTile 动态追加；
             * 人少时自动铺满，人多时网格排布。
             */
            const grid = document.createElement('div');
            grid.className = 'rtc-grid is-single';
            mount.appendChild(grid);
            this.gridEl = grid;

            // 本地画面：始终显示，用于确认自己的画面与声音状态
            const localWrap = document.createElement('div');
            localWrap.className = 'rtc-local';
            const local = document.createElement('video');
            local.setAttribute('playsinline', 'true');
            local.setAttribute('webkit-playsinline', 'true');
            local.autoplay = true;
            local.muted = true;   // 本地回显必须静音，否则啸叫
            localWrap.appendChild(local);

            const localTag = document.createElement('div');
            localTag.className = 'rtc-tag';
            localTag.textContent = `${(this.conf && this.conf.displayName) || '我'}（我）`;
            localWrap.appendChild(localTag);

            mount.appendChild(localWrap);
            this.localWrapEl = localWrap;
            this.localVideoEl = local;
            this.localTagEl = localTag;

            // 等待提示：无人接入时盖住整块
            const wait = document.createElement('div');
            wait.className = 'rtc-wait';
            wait.innerHTML =
                '<div class="rtc-wait-title">等待好友接入…</div>' +
                '<div class="rtc-wait-sub"></div>';
            mount.appendChild(wait);
            this.waitEl = wait;
            this.waitSubEl = wait.querySelector('.rtc-wait-sub');

            this.syncGridLayout();
            this.updateLocalBadge();

            if (this.conf && this.conf.autoStart) {
                this.start();
            }
        },

        /**
         * 等房间号就绪后再连信令。
         *
         * 房间号由页面在 onLoad 里生成并赋给 prop；而 renderjs 的属性同步
         * 与组件挂载不同步 —— 首帧拿到的 conf.roomId 可能是空串。
         * 此时若直接连信令，connectSignal 会以「缺少房间号」抛错，
         * 信令再也起不来（房间同步彻底失效）。
         *
         * 因此这里轮询等待，最多约 6 秒。
         */
        waitRoomId() {
            return new Promise(resolve => {
                let tries = 0;
                const check = () => {
                    const id = (this.conf && this.conf.roomId) || '';
                    if (id) {
                        resolve(id);
                        return;
                    }
                    tries += 1;
                    if (tries > 60) {
                        resolve('');
                        return;
                    }
                    setTimeout(check, 100);
                };
                check();
            });
        },

        /** 刷新各处昵称标签（本地小窗、各对端格、等待提示）。 */
        updateNameBadges() {
            this.updateLocalBadge();

            // 对端格上的昵称
            for (const peerId of Object.keys(this.tiles)) {
                this.updateTileTag(peerId, this.peerNames[peerId]);
            }

            // 等待提示：列出已连上的名字，多人时说明人数
            if (this.waitSubEl) {
                const names = Object.values(this.peerNames).filter(Boolean);
                const me = (this.conf && this.conf.displayName) || '我';
                if (!names.length) {
                    this.waitSubEl.textContent = `你是「${me}」· 把房间号发给好友即可加入`;
                } else if (names.length === 1) {
                    this.waitSubEl.textContent = `你（${me}）正在等待 ${names[0]} 接入`;
                } else {
                    this.waitSubEl.textContent = `你（${me}）与 ${names.join('、')} 畅聊中`;
                }
            }
        },

        /* ---------------- 取流 ---------------- */

        /**
         * 获取本地音视频。
         *
         * 分层降级：先要音视频 → 失败退纯音频 → 再失败退「只看不听」。
         * 摄像头被占用很常见，不应直接判失败。
         *
         * App 端注意：Android WebView 默认不向网页暴露摄像头/麦克风，
         * 必须先由原生层授予 WebView 权限（见 grantWebviewMediaPermission）。
         */
        async acquireLocal() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.warn('[rtc] 当前环境不支持 getUserMedia');
                throw new Error('当前环境不支持摄像头采集');
            }

            // App 端先补权限，否则 Android 上会直接 NotAllowedError
            await this.grantWebviewMediaPermission();

            const wantVideo = this.conf.initialVideo !== false;
            const wantAudio = this.conf.initialAudio !== false;

            /*
             * 降级链：音视频 → 纯音频；只开摄像头时退为纯视频。
             *
             * ⚠️ 曾经这里还有一项 `{ video: false, audio: false }`，
             * 是「视频通话没画面但也不报错」的根因：
             * 该调用在规范上**合法且会成功**，返回一个不含任何轨道的空流，
             * 于是摄像头失败时会被误判为「取流成功」——
             * 不抛异常、不报错、不打日志，流里却一个轨道都没有。
             *
             * 但去掉它之后又留下另一个边界：**只要视频、不要音频**时
             * （initialAudio 显式传 false），两个条件都不成立，
             * `tries` 会是**空数组** —— 循环一次都不跑，直接抛
             * 「无法访问摄像头/麦克风」，连摄像头都开不起来。
             * 因此为「纯视频」单独补一档。
             *
             * 注意纯视频**排在纯音频之后**：音视频都想要时若摄像头坏了，
             * 应该退成「能通话」而不是「只有画面没声音」—— 音频是刚需。
             */
            const tries = [];
            if (wantVideo && wantAudio) {
                tries.push({
                    label: '音视频',
                    constraints: {
                        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                        audio: true
                    }
                });
            }
            if (wantAudio) {
                tries.push({ label: '纯音频', constraints: { video: false, audio: true } });
            }
            if (wantVideo && !wantAudio) {
                tries.push({
                    label: '纯视频',
                    constraints: {
                        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                        audio: false
                    }
                });
            }

            console.log('[rtc] 开始取流，降级链:', tries.map(t => t.label).join(' → '));

            let lastErr = null;
            for (const t of tries) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia(t.constraints);
                    const v = stream.getVideoTracks().length;
                    const a = stream.getAudioTracks().length;
                    console.log(`[rtc] 取流成功（${t.label}）: 视频轨 ${v} 条, 音频轨 ${a} 条`);

                    /*
                     * 空流一律视为失败。
                     *
                     * 即便前面的坑修掉了，某些内核仍可能返回无轨道的流
                     * （例如设备被独占时）。若不拦住，后面
                     * applyLocalTracksToPeer 会因找不到轨道而静默跳过，
                     * 又变回「没画面也没日志」。
                     */
                    if (!v && !a) {
                        console.warn(`[rtc] ${t.label} 返回了空流（无任何轨道），判为失败`);
                        lastErr = new Error('取到的流不含任何轨道');
                        continue;
                    }

                    // 记下降级结果，供上层如实上报「有没有画面」
                    this.mediaGotVideo = v > 0;
                    this.mediaGotAudio = a > 0;
                    if (!v && wantVideo) {
                        console.warn('[rtc] 摄像头未能启用，已降级为纯音频（对端将看不到画面）');
                    }
                    return stream;
                } catch (e) {
                    console.warn(`[rtc] 取流失败（${t.label}）:`, (e && e.name) || '', (e && e.message) || e);
                    lastErr = e;
                }
            }

            console.error('[rtc] 所有取流尝试均失败');
            throw lastErr || new Error('无法访问摄像头/麦克风');
        },

        /**
         * 确保 App 端已获得摄像头/麦克风的应用级权限（Android）。
         *
         * uni-app 的 App 页面跑在系统 WebView 里。manifest 中声明的
         * CAMERA / RECORD_AUDIO 会在安装时登记，但**运行时仍需用户授权**；
         * 未授权时 getUserMedia 会直接抛 NotAllowedError，
         * 用户看不到系统弹窗、只觉得「点了没反应」。
         *
         * 这里用 Native.js 主动发起权限请求，**并等待用户操作结果**。
         *
         * 早先的实现发完请求就立刻 resolve（注释里写「用户点完允许再点一次即可」），
         * 实际后果是首次进入必然失败一次，而且没有任何自动重试 ——
         * 用户看到的就是「摄像头打不开」。现在改为回调驱动：
         * 授权成功后自动补一次取流，用户只需点一次「允许」。
         */
        grantWebviewMediaPermission() {
            return new Promise(resolve => {
                if (!window.plus || !window.plus.android) {
                    // 非 Android（iOS 走系统 WebView 的自动弹窗）
                    resolve();
                    return;
                }
                try {
                    const main = window.plus.android.runtimeMainActivity();
                    const perms = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'];

                    const need = perms.filter(p => {
                        try {
                            return window.plus.android.invoke(main, 'checkSelfPermission', p) !== 0;
                        } catch (e) {
                            return false;
                        }
                    });

                    if (need.length === 0) {
                        resolve();
                        return;
                    }

                    /*
                     * 权限结果是异步的。这里挂一次回调，等系统弹窗结束后
                     * 再放行 —— 不等的话紧接着的 getUserMedia 必然失败。
                     *
                     * 超时兜底：个别机型不回调，卡死会连信令一起拖住
                     * （取流与信令虽已解耦，但取流任务本身不该无限挂起）。
                     */
                    let settled = false;
                    const done = () => {
                        if (settled) return;
                        settled = true;
                        resolve();
                    };

                    try {
                        window.plus.android.requestPermissions(
                            need,
                            () => done(),   // 全部允许
                            () => done()    // 部分/全部拒绝：交给 getUserMedia 报准确原因
                        );
                    } catch (e) {
                        done();
                        return;
                    }
                    setTimeout(done, 20000);
                } catch (e) {
                    resolve();
                }
            });
        },

        /* ---------------- 开始 / 清理 ---------------- */

        /**
         * 启动。
         *
         * **信令与媒体彻底解耦** —— 这是本组件最重要的一条约束。
         *
         * 房间同步（片源、进度、选集）全部经 WebRTC 的 dataChannel 传输，
         * 而 dataChannel 只需要信令 + 一条 PeerConnection，
         * **与摄像头/麦克风毫无关系**。
         *
         * 早先的实现是「先取流、取到了才连信令」，于是：
         *   摄像头被拒/被占用/无设备 → getUserMedia 抛错
         *   → connectSignal 根本不执行 → 没有 PeerConnection
         *   → 没有 dataChannel → 房主广播的片源一条都发不出去。
         * 观众侧的表现就是「一直等待房主选片」，哪怕房主早已选好片。
         *
         * 现在：信令无条件建立；媒体是否采集由 conf.mediaOn 决定，
         * 失败也只降级为「没有画面」，绝不影响看片同步。
         */
        async start() {
            if (this.running) return;
            this.running = true;
            this.destroyed = false;
            this.setStatus('connecting');

            // 1. 信令：房间同步的唯一通道，必须建立
            const signalTask = this.connectSignal().catch(e => {
                this.emit('error', { message: '信令连接失败：' + ((e && e.message) || e) });
                return false;
            });

            /*
             * 2. 媒体：按需采集，失败只降级。
             *
             * **必须走 startMedia，不能自己 acquireLocal + attachLocalStream**。
             * 那条旧写法绕过了 startMedia 的三重保护：
             *   · 重入闸门（mediaTask）—— 与 onConfigChange 的自动开启并发时
             *     会发起两次 getUserMedia，前一条流永不释放
             *   · 取消标记（mediaCancelled）—— 启动途中挂断，流仍会被装上
             *   · mediaReady / localready 的完整上报
             * 症状与「点开启视频通话」时的不一致完全相同，只是触发路径不同。
             *
             * startMedia 内部已含 reportMediaFailure，无需再 catch 一遍。
             */
            const wantMedia = !!(this.conf && this.conf.mediaOn);
            const mediaTask = wantMedia ? this.startMedia() : Promise.resolve(false);

            await signalTask;
            const mediaOk = await mediaTask;

            /*
             * 无论媒体是否就绪都要上报。
             *
             * 页面靠这个事件判断「本地是否已有画面」；若只在取流成功时
             * 才报，摄像头一坏页面就永远等不到这个事件。
             *
             * 字段必须与 doStartMedia 里那次 emit **保持一致**，尤其是
             * `videoDropped`：它是页面用来提示「摄像头没启用、当前为纯音频」
             * 的唯一依据。早先这里漏了它，导致「通话中重进房间」这条路径
             * （autoStart + mediaOn 已为 true，媒体由 start 触发而非用户点击）
             * 在摄像头降级时完全没有提示 —— 用户只觉得对方看不到自己。
             */
            const stream = this.localStream;
            const hasVideo = !!stream && stream.getVideoTracks().length > 0;
            const hasAudio = !!stream && stream.getAudioTracks().length > 0;
            this.emit('localready', {
                media: mediaOk,
                hasVideo,
                hasAudio,
                videoDropped: mediaOk && !hasVideo && hasAudio
            });
        },

        /**
         * 挂上本地流：更新本地预览，并补给所有已建立的对端连接。
         *
         * 「补给已有连接」是媒体后到的关键路径 —— 用户可能在拒绝权限后
         * 又去系统设置里放开再回来，此时对端连接已经建立但没有轨道。
         */
        async attachLocalStream(stream) {
            this.localStream = stream;

            if (this.localVideoEl) {
                this.localVideoEl.srcObject = stream;
                try {
                    await this.localVideoEl.play();
                } catch (e) { /* 自动播放可能被拦，忽略 */ }
            }
            this.updateLocalBadge();

            /*
             * 逐个装配，且**逐个 await**。
             *
             * applyLocalTracksToPeer 内部走 runOnPeer 入队，同一 peer 的操作
             * 天然串行；但不同 peer 之间若并发发起，会对同一个 localStream
             * 同时做 replaceTrack —— 部分内核对并发 replaceTrack 支持不佳，
             * 会出现某一路静默失败。顺序执行代价很小（每人几条轨道）。
             */
            for (const sid of Object.keys(this.peers)) {
                await this.applyLocalTracksToPeer(this.peers[sid]);
            }
            return true;
        },

        /**
         * 把针对某个 peer 的异步信令操作**串行化**。
         *
         * ## 为什么必须有
         *
         * `setRemoteDescription` 对状态机很敏感：在同一连接上并发调用，
         * 后一次会抛 `Failed to set remote answer sdp: Called in wrong state`。
         * 而信令是**多条独立通道**送来的（offer / answer / candidate），
         * 到达顺序与时机都不受控 —— 尤其对端兜底重发 offer 时，
         * 新的 offer 可能与本端正在处理的 answer 撞在一起。
         *
         * 成熟库（simple-peer）内部用 `_isNegotiating` + `_queuedNegotiation`
         * 配合 signalingStateChange 做同一件事；这里用 Promise 链达成同等效果，
         * 实现更直白。
         *
         * 注意：**不得在队列内部再调 runOnPeer**（同一 peer 会自我等待而死锁）。
         * 队列内的代码直接调 applySignal / doApplyTracks 这类纯执行函数即可。
         */
        runOnPeer(peer, fn) {
            if (!peer) return Promise.resolve();

            const prev = peer._opChain || Promise.resolve();
            const next = prev
                .then(() => {
                    // 排队期间这条连接可能已被丢弃，直接跳过
                    if (this.destroyed) return undefined;
                    if (this.peers[peer._sid] !== peer) return undefined;
                    return fn();
                })
                .catch(e => {
                    console.warn('[rtc] 信令操作异常:', (e && e.message) || e);
                });

            peer._opChain = next;
            return next;
        },

        /**
         * 把本地轨道填进某个对端。
         *
         * 用 `replaceTrack` 而不是 `addTrack`：前者不改变 SDP、不触发
         * 重协商，因此在「连接建立之后才拿到摄像头」这种媒体后到的场景下
         * 依然能直接生效。
         *
         * 前提是建连时已经声明过收发方向（见 createPeer 的 ensureTransceivers）——
         * 若等有流了才 addTrack，就会触发重协商；而重协商在移动端 WebView 上
         * 失败率不低，且本组件的信令协议只处理首次 offer，另起一套流程
         * 复杂度与风险都不划算。
         *
         * 本方法只负责**入队**，实际装配在 doApplyTracks。
         */
        async applyLocalTracksToPeer(peer) {
            if (!peer || !this.localStream || typeof peer.getTransceivers !== 'function') {
                console.warn('[rtc] 无法装配轨道: peer/流缺失或内核不支持 getTransceivers');
                return;
            }

            /*
             * 装配本身也要入队串行化。
             *
             * replaceTrack 虽不改 SDP，但 `t.direction` 的读取与协商状态相关：
             * 若在 setRemoteDescription/createAnswer 进行到一半时并发执行，
             * 读到的 direction 可能是中间态，于是把已经能发的连接误判成
             * recvonly，甚至把方向改回去。串行之后每次装配都看到稳定状态。
             */
            await this.runOnPeer(peer, () => this.doApplyTracks(peer));
        },

        /** 真正把本地轨道填进对端（纯执行函数，由 runOnPeer 串行化后调用）。 */
        async doApplyTracks(peer) {
            if (!peer || !this.localStream) return;

            const transceivers = peer.getTransceivers();
            let filled = 0;

            for (const t of transceivers) {
                const kind = t.receiver && t.receiver.track ? t.receiver.track.kind : null;
                if (!kind || !t.sender) continue;
                const track = this.localStream.getTracks().find(x => x.kind === kind);
                if (!track) {
                    /*
                     * 该方向没有本地轨道。
                     *
                     * 最常见的成因：摄像头取流失败（降级为纯音频），
                     * 于是 video 方向的 transceiver 找不到对应轨道，
                     * 对端永远收不到画面 —— 这就是「视频通话没画面」
                     * 在装配阶段的直接表现，必须打出来才看得见。
                     */
                    console.warn(`[rtc] ${kind} 方向无本地轨道，跳过（对端收不到该路媒体）`);
                    continue;
                }
                try {
                    await t.sender.replaceTrack(track);
                    filled++;
                } catch (e) {
                    console.warn(`[rtc] ${kind} 轨道装配失败:`, (e && e.message) || e);
                }

                /*
                 * 装了轨道但方向仍是 recvonly —— 媒体发不出去。
                 *
                 * 这是最隐蔽的一种「假成功」：replaceTrack 不报错、轨道数
                 * 也计入了，但对端一个字节都收不到。正常流程下
                 * promoteSendRecv 已把方向提好，走到这里说明有路径漏了，
                 * 必须显式喊出来，否则又变成无声黑屏。
                 */
                if (t.direction === 'recvonly') {
                    console.warn(
                        `[rtc] ${kind} 方向仍为 recvonly，轨道装上了也发不出去` +
                        '（应在 createAnswer 前调用 promoteSendRecv）'
                    );
                }
            }

            console.log(`[rtc] 轨道装配完成: ${filled}/${transceivers.length} 个 transceiver 已填充`);
        },

        /**
         * 把收发方向提成 sendrecv。
         *
         * ## 为什么必须有这一步
         *
         * 应答方的 transceiver 是**由对方的 offer 创建**的，规范规定
         * 其 `direction` 一律为 `recvonly`。若直接 createAnswer，
         * 答案里对应的 m 行就是 `recvonly` —— 本端**只收不发**。
         *
         * 而 `replaceTrack` 只更换 sender 上的轨道，**完全不改变 SDP
         * 里的方向**。所以哪怕日志显示「轨道装配完成: 2/2 个 transceiver
         * 已填充」，媒体依然一个字节都发不出去，对端也不会触发 ontrack。
         *
         * 表现就是**单向可见**：谁当应答方谁黑屏，另一端却看得到他。
         * 谁当应答方由 socket.id 字典序裁定（见 onDiscover），
         * 因此房主和观众都可能中招，且症状随配对结果变化，极难自查。
         *
         * 必须在 `setRemoteDescription` 之后、`createAnswer` 之前调用 ——
         * 提前调 getTransceivers() 还是空的，推后调答案已经发出去了。
         */
        promoteSendRecv(peer) {
            if (!peer || typeof peer.getTransceivers !== 'function') return;

            let changed = 0;
            for (const t of peer.getTransceivers()) {
                if (!t || t.stopped) continue;
                // 已经能发就不动它，避免无谓的重复协商
                if (t.direction === 'sendrecv' || t.direction === 'sendonly') continue;
                try {
                    t.direction = 'sendrecv';
                    changed += 1;
                } catch (e) {
                    console.warn('[rtc] 提升收发方向失败:', (e && e.message) || e);
                }
            }

            if (changed) {
                console.log(`[rtc] 已把 ${changed} 个 transceiver 的方向提为 sendrecv`);
            }
        },

        /**
         * 声明收发通道。
         *
         * **即使当前没有本地流也要先建 transceiver** —— 这样 SDP 里已经
         * 声明了收发方向，之后拿到摄像头只要 replaceTrack 即可，
         * 无需再次交换 SDP。
         */
        ensureTransceivers(peer) {
            if (!peer || typeof peer.addTransceiver !== 'function') return;
            for (const kind of ['audio', 'video']) {
                const has = peer.getTransceivers().some(t => {
                    const rt = t.receiver && t.receiver.track;
                    return !!rt && rt.kind === kind;
                });
                if (has) continue;
                try {
                    peer.addTransceiver(kind, { direction: 'sendrecv' });
                } catch (e) { /* 个别内核不支持时忽略 */ }
            }
        },

        /**
         * 上报媒体获取失败，并给出可操作的诊断。
         *
         * 单独一个事件而不是复用 error：摄像头失败时通话与看片同步其实
         * 都还在正常工作，用「通话异常」来提示会让人误以为整个功能坏了。
         */
        reportMediaFailure(e) {
            const detail = this.diagnoseMediaError(e);
            this.updateLocalBadge();
            this.emit('mediaerror', { message: detail, name: (e && e.name) || '' });
        },

        /**
         * 把 getUserMedia 的失败翻译成「用户能照着做」的提示。
         *
         * 其中「非安全上下文」最容易被误判成代码 bug：浏览器只在
         * https / localhost / 127.0.0.1 下提供 mediaDevices，
         * 用 http + 局域网 IP 打开时 navigator.mediaDevices 直接是 undefined，
         * 报错文本会像「不支持」，其实是访问方式的问题。
         */
        diagnoseMediaError(e) {
            const name = (e && e.name) || '';

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                if (typeof window !== 'undefined' && window.isSecureContext === false) {
                    return '当前页面不是安全环境：H5 端需用 https 或 localhost 打开，http + 局域网 IP 会被浏览器禁止调用摄像头';
                }
                return '当前环境不提供摄像头接口';
            }

            if (name === 'NotAllowedError' || name === 'SecurityError') {
                return '摄像头/麦克风权限被拒绝，请在系统设置里允许后重试';
            }
            if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
                return '没有检测到可用的摄像头或麦克风';
            }
            if (name === 'NotReadableError' || name === 'TrackStartError') {
                return '摄像头可能被其它应用占用，请关闭其它应用后重试';
            }
            if (name === 'OverconstrainedError') {
                return '摄像头不支持所请求的参数';
            }
            return (e && e.message) || '无法访问摄像头/麦克风';
        },

        /**
         * 重新尝试获取本地媒体。
         *
         * 用户去系统设置里放开权限后回到页面，这就是重试入口。
         * 不影响已建立的连接与正在同步的播放进度。
         */
        async retryMedia() {
            if (this.localStream) {
                this.updateLocalBadge();
                return true;
            }
            return this.startMedia();
        },

        /**
         * 开始采集本地音视频并推送给所有对端。
         *
         * 这是「开启视频通话」的入口。与信令解耦 —— 信令早在组件挂载时
         * 就连上了，这里只负责动摄像头/麦克风。
         */
        async startMedia() {
            if (this.localStream) {
                this.updateLocalBadge();
                return true;
            }

            /*
             * 重入保护。
             *
             * 「开启视频通话」有两条触发路径：conf.mediaOn 变化（onConfigChange）
             * 与 startmedia 指令（onCommandChange）。两者可能在同一帧内先后到达
             * （页面既改 prop 又发指令）。没有这道闸门时，第二次调用会看到
             * localStream 仍为 null（第一次还在 await 取流），于是并发发起
             * 第二次 getUserMedia —— 拿到两条流，后一条覆盖前一条，
             * 前一条的轨道**永不释放**，摄像头指示灯一直亮着。
             *
             * 用一个在飞的 Promise 让后来者复用同一次结果。
             */
            if (this.mediaTask) return this.mediaTask;

            // 本次是「开启」，清掉上一次可能的取消标记
            this.mediaCancelled = false;

            const task = this.doStartMedia().finally(() => {
                /*
                 * 只清**自己**那一份句柄。
                 *
                 * 无条件 `this.mediaTask = null` 有竞态：若期间发生过
                 * stopMedia（句柄被置 null）又 startMedia（挂上新句柄），
                 * 旧任务的 finally 后到，就会把**新任务**的句柄抹掉 ——
                 * 于是重入保护失效，再来一次 startMedia 会并发发起第二次
                 * getUserMedia，又回到「两条流、前一条永不释放」。
                 */
                if (this.mediaTask === task) this.mediaTask = null;
            });
            this.mediaTask = task;
            return task;
        },

        /** 实际执行取流与装配。 */
        async doStartMedia() {
            try {
                const stream = await this.acquireLocal();

                /*
                 * 取流期间被要求停止 —— 立刻丢弃刚拿到的流。
                 *
                 * 典型时序：用户点「开启通话」→ 取流要等权限弹窗（可能几秒）
                 * → 期间又点「挂断」。没有这道检查的话，await 返回后
                 * 照样 attachLocalStream，把刚关掉的摄像头**又打开**，
                 * 而且这次是「界面显示已挂断、指示灯却亮着」。
                 */
                if (this.mediaCancelled) {
                    console.log('[rtc] 取流完成时已被要求停止，丢弃该流');
                    try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* 忽略 */ }
                    return false;
                }

                await this.attachLocalStream(stream);

                const hasVideo = stream.getVideoTracks().length > 0;
                const hasAudio = stream.getAudioTracks().length > 0;
                console.log(`[rtc] startMedia 完成: 视频 ${hasVideo ? '有' : '无'} / 音频 ${hasAudio ? '有' : '无'}`);

                /*
                 * 摄像头没拿到时明确告警。
                 *
                 * 这是「电话能打通、就是没画面」的直接原因 ——
                 * 降级成纯音频后通话照常工作，用户只能看到黑屏，
                 * 没有任何报错。这里把情况说清楚，便于对端提示
                 * 「对方未开启摄像头」而不是傻等画面。
                 */
                if (!hasVideo) {
                    console.warn('[rtc] 未取得视频轨，本次通话为纯音频（对端看不到你的画面）');
                }

                this.mediaReady = true;
                this.emit('localready', {
                    media: true,
                    hasVideo,
                    hasAudio,
                    // 供页面区分「正常」与「已降级为纯音频」
                    videoDropped: !hasVideo && hasAudio
                });
                return true;
            } catch (e) {
                this.reportMediaFailure(e);
                return false;
            }
        },

        /**
         * 停止采集并释放设备（挂断）。
         *
         * **只停媒体，不断信令** —— 房间同步要继续工作。
         * 真正断开信令由 cleanup 负责（离开页面时）。
         */
        stopMedia() {
            /*
             * 置取消标记：取流途中被停掉时，让 doStartMedia 丢弃结果。
             *
             * 必须在最前面 —— 下面 localStream 为 null 时（取流还没回来）
             * 整个 if 块会被跳过，标记若不先置上，那条在飞的取流就没人拦得住。
             */
            this.mediaCancelled = true;

            /*
             * 清掉在飞任务句柄。
             *
             * 不清的话，紧接着的 startMedia 会命中
             * `if (this.mediaTask) return this.mediaTask`，直接把**已取消的
             * 旧任务**返回给调用方 —— 看起来「开启了」，实际什么都没做，
             * 摄像头永远起不来。必须让下一轮重新发起真正的取流。
             *
             * 只置 null，不 await 旧任务：旧任务靠 mediaCancelled 自行丢弃流，
             * 在这里等待它反而会拖住「挂断」这个应当立即生效的动作。
             */
            this.mediaTask = null;

            if (this.localStream) {
                // 先解除各对端发送的轨道，避免对端画面停在最后一帧
                for (const sid of Object.keys(this.peers)) {
                    const peer = this.peers[sid];
                    if (!peer || typeof peer.getTransceivers !== 'function') continue;
                    for (const t of peer.getTransceivers()) {
                        if (t.sender) {
                            try { t.sender.replaceTrack(null); } catch (e) { /* 忽略 */ }
                        }
                    }
                }

                this.localStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) { /* 忽略 */ }
                });
                this.localStream = null;
            }
            if (this.localVideoEl) this.localVideoEl.srcObject = null;
            this.updateLocalBadge();
            this.emit('localready', { media: false, hasVideo: false, hasAudio: false });
        },

        async connectSignal() {
            const io = await this.loadSocketIO();
            if (!io) throw new Error('socket.io 未就绪');

            /*
             * 房间号可能尚未同步过来，等它就绪（见 waitRoomId）。
             *
             * 拿到后**存成实例字段**而不是每次读 conf.roomId：
             * renderjs 的 conf 可能在后续同步中被覆盖成空值，
             * 而房间号是整个会话期间不变的基准。
             */
            const roomId = await this.waitRoomId();
            if (!roomId) throw new Error('缺少房间号');
            this.roomIdFixed = roomId;

            this.socket = io(SIGNAL_URL, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                timeout: 12000
            });

            const socket = this.socket;

            socket.on('connect', () => {
                this.setStatus('connected');
                // 关键：discover 的载荷必须是**房间名字符串**
                this.discover();
                // 定时 rediscover，发现中途加入的成员（服务端无成员变更推送）
                this.startRediscover();
            });

            socket.on('simple-signal[discover]', payload => {
                this.onDiscover(payload);
            });

            socket.on('simple-signal[offer]', payload => {
                this.onOffer(payload);
            });

            socket.on('simple-signal[signal]', payload => {
                this.onSignal(payload);
            });

            socket.on('simple-signal[reject]', d => {
                this.emit('rejected', d);
            });

            socket.on('connect_error', e => {
                this.emit('error', { message: '信令连接失败：' + (e && e.message) });
            });

            socket.on('disconnect', () => {
                this.setStatus('connecting');
            });
        },

        /** 本次会话的房间名（conf.roomId 落定后固化的值）。 */
        roomName() {
            return this.roomIdFixed || (this.conf && this.conf.roomId) || '';
        },

        discover() {
            if (this.socket && this.socket.connected) {
                // 必须传字符串（房间名）
                this.socket.emit(EV.discover, this.roomName());
            }
        },

        startRediscover() {
            this.stopRediscover();
            this.rediscoverTimer = setInterval(() => {
                this.discover();

                /*
                 * 顺带刷新等待提示。
                 *
                 * 注意：这里必须调**已存在**的方法。早先写的是
                 * `this.updateWaitHint()` —— 该方法在本组件里从未定义，
                 * 于是每 3 秒（REDISCOVER_INTERVAL）就抛一次 TypeError。
                 * 这个定时器是「发现中途加入的成员」的唯一途径，
                 * 它一抛错，配对就再也建立不起来 ——
                 * 表现为「两人都在房间、界面却始终显示等待对方接入」。
                 */
                this.updateNameBadges();
            }, REDISCOVER_INTERVAL);
        },

        stopRediscover() {
            if (this.rediscoverTimer) {
                clearInterval(this.rediscoverTimer);
                this.rediscoverTimer = null;
            }
        },

        /* ---------------- 信令处理 ---------------- */

        /**
         * 收到成员列表。
         *
         * 多人（mesh）下的连线规则：
         *   每个成员都要与其他人各建一条连接，共 N×(N-1)/2 条。
         *   为避免同一对双方同时发 offer 撞车，用 socket.id 字典序裁定：
         *   **id 较小的一方发起**，另一方只等待。
         *
         * 兜底：等待方在超时后若仍未收到 offer，会补发一次 ——
         * 否则对方的 offer 一旦丢失（源站限流、瞬断），这对连接就永远建不起来。
         */
        onDiscover({ id, discoveryData }) {
            const myId = id || (this.socket && this.socket.id);
            const list = (discoveryData && discoveryData.peers) || [];

            for (const peerId of list) {
                if (!peerId || peerId === myId) continue;
                // 已连上或已在协商中，跳过
                if (this.connectedIds[peerId]) continue;
                // 防止同一轮里对同一人重复发起
                if (this.peers && Object.values(this.peers).some(p => p._remoteId === peerId)) continue;

                if (String(myId) < String(peerId)) {
                    // 我 id 较小：由我发起
                    this.connectedIds[peerId] = 'pending';
                    this.createPeer(peerId, true);
                } else {
                    /*
                     * 我是较大的一方：正常应等对方发起，这里记待定标记。
                     *
                     * 兜底定时器**必须可取消** —— 旧实现是一个裸 setTimeout，
                     * 即便对方的 offer 早就到了、连接也已建立，它仍会在 4 秒后
                     * 触发并再发起一次 offer，形成 glare（两条 offer 互相打架）。
                     * 两人时这个窗口很短、不易撞上；三人及以上时每条连接都挂
                     * 一个定时器，误触发概率成倍上升，表现为「有人连上又断」。
                     *
                     * 因此：offer 一到就清掉它（见 onOffer），
                     * 触发时也再校验一次当前状态。
                     */
                    this.connectedIds[peerId] = 'waiting';
                    this.armFallbackOffer(peerId);
                }
            }
        },

        /**
         * 给「等待对方发起」的连接挂一个可取消的兜底发起。
         *
         * 只有在这段时间内**完全没收到对方 offer** 时才补发，
         * 否则就是多余的第二次 offer。
         */
        armFallbackOffer(peerId) {
            this.clearFallbackOffer(peerId);

            this.fallbackTimers[peerId] = setTimeout(() => {
                delete this.fallbackTimers[peerId];
                if (this.destroyed) return;

                // 期间已收到 offer / 已在协商 / 已连上 —— 不需要补发
                if (this.connectedIds[peerId] !== 'waiting') return;
                if (this.peers && Object.values(this.peers).some(p => p._remoteId === peerId)) return;

                console.log('[rtc] 等待 offer 超时，补发起一次:', peerId.slice(0, 6));
                this.connectedIds[peerId] = 'pending';
                this.createPeer(peerId, true);
            }, FALLBACK_OFFER_DELAY);
        },

        /** 取消某个对端的兜底发起（收到 offer / 已连上时调用）。 */
        clearFallbackOffer(peerId) {
            const t = this.fallbackTimers && this.fallbackTimers[peerId];
            if (t) {
                clearTimeout(t);
                delete this.fallbackTimers[peerId];
            }
        },

        /** 收到对方 offer。 */
        async onOffer({ initiator, sessionId, signal, metadata }) {
            // 对方的名字随 offer 的 metadata 送来
            this.rememberPeerName(initiator, metadata);

            // offer 已到，兜底发起不再需要
            this.clearFallbackOffer(initiator);

            /*
             * 已经连上了还收到 offer —— 迟到或重复的消息，直接忽略。
             *
             * 这不是 glare（glare 是双方都没连上时的对撞）。走到这里说明
             * 双方已有可用连接，若再走一遍 setRemoteDescription + createAnswer，
             * 会把正在工作的连接重协商掉，画面闪断。
             */
            const live = Object.values(this.peers).find(
                p => p._remoteId === initiator && p.connectionState === 'connected'
            );
            if (live) {
                console.log('[rtc] 已有可用连接，忽略重复 offer:', initiator.slice(0, 6));
                return;
            }

            /*
             * glare 裁定：双方可能同时发起。
             *
             * 场景：A 与 B 同时入房，rediscover 让双方都看到对方，
             * 各自都判定「我该发起」（或兜底定时器误触发），于是两条
             * offer 同时存在。若不处理，双方会各自为对方建一个 peer，
             * 变成 4 个 PeerConnection 抢同一条链路 —— 常见后果是
             * 两条都停在 connecting，或画面反复闪断。
             *
             * 裁定规则与 onDiscover 保持一致：**socket.id 字典序小的一方胜**。
             * 双方用同一规则、同一份数据判断，结论必然一致，不会出现
             * 「两边都退让」或「两边都坚持」。
             */
            const mine = Object.values(this.peers).find(
                p => p._remoteId === initiator && p._initiator
            );
            if (mine && this.socket && this.socket.id) {
                const myId = this.socket.id;
                if (String(myId) < String(initiator)) {
                    /*
                     * 我 id 较小：由我发起更优，忽略这条 offer。
                     *
                     * 注意**不能**把 connectedIds[initiator] 置成 'answering'——
                     * 那会让 onDiscover 的「已有标记就跳过」永久生效，
                     * 我这条发起一旦失败，这个对端就再也连不上。
                     * 保持 'pending' 即可（我本来就是发起方）。
                     *
                     * 对方会发 offer，只有一种可能：他那边「等待对方发起」的
                     * 兜底超时了 —— 也就是**我先前那条 offer 他没收到**。
                     * 因此这里必须重发一次，否则双方都在等对方：我等他 answer，
                     * 他等我 offer，直到 15 秒连接超时才靠 rediscover 自愈。
                     */
                    console.log('[rtc] glare：我 id 较小，忽略对方 offer 并重发自己的', initiator.slice(0, 6));
                    this.sendOffer(mine);
                    return;
                }
                // 对方 id 较小：放弃我这条，改应答对方
                console.log('[rtc] glare：对方 id 较小，放弃本地发起', initiator.slice(0, 6));
                this.dropPeer(mine._sid);
            }

            /*
             * 标记「已在应答中」，必须放在最前面。
             *
             * 置成非空值即可让 onDiscover 的 `if (this.connectedIds[peerId]) continue`
             * 跳过重复发起（该判断对任意非空值都成立）。
             */
            this.connectedIds[initiator] = 'answering';

            let peer = this.peers[sessionId];
            if (!peer) {
                peer = this.createPeer(initiator, false, sessionId);
            }

            /*
             * 应答流程整体入队执行。
             *
             * 它包含 setRemoteDescription + createAnswer + setLocalDescription，
             * 是一串改状态机的操作 —— 必须与同时到达的 candidate/answer 串行，
             * 否则并发调用会抛「Called in wrong state」。
             */
            await this.runOnPeer(peer, () => this.answerOffer(peer, signal, initiator, sessionId));
        },

        /**
         * 应答一条 offer（纯执行函数，由 runOnPeer 串行化后调用）。
         *
         * 拆出来是为了避免在队列内部再入队（自我等待会死锁）。
         */
        async answerOffer(peer, signal, initiator, sessionId) {
            try {
                /*
                 * 已在处理同一条连接的远端 offer 时，重复的 offer 只认最新一条。
                 *
                 * 对方兜底重发会带来第二条 offer；若直接 setRemoteDescription，
                 * 在 have-remote-offer 状态下会抛错。这里显式跳过，
                 * 因为连接本身没问题 —— 只是对方重复发了。
                 */
                if (peer.remoteDescription && peer.remoteDescription.type === 'offer'
                    && peer.signalingState === 'have-remote-offer') {
                    console.log('[rtc] 已在处理 offer，忽略重复的一条');
                    return;
                }

                await peer.setRemoteDescription(signal);

                /*
                 * 描述就绪后**先提方向、再补轨道**。
                 *
                 * 应答方的 transceiver 由对方 offer 创建，默认 `recvonly`；
                 * 不提升方向，答案里那一行就只收不发，本端画面永远出不去
                 * （详见 promoteSendRecv 的说明）。
                 *
                 * 另外 setRemoteDescription 之前 getTransceivers() 还是空的，
                 * 提前调 applyLocalTracksToPeer 什么也填不进去。
                 */
                this.promoteSendRecv(peer);
                /*
                 * 直接调 doApplyTracks，**不再走 applyLocalTracksToPeer**。
                 * 本函数（answerOffer）已经在该 peer 的操作队列里，
                 * 再入队会等待自己前面的任务 —— 也就是当前这个任务，直接死锁。
                 */
                if (this.localStream) await this.doApplyTracks(peer);

                // 补投在 offer 之前就到了的候选
                const pending = peer._pendingCandidates.splice(0);
                for (const c of pending) {
                    try {
                        await peer.addIceCandidate(c);
                    } catch (e) { /* 忽略 */ }
                }

                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                if (!this.socket) return;
                this.socket.emit(EV.signal, {
                    signal: { type: answer.type, sdp: answer.sdp },
                    // 应答也带上自己的名字，否则发起方拿不到对方昵称
                    metadata: { name: this.conf.displayName || '' },
                    sessionId,
                    target: initiator
                });
            } catch (e) {
                /*
                 * 应答失败同样要丢掉这条连接。
                 *
                 * 半成品 peer 留在表里，onDiscover 会判定「已有该对端的连接」
                 * 而不再尝试，双方就此长期黑屏。丢掉后由 rediscover 重来。
                 */
                console.error('[rtc] 应答失败:', (e && e.message) || e);
                this.emit('error', { message: '应答失败：' + (e && e.message) });
                this.dropPeer(sessionId);
            }
        },

        /**
         * 记录对端昵称并上报给父组件。
         *
         * 名字可能在 offer 或 answer 任一方向送达，故两处都调；
         * 只有真正变化时才 emit，避免重复渲染。
         */
        rememberPeerName(peerId, metadata) {
            const name = (metadata && metadata.name) || '';
            if (!peerId || !name) return;
            if (this.peerNames[peerId] === name) return;
            this.peerNames[peerId] = name;
            this.emit('peername', { id: peerId, name });
            this.updateNameBadges();
            // 名单里用的是昵称，名字变了要重新上报
            this.reportPeers();
        },

        /** 收到 answer 或 ICE 候选。 */
        async onSignal({ sessionId, signal, metadata }) {
            const peer = this.peers[sessionId];

            /*
             * peer 还没建好 —— 先暂存，绝不能丢。
             *
             * 候选/answer 与 offer 走两条独立通道，网络快时前者会先到。
             * 旧实现直接 `if (!peer) return`，这条连接的候选就此残缺，
             * 只能等 ICE 超时（三人及以上并发协商时尤其常见）。
             *
             * 暂存后由 createPeer 调 flushEarlySignals 补投。
             */
            if (!peer) {
                if (!this.earlySignals[sessionId]) this.earlySignals[sessionId] = [];
                // 上限保护：异常对端狂发候选时不让它无限堆积
                if (this.earlySignals[sessionId].length < 200) {
                    this.earlySignals[sessionId].push({ signal, metadata });
                    console.log('[rtc] 信令早到，暂存待补投:', sessionId.slice(0, 6));
                }
                return;
            }

            await this.runOnPeer(peer, () => this.applySignal(peer, signal, metadata));
        },

        /**
         * 把单条信令应用到某个 peer。
         *
         * 抽出来是为了让「正常路径」与「早到补投」共用同一套处理逻辑 ——
         * 两处各写一份必然走偏。
         *
         * 纯执行函数：**不自己入队**，由调用方决定是否包 runOnPeer。
         */
        async applySignal(peer, signal, metadata) {
            if (!peer || !signal) return;

            // 候选：远端描述未就绪时必须先缓存，否则 addIceCandidate 会抛错
            if (signal.candidate) {
                if (!peer.remoteDescription || !peer.remoteDescription.type) {
                    peer._pendingCandidates.push(signal.candidate);
                    return;
                }
                try {
                    await peer.addIceCandidate(signal.candidate);
                } catch (e) {
                    /* 重复候选等异常可忽略 */
                }
                return;
            }

            if (signal.type === 'answer') {
                /*
                 * answer 到达时本端必须已经 setLocalDescription(offer)。
                 *
                 * 早到补投场景下可能还没走到那一步（flushEarlySignals 在
                 * createPeer 末尾就跑了，而 offer 是在其后的异步块里创建）——
                 * 此时 setRemoteDescription(answer) 会抛
                 * 「Failed to set remote answer sdp: Called in wrong state」。
                 * 因此先存起来，等 offer 落地后由 setLocalDescription 之后补投。
                 */
                if (!peer.localDescription || !peer.localDescription.type) {
                    peer._pendingAnswer = signal;
                    console.log('[rtc] answer 早于本地 offer，暂存待补投');
                    return;
                }

                // 应答方的名字随 answer 送达
                this.rememberPeerName(peer._remoteId, metadata);
                try {
                    await peer.setRemoteDescription(signal);
                    // 描述就绪后补投之前缓存的候选
                    const pending = peer._pendingCandidates.splice(0);
                    for (const c of pending) {
                        try {
                            await peer.addIceCandidate(c);
                        } catch (e) { /* 忽略单个候选失败 */ }
                    }
                } catch (e) {
                    this.emit('error', { message: '协商失败：' + (e && e.message) });
                }
            }
        },

        /**
         * 本地 offer 落地后，补投此前早到的 answer（若有）。
         *
         * 与 _pendingCandidates 是同一个思路：把「先到的那条」留住，
         * 等本端状态就绪再应用。
         *
         * ⚠️ 只在 `doOffer` 内部（即已处于该 peer 的操作队列中）调用，
         * 因此这里**直接调 applySignal，不再 runOnPeer** —— 再次入队会
         * 等待自己前面的任务完成，而当前任务正是它等待的那个，直接死锁。
         */
        async flushPendingAnswer(peer) {
            const ans = peer && peer._pendingAnswer;
            if (!ans) return;
            peer._pendingAnswer = null;
            console.log('[rtc] 补投早到的 answer');
            await this.applySignal(peer, ans, null);
        },

        /** 补投某个 peer 建好之前就到的那批信令。 */
        async flushEarlySignals(sid) {
            const queued = this.earlySignals[sid];
            if (!queued || !queued.length) return;
            delete this.earlySignals[sid];

            const peer = this.peers[sid];
            if (!peer) return;

            console.log(`[rtc] 补投早到信令 ${queued.length} 条:`, sid.slice(0, 6));

            /*
             * **整批**入队，而不是逐条 runOnPeer。
             *
             * 逐条的话，每次 await 之间别的操作（比如紧随其后的 sendOffer）
             * 会插到队列中间，补投顺序被打乱；整批包成一个任务则保持
             * 「这一批按到达顺序连续处理」的语义。
             */
            await this.runOnPeer(peer, async () => {
                for (const item of queued) {
                    await this.applySignal(peer, item.signal, item.metadata);
                }
            });
        },

        /**
         * 创建 RTCPeerConnection。
         *
         * @param remoteId  对端 socket id
         * @param initiator 是否由本端发起
         * @param sessionId 已有会话 id（应答方沿用对方的）
         */
        createPeer(remoteId, initiator, sessionId) {
            const sid = sessionId || ('s' + Math.random().toString(36).slice(2, 10));
            const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            this.peers[sid] = peer;
            peer._remoteId = remoteId;
            peer._sid = sid;
            /** 本端是否这条连接的发起方（glare 裁定时要据此找出自己发起的连接）。 */
            peer._initiator = !!initiator;
            /**
             * 远端描述就绪前收到的 ICE 候选。
             *
             * 候选与 SDP 是两条独立通道，网络快时候选会先到；
             * 此时 addIceCandidate 会抛错，必须先存起来、等
             * setRemoteDescription 之后再补投。
             */
            peer._pendingCandidates = [];

            /**
             * 早于本端 localDescription 到达的 answer。
             *
             * 见 applySignal 里对 answer 的处理：早到补投时本端可能还没
             * setLocalDescription(offer)，直接应用会抛错，故先存这里。
             */
            peer._pendingAnswer = null;

            /*
             * 数据通道：用来传播放进度等小消息。
             * 由发起方建立（onnegotiationneeded 在某些机型上不稳定，
             * 显式 createDataChannel 更可靠）。
             */
            if (initiator) {
                try {
                    this.setupDataChannel(peer.createDataChannel('yinghua-sync', { ordered: true }), peer);
                } catch (e) {
                    /* 数据通道失败不影响通话 */
                }
            }
            peer.ondatachannel = e => {
                this.setupDataChannel(e.channel, peer);
            };

            /*
             * 先声明收发方向，再填本地轨道。
             *
             * 顺序很关键：若此时还没有本地流（信令先行、摄像头失败或后到），
             * 没有 transceiver 的 SDP 里就不会有 audio/video 的 m 行，
             * 对方即便开了摄像头也推不过来 —— 表现为单向黑屏。
             * 预声明之后，媒体可以随时用 replaceTrack 补进来。
             *
             * 只有发起方需要预声明：应答方的 m 行来自对方的 offer，
             * 在 setRemoteDescription 之后自然就有 transceiver 了
             * （见 onOffer 里的补轨道）。
             */
            if (initiator) {
                this.ensureTransceivers(peer);
                /*
                 * 装配本地轨道。
                 *
                 * 走 runOnPeer 入队（而非直接调 doApplyTracks）：
                 * 队列保证「先装轨道、再生成 offer」的顺序 —— 若不入队，
                 * 这里未 await 的 replaceTrack 会与随后入队的 sendOffer
                 * 并发，offer 生成时 sender 上可能还没有轨道，
                 * 对端首帧就是黑的。
                 *
                 * 调用顺序上它排在 flushEarlySignals / sendOffer 之前
                 * （见本函数末尾），因此队列里的执行顺序也正确。
                 */
                if (this.localStream) this.applyLocalTracksToPeer(peer);
            }

            // ICE 候选：边收集边发（trickle）
            peer.onicecandidate = e => {
                if (e.candidate && this.socket) {
                    this.socket.emit(EV.signal, {
                        signal: { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate },
                        metadata: {},
                        sessionId: sid,
                        target: remoteId
                    });
                }
            };

            /*
             * 远端轨道到达：为这个对端挂上画面。
             *
             * ⚠️ 不能依赖 `e.streams[0]`。
             *
             * 本组件用 `replaceTrack` 装配轨道（见 applyLocalTracksToPeer），
             * 而 replaceTrack **不会把轨道绑定到某个 MediaStream** ——
             * 因此对端 ontrack 触发时 `e.streams` 往往是**空数组**。
             * 早先直接 `if (!stream) return;`，等于把画面全丢了：
             * 连接正常、音频正常（音频轨也走同一条路），
             * 但视频画面永远挂不上，且没有任何报错。
             *
             * 正确做法：streams 为空时自己建一个 MediaStream
             * 把轨道加进去，再交给 video 元素播放。
             */
            peer.ontrack = e => {
                const kind = (e.track && e.track.kind) || '?';
                console.log(`[rtc] 收到远端轨道: ${kind}`, 'streams:', (e.streams || []).length);

                const tile = this.ensureTile(remoteId);
                if (!tile) {
                    console.warn('[rtc] 远端轨道到达但 tile 创建失败');
                    return;
                }

                // 优先用内核给的 stream；没有就自己攒一个
                let stream = e.streams && e.streams[0];
                if (!stream) {
                    // 复用已建的容器流，避免每条轨道各建一个导致后到的覆盖先到的
                    if (!tile._stream) tile._stream = new MediaStream();
                    stream = tile._stream;
                    if (e.track && !stream.getTracks().includes(e.track)) {
                        stream.addTrack(e.track);
                    }
                }

                if (tile.video.srcObject !== stream) {
                    tile.video.srcObject = stream;
                }
                // 无论 srcObject 是否变化都要尝试播放：轨道后到时
                // video 已存在但可能仍处于暂停态
                tile.video.play().catch(err => {
                    console.warn('[rtc] 远端画面播放被拦:', (err && err.message) || err);
                });
                this.watchRemoteTracks(remoteId, stream);
            };

            // 连接状态
            peer.onconnectionstatechange = () => {
                const st = peer.connectionState;
                if (st === 'connected') {
                    // 连上即撤销所有待触发的清理定时器
                    this.clearConnectTimer(sid);
                    this.clearRecoverTimer(sid);

                    this.connectedIds[remoteId] = 'ok';
                    this.emit('remote', true);
                    this.reportPeers();
                    // 连上就建格，先占位后填流 —— 否则对方没开摄像头时一片空白
                    this.ensureTile(remoteId);
                    this.syncGridLayout();
                    if (this.waitEl) this.waitEl.classList.add('is-hidden');
                } else if (st === 'failed' || st === 'closed') {
                    /*
                     * 连接彻底失效：整条清掉，并**允许后续重新建连**。
                     *
                     * 旧实现只删 connectedIds 与画面格，peers/channels 里的
                     * 死连接却留着 —— 于是 onDiscover 的
                     * 「已存在同 remoteId 的 peer 就跳过」永远成立，
                     * 这个对端再也连不回来（表现为「有人退出后重进，别人看不到他」）。
                     */
                    this.dropPeer(sid);

                    /*
                     * 多人场景：一条连接断开不代表「所有人都走了」，
                     * 只有再没有任何 connected 的对端时才算全部离开。
                     */
                    const stillAlive = Object.values(this.peers).some(
                        p => p.connectionState === 'connected'
                    );
                    if (!stillAlive) {
                        this.emit('remote', false);
                        if (this.waitEl) this.waitEl.classList.remove('is-hidden');
                    }
                } else if (st === 'disconnected') {
                    /*
                     * disconnected 是**可自愈**的瞬时状态（网络抖动、切前后台），
                     * 内核通常能自行恢复。这里先摘掉「已连上」标记，
                     * 免得同步/人数统计把它算作在线；但不清连接。
                     *
                     * 同时挂一个兜底：部分内核不会把它推进到 failed，
                     * 会长期停在 disconnected —— 那这条连接其实已经废了，
                     * 不清理就再也重建不起来。超时后仍未恢复即按失效处理。
                     */
                    if (this.connectedIds[remoteId] === 'ok') {
                        delete this.connectedIds[remoteId];
                        this.reportPeers();
                    }

                    /*
                     * 兜底定时器**先清后挂**，避免状态抖动时累积。
                     *
                     * disconnected 可能来回跳变（抖一下断、又恢复），
                     * 每跳一次就挂一个 8 秒定时器的话，会同时存在多个；
                     * 它们各自触发时都要重新判断状态，白白多跑。
                     * 用同一张表记账，保证一个对端最多只有一个在飞。
                     */
                    this.clearRecoverTimer(sid);
                    this.recoverTimers[sid] = setTimeout(() => {
                        delete this.recoverTimers[sid];
                        if (this.destroyed) return;
                        if (this.peers[sid] !== peer) return;
                        if (peer.connectionState === 'disconnected') {
                            console.warn('[rtc] 连接长时间未恢复，按失效处理:', sid.slice(0, 6));
                            this.dropPeer(sid);
                        }
                    }, RECOVER_TIMEOUT);
                }
            };

            /*
             * 先补投这条连接建好之前就到的那批信令，**再发 offer**。
             *
             * 顺序很关键：早到的 answer 在此时 localDescription 还是空的，
             * 会被 applySignal 存进 _pendingAnswer，随后由 doOffer 里
             * setLocalDescription 之后的 flushPendingAnswer 正确补投。
             * 若反过来先发 offer，补投的 answer 会直接撞进 setRemoteDescription，
             * 走上一条依赖运行时状态判断的脆弱路径。
             *
             * 两者都经 runOnPeer 入队，因此实际执行顺序与调用顺序一致。
             */
            this.flushEarlySignals(sid);

            // 发起方：创建 offer（首帧 offer 走 offer 事件，其余走 signal）
            if (initiator) {
                this.sendOffer(peer);
            }

            return peer;
        },

        /**
         * 创建并发出 offer。
         *
         * 抽成方法是为了让「首次发起」与「glare 后重发」共用同一套逻辑 ——
         * 重发时若漏掉 setLocalDescription 或漏发，双方就会互相等对方到超时。
         *
         * 入队执行：createOffer / setLocalDescription / flushPendingAnswer
         * 都在改状态机，必须与同时到达的信令串行。
         */
        sendOffer(peer) {
            return this.runOnPeer(peer, () => this.doOffer(peer));
        },

        /** 真正创建并发出 offer（纯执行函数）。 */
        async doOffer(peer) {
            if (!peer || this.destroyed) return;
            try {
                const offer = await peer.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                });
                await peer.setLocalDescription(offer);

                /*
                 * offer 落地后立刻补投早到的 answer。
                 *
                 * 对方可能已经回包，而回包因本端尚无 localDescription
                 * 被暂存在 _pendingAnswer 里。
                 */
                await this.flushPendingAnswer(peer);

                if (!this.socket) return;
                this.socket.emit(EV.offer, {
                    signal: { type: offer.type, sdp: offer.sdp },
                    metadata: { name: this.conf.displayName || '' },
                    sessionId: peer._sid,
                    target: peer._remoteId
                });
                this.startConnectTimer(peer._sid);
            } catch (e) {
                /*
                 * 发起失败要**把这条连接整个丢掉**。
                 *
                 * 只报错不清理的话，connectedIds[remoteId] 会停在
                 * 'pending'，而 onDiscover 看到非空值就跳过 ——
                 * 这个对端再也不会被重新发起（表现为「某人一直看不到画面」）。
                 * 丢掉之后下一轮 rediscover 会重新裁定并建连。
                 */
                console.error('[rtc] 发起 offer 失败:', (e && e.message) || e);
                this.emit('error', { message: '发起通话失败：' + (e && e.message) });
                this.dropPeer(peer._sid);
            }
        },

        /**
         * 彻底丢弃一条连接。
         *
         * 必须把 peers / channels / connectedIds / 画面格 / 兜底定时器
         * **一起**清掉，任何一处残留都会让该对端无法重新建连：
         *   · peers 残留 → onDiscover 判定「已有该对端的连接」而跳过
         *   · channels 残留 → broadcast 会往死通道发，永远 sent=0
         *   · connectedIds 残留 → 该对端被算作在线，人数虚高
         */
        dropPeer(sid) {
            const peer = this.peers[sid];
            const remoteId = peer && peer._remoteId;

            /*
             * **先摘除，再 close** —— 顺序不能反。
             *
             * `peer.close()` 会**同步**把 connectionState 置为 'closed' 并触发
             * onconnectionstatechange，而那个回调又会调 dropPeer(sid)。
             * 若此时 peers[sid] 还在，就会无限递归（栈溢出直接崩掉 renderjs）。
             * 先 delete 之后，重入的那次拿不到 peer，走空路径安全返回。
             */
            delete this.peers[sid];
            if (peer) {
                try { peer.close(); } catch (e) { /* 忽略 */ }
            }

            delete this.channels[sid];
            delete this.earlySignals[sid];
            // 连接已丢，超时定时器必须一并取消（成熟库 _closePeer 同样如此）
            this.clearConnectTimer(sid);
            this.clearRecoverTimer(sid);

            if (remoteId) {
                delete this.connectedIds[remoteId];
                this.clearFallbackOffer(remoteId);
                this.removeTile(remoteId);
            }

            this.reportPeers();
            this.syncGridLayout();
        },

        /**
         * 连接超时保护：迟迟连不上就整条清掉，交给下一轮 discover 重建。
         *
         * 定时器**按 sessionId 记账**（见 connectTimers），重复调用会先清旧的。
         * 成熟库（simple-signal-client）同样用 `_timers` Map + `_clearTimer`
         * 管理 —— 裸 setTimeout 在重发/重连场景会累积出多个定时器，
         * 各自在 15 秒后触发，把已经重建好的连接误清掉。
         */
        startConnectTimer(sid) {
            const peer = this.peers[sid];
            if (!peer) return;

            this.clearConnectTimer(sid);

            this.connectTimers[sid] = setTimeout(() => {
                delete this.connectTimers[sid];
                if (this.destroyed) return;
                // 这条连接已被替换或清理，什么都不做
                if (this.peers[sid] !== peer) return;
                if (peer.connectionState === 'connected') return;

                /*
                 * 超时未连上：**必须整条清掉**，不能只删 connectedIds。
                 *
                 * 只删标记的话，peers 里那条死连接还在，onDiscover 的
                 * 「已有同 remoteId 的 peer 就跳过」永远成立 ——
                 * 这个对端再也连不回来。清掉之后，下一轮 rediscover（3 秒）
                 * 会重新按字典序裁定并建连，形成自愈。
                 */
                console.warn('[rtc] 连接超时未建立，清理后待重连:', sid.slice(0, 6));
                this.dropPeer(sid);
            }, CONNECT_TIMEOUT);
        },

        /** 取消某个 sessionId 的连接超时定时器。 */
        clearConnectTimer(sid) {
            const t = this.connectTimers && this.connectTimers[sid];
            if (t) {
                clearTimeout(t);
                delete this.connectTimers[sid];
            }
        },

        /** 取消某个 sessionId 的 disconnected 恢复兜底定时器。 */
        clearRecoverTimer(sid) {
            const t = this.recoverTimers && this.recoverTimers[sid];
            if (t) {
                clearTimeout(t);
                delete this.recoverTimers[sid];
            }
        },

        /* ---------------- 数据通道（播放同步） ---------------- */

        /**
         * 绑定数据通道。
         *
         * 目前只用于传播放状态；用 JSON 文本，便于调试与向后兼容。
         */
        setupDataChannel(channel, peer) {
            this.channels = this.channels || {};
            this.channels[peer._sid] = channel;

            channel.onopen = () => {
                this.emit('channel', { open: true });
            };
            channel.onmessage = e => {
                let msg = null;
                try {
                    msg = JSON.parse(e.data);
                } catch (err) {
                    return;
                }
                this.emit('message', msg);
            };
            channel.onclose = () => {
                delete this.channels[peer._sid];

                /*
                 * 同步摘掉「已连上」标记。
                 *
                 * dataChannel 关闭说明这条链路已经不能传消息了，但
                 * PeerConnection 的 connectionState 未必立刻变 —— 不同步的话
                 * 人数与同步状态会虚高（显示「3 人同看」实际只剩 2 人）。
                 * 真正失效仍由 onconnectionstatechange 走 dropPeer 收尾。
                 */
                if (peer._remoteId && this.connectedIds[peer._remoteId] === 'ok') {
                    delete this.connectedIds[peer._remoteId];
                    this.reportPeers();
                }
            };
            channel.onerror = () => { /* 忽略 */ };
        },

        /**
         * 向所有已连接的对端广播一条消息。
         *
         * 播放同步、切集通知都走这里；父组件只关心消息体。
         *
         * 关键：**没有可用通道时要明确回报**。
         * 早先这里对空通道直接静默 return，于是「观众一直等待房主选片」
         * 这种故障在日志里没有任何痕迹 —— 分不清是消息没发出去、
         * 还是发出去但对方没处理。现在把发送结果回报给逻辑层，
         * 房主侧能据此看到「房间同步未建立」而不是毫无头绪。
         */
        broadcast(msg) {
            if (!this.channels) {
                this.emit('broadcastfail', { reason: 'nochannel' });
                return false;
            }

            let text = '';
            try {
                text = JSON.stringify(msg);
            } catch (e) {
                return false;
            }

            const sent = this.sendToChannels(text);
            if (sent > 0) return true;

            const sids = Object.keys(this.channels);

            /*
             * 一个通道都没有 —— 信令或建连还没起来，这是真问题。
             */
            if (!sids.length) {
                this.emit('broadcastfail', { reason: 'nochannel' });
                return false;
            }

            /*
             * 有通道但还在协商中（connecting）—— 这是**正常过渡态**。
             *
             * 对端刚接入时，connectionState 先变 connected、dataChannel 才
             * 随后 open，两者相隔可能几百毫秒。而房主的广播是 3 秒轮播，
             * 正好撞上这个窗口就会报一次「房间同步未建立」，
             * 紧接着又打「同步通道已打开」—— 用户看到提示闪一下，纯噪音。
             *
             * 处理：等一小会儿补发一次。成功就说明只是晚了，
             * 连首条消息都不会丢；仍失败才如实报警。
             */
            const connecting = sids.some(sid => {
                const ch = this.channels[sid];
                return ch && ch.readyState === 'connecting';
            });

            if (connecting) {
                setTimeout(() => {
                    if (this.destroyed) return;
                    if (this.sendToChannels(text) === 0) {
                        this.emit('broadcastfail', { reason: 'notopen' });
                    }
                }, 800);
                return false;
            }

            this.emit('broadcastfail', { reason: 'notopen' });
            return false;
        },

        /** 把一条已序列化的消息发往所有 open 的通道，返回成功条数。 */
        sendToChannels(text) {
            let sent = 0;
            for (const sid of Object.keys(this.channels || {})) {
                const ch = this.channels[sid];
                try {
                    if (ch && ch.readyState === 'open') {
                        ch.send(text);
                        sent += 1;
                    }
                } catch (e) { /* 忽略单个通道失败 */ }
            }
            return sent;
        },

        /** 广播播放状态（房主用）。 */
        broadcastState(state) {
            this.broadcast({ type: 'state', ...state });
        },

        /**
         * 广播播放倍速（房主用）。
         *
         * 倍速是「全体一致」的参数：观众各自调会让进度立刻错位，
         * 因此只认房主的值。
         */
        broadcastRate(rate) {
            this.broadcast({ type: 'rate', rate });
        },

        /* ---------------- 画面格子 ---------------- */

        /**
         * 取得（必要时创建）某个对端的画面格。
         *
         * 每个对端独立一格，因此多人也能同时看到 ——
         * 早先只用一个 video 元素，第二个人的流会直接顶掉第一个人。
         */
        ensureTile(peerId) {
            if (!this.gridEl || !peerId) return null;
            if (this.tiles[peerId]) return this.tiles[peerId];

            const wrap = document.createElement('div');
            wrap.className = 'rtc-tile';

            const video = document.createElement('video');
            video.setAttribute('playsinline', 'true');
            video.setAttribute('webkit-playsinline', 'true');
            video.autoplay = true;
            // 远端音频由这里播放，不能静音
            video.muted = false;
            wrap.appendChild(video);

            const tag = document.createElement('div');
            tag.className = 'rtc-tag';
            tag.textContent = this.peerNames[peerId] || '好友';
            wrap.appendChild(tag);

            this.gridEl.appendChild(wrap);
            this.tiles[peerId] = { wrap, video, tag };
            this.syncGridLayout();
            return this.tiles[peerId];
        },

        /** 移除某个对端的画面格并释放其流。 */
        removeTile(peerId) {
            const tile = this.tiles[peerId];
            if (!tile) return;

            /*
             * 先摘掉轨道监听再释放。
             *
             * `_redraw` 被挂在每条 track 的 mute/unmute/ended 上，不清掉的话
             * 该对端重新入房、轨道换新后，旧监听仍指向已移除的 DOM 节点 ——
             * 会在 track 事件里操作游离节点，是「重进房间后画面错乱」的来源之一。
             */
            if (tile._boundTracks) {
                for (const track of tile._boundTracks) {
                    try {
                        track.removeEventListener('mute', tile._redraw);
                        track.removeEventListener('unmute', tile._redraw);
                        track.removeEventListener('ended', tile._redraw);
                    } catch (e) { /* 忽略 */ }
                }
                tile._boundTracks.clear();
            }

            // 明确释放：不解除 srcObject 时 video 会一直持有 MediaStream
            try {
                tile.video.srcObject = null;
            } catch (e) { /* 忽略 */ }
            if (tile.wrap.parentNode) tile.wrap.parentNode.removeChild(tile.wrap);
            delete this.tiles[peerId];
        },

        /**
         * 按人数调整网格。
         *
         * 单人格铺满（此时网格只有一列），多人走 auto-fit 自动分列。
         */
        syncGridLayout() {
            if (!this.gridEl) return;
            const n = Object.keys(this.tiles).length;
            this.gridEl.classList.toggle('is-single', n <= 1);
            if (this.waitEl) this.waitEl.classList.toggle('is-hidden', n > 0);
        },

        /** 刷新本地小窗的昵称与摄像头状态。 */
        updateLocalBadge() {
            if (!this.localTagEl) return;
            const me = (this.conf && this.conf.displayName) || '我';
            const camOn = this.localStream
                ? this.localStream.getVideoTracks().some(t => t.enabled)
                : false;
            this.localTagEl.textContent = camOn ? `${me}（我）` : `${me}（我·摄像头关）`;
            this.localWrapEl && this.localWrapEl.classList.toggle('is-novideo', !camOn);
        },

        /**
         * 刷新某个对端的标签。
         *
         * 若该格已绑定轨道状态（关摄像头 / 静音），走它自己的重绘逻辑 ——
         * 否则这里直写 textContent 会把「（摄像头关）」后缀抹掉，
         * 两处标记互相打架。
         */
        updateTileTag(peerId, name) {
            const tile = this.tiles[peerId];
            if (!tile) return;
            if (typeof tile._redraw === 'function') {
                tile._redraw();
                return;
            }
            if (name) tile.tag.textContent = name;
        },

        /**
         * 监听远端轨道，反映对方的摄像头 / 麦克风开关。
         *
         * 对方关摄像头时，WebRTC 的 track 会变成 `muted`（而不是 ended），
         * 视频元素仍在但不再产出画面 —— 会显示为一片黑。
         * 这里据此打上状态类，用占位底色 + 文案替代黑屏，
         * 否则用户无法区分「对方关了摄像头」和「画面卡住了」。
         */
        watchRemoteTracks(peerId, stream) {
            const tile = this.tiles[peerId];
            if (!tile) return;

            /*
             * `_redraw` 只建一次，但**每次进来都要重新画**。
             *
             * 早先是 `if (tile._bound) return;` —— 第二次 ontrack
             * （视频轨比音频轨晚到时）会直接返回，于是：
             *   1. 新到的视频轨没有挂上 mute/unmute/ended 监听
             *   2. 画面状态不重绘，标签一直停在「（摄像头关）」
             * 而实际上视频已经在播了 —— 用户看到的是「有画面但标着摄像头关」，
             * 或更糟：标签与画面状态长期不一致。
             */
            if (!tile._redraw) {
                /*
                 * 从 video 元素的 srcObject 现读，而不是捕获入参 stream。
                 *
                 * 因为 `_redraw` 只建一次，若捕获首次的 stream，
                 * 之后重新协商换了新流，重绘读到的仍是旧流（永远是「摄像头关」）。
                 */
                tile._redraw = () => {
                    const cur = tile.video && tile.video.srcObject;
                    const cam = cur && cur.getVideoTracks ? cur.getVideoTracks()[0] : null;
                    const mic = cur && cur.getAudioTracks ? cur.getAudioTracks()[0] : null;
                    const camOff = !cam || cam.muted || cam.readyState === 'ended';
                    const micOff = !mic || mic.muted || mic.readyState === 'ended';

                    tile.wrap.classList.toggle('is-novideo', camOff);
                    const name = this.peerNames[peerId] || '好友';
                    tile.tag.textContent = camOff ? `${name}（摄像头关）` : name;
                    tile.tag.classList.toggle('is-muted', micOff);
                };
            }

            // 给**尚未绑定过**的轨道挂监听：晚到的新轨道同样要挂
            if (!tile._boundTracks) tile._boundTracks = new Set();
            for (const track of stream.getTracks()) {
                if (tile._boundTracks.has(track)) continue;
                tile._boundTracks.add(track);
                track.addEventListener('mute', tile._redraw);
                track.addEventListener('unmute', tile._redraw);
                track.addEventListener('ended', tile._redraw);
            }

            tile._redraw();
        },

        /** 上报当前连接情况给父组件。
         *
         * 多人观影时需要知道「现在房间里有几个人」——
         * 只报「有没有远端」在三人以上场景下信息不足。
         */
        reportPeers() {
            const names = Object.values(this.connectedIds).filter(v => v === 'ok').length;
            const list = Object.entries(this.connectedIds)
                .filter(([, v]) => v === 'ok')
                .map(([id]) => this.peerNames[id] || id.slice(0, 6));
            this.emit('peers', { count: names, names: list });
        },

        /* ---------------- 设备控制 ---------------- */

        toggleAudio(on) {
            if (!this.localStream) return;
            this.localStream.getAudioTracks().forEach(t => { t.enabled = on; });
        },

        toggleVideo(on) {
            if (!this.localStream) return;
            this.localStream.getVideoTracks().forEach(t => { t.enabled = on; });
            // 本地小窗保留（用户要能看到自己的状态），只换成占位底色
            this.updateLocalBadge();
        },

        /**
         * 前后摄像头切换。
         *
         * 用 replaceTrack 替换轨道，避免重新协商（重协商在移动端易失败）。
         */
        async switchCamera() {
            if (!this.localStream) return;
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (!videoTrack) return;

            const current = videoTrack.getSettings ? (videoTrack.getSettings().facingMode || 'user') : 'user';
            const next = current === 'user' ? 'environment' : 'user';

            try {
                const newStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: next, width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false
                });
                const newTrack = newStream.getVideoTracks()[0];
                if (!newTrack) return;

                /*
                 * 替换本地预览。
                 *
                 * 必须先 addTrack 再 removeTrack：反过来的话，中间那一瞬
                 * localStream 里没有任何视频轨，而 localVideoEl.srcObject
                 * 正是这个流 —— 部分 WebView 会因此把画面元素判定为「无源」
                 * 并停止渲染，之后即使轨道回来了也不再恢复（黑屏）。
                 */
                this.localStream.addTrack(newTrack);
                this.localStream.removeTrack(videoTrack);
                videoTrack.stop();
                if (this.localVideoEl) {
                    this.localVideoEl.srcObject = this.localStream;
                    await this.localVideoEl.play().catch(() => {});
                }

                /*
                 * 替换所有对端发送轨道。
                 *
                 * **逐个 await 且必须 await** —— 旧实现虽然写了 await，
                 * 但循环里任何一次 replaceTrack 抛错都会被外层 catch 吞掉，
                 * 于是后面几路对端**根本没换**：房主切了前后摄像头，
                 * 自己画面变了，部分观众看到的还是旧镜头，且没有任何提示。
                 * 这里改为逐条捕获，单路失败不影响其余对端。
                 */
                for (const sid of Object.keys(this.peers)) {
                    const peer = this.peers[sid];
                    if (!peer || typeof peer.getSenders !== 'function') continue;
                    const sender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (!sender) continue;
                    try {
                        await sender.replaceTrack(newTrack);
                    } catch (e) {
                        console.warn('[rtc] 某路对端换摄像头轨道失败:', (e && e.message) || e);
                    }
                }
                this.emit('camera', next);
            } catch (e) {
                this.emit('error', { message: '切换摄像头失败' });
            }
        },

        /* ---------------- 清理 ---------------- */

        cleanup() {
            /*
             * 先上报状态，再置 destroyed。
             *
             * emit 内部有 `if (this.destroyed) return` 的存活检查，
             * 若先置 destroyed 再 emit，这两条通知会被自己拦截 ——
             * 页面侧的 callStatus / hasRemote 会永远停在旧值
             * （表现为「已挂断但界面仍显示对方已接入」）。
             */
            this.setStatus('idle');
            this.emit('remote', false);

            this.destroyed = true;
            this.running = false;
            this.stopRediscover();

            // 关闭所有 PeerConnection
            /*
             * **先摘回调再关闭**。
             *
             * close() 会同步触发 onconnectionstatechange('closed')，那个回调
             * 会调 dropPeer —— 而 cleanup 期间各表正在被清空，重入进去会
             * 在已半清的状态上操作（且 reportPeers/syncGridLayout 都会白跑）。
             * 把回调摘掉，关闭就变成纯资源释放。
             */
            for (const sid of Object.keys(this.peers)) {
                const p = this.peers[sid];
                if (!p) continue;
                try {
                    p.onconnectionstatechange = null;
                    p.ontrack = null;
                    p.onicecandidate = null;
                    p.ondatachannel = null;
                    p.close();
                } catch (e) { /* 忽略 */ }
            }
            this.peers = {};
            this.connectedIds = {};
            this.channels = {};

            /*
             * 早到信令暂存与兜底定时器同样要清。
             *
             * 定时器不清会在页面卸载后触发，此时 socket 已置 null、
             * destroyed 已为 true，虽被守卫拦住，但白白留一堆悬挂回调。
             */
            this.earlySignals = {};
            for (const id of Object.keys(this.fallbackTimers || {})) {
                this.clearFallbackOffer(id);
            }
            this.fallbackTimers = {};

            /*
             * 连接超时 / 恢复兜底定时器同样要清。
             *
             * 不清的话，页面卸载后它们仍会触发 —— 虽然 destroyed 守卫能拦住，
             * 但每次重进房间都会累积一批悬挂回调，久了白白占资源。
             */
            for (const sid of Object.keys(this.connectTimers || {})) {
                this.clearConnectTimer(sid);
            }
            this.connectTimers = {};
            for (const sid of Object.keys(this.recoverTimers || {})) {
                this.clearRecoverTimer(sid);
            }
            this.recoverTimers = {};

            // 移除所有对端画面格（不解除 srcObject 会让 video 一直持有流）
            for (const peerId of Object.keys(this.tiles)) {
                this.removeTile(peerId);
            }
            this.syncGridLayout();

            // 停本地轨道（释放摄像头指示灯）
            if (this.localStream) {
                this.localStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) { /* 忽略 */ }
                });
                this.localStream = null;
            }
            if (this.localVideoEl) this.localVideoEl.srcObject = null;

            /*
             * 复位媒体标记，避免影响下一次 start（组件被复用、页面重进房）。
             *
             * 顺序上必须**先取消、后复位**：
             *   · `mediaCancelled = true` 让仍在飞的取流拿到结果后自行丢弃，
             *     否则它会把手里的流装上，而新一轮又取一条 —— 前一条永不释放。
             *   · 随后清掉 `mediaTask`，使下一轮 startMedia 不再复用旧 Promise。
             *
             * `mediaCancelled` 不在这里复位成 false：它的复位归 startMedia
             * （每次「开启」时清一次），本处代表「取消」，语义不能反过来。
             */
            this.mediaCancelled = true;
            this.mediaTask = null;

            // 断开信令
            if (this.socket) {
                try {
                    this.socket.removeAllListeners();
                    this.socket.disconnect();
                } catch (e) { /* 忽略 */ }
                this.socket = null;
            }

            // 复位房间名，允许之后用新房间重新 start
            this.roomIdFixed = '';
        }
    }
};
</script>

<style lang="scss" scoped>
.rtc-mount {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    background-color: #0b0d10;
}
</style>
