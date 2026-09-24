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
        /** 进入后是否自动开始通话 */
        autoStart: { type: Boolean, default: true },
        /** 初始是否开启摄像头 */
        initialVideo: { type: Boolean, default: true },
        /** 初始是否开启麦克风 */
        initialAudio: { type: Boolean, default: true }
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
            errorText: ''
        };
    },
    computed: {
        wrapperId() {
            return `rtc-${this.seed}`;
        },
        config() {
            return {
                roomId: this.roomId,
                displayName: this.displayName,
                autoStart: this.autoStart,
                initialVideo: this.initialVideo,
                initialAudio: this.initialAudio
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

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' }
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
            /** 本地媒体流 */
            localStream: null,
            rediscoverTimer: null,
            destroyed: false,
            /** 是否正在监听设备 */
            running: false
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
            this.conf = conf || {};
            if (!this.num) {
                const el = document.querySelector('[id^="rtc-"]');
                if (el) this.num = (el.id || '').replace('rtc-', '');
            }
            this.$nextTick(() => this.setup());
        },

        onCommandChange(cmd) {
            if (!cmd) return;
            if (cmd === 'start') this.start();
            else if (cmd === 'stop') this.cleanup();
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
                throw new Error('当前环境不支持摄像头采集');
            }

            // App 端先补权限，否则 Android 上会直接 NotAllowedError
            await this.grantWebviewMediaPermission();

            const wantVideo = this.conf.initialVideo !== false;
            const wantAudio = this.conf.initialAudio !== false;

            const tries = [];
            if (wantVideo && wantAudio) {
                tries.push({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: true });
            }
            if (wantAudio) tries.push({ video: false, audio: true });
            tries.push({ video: false, audio: false });

            let lastErr = null;
            for (const c of tries) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia(c);
                    return stream;
                } catch (e) {
                    lastErr = e;
                }
            }
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
         * 这里用 Native.js 主动发起一次权限请求，让系统弹窗先出现。
         * 任何异常都不阻断流程 —— 交给 getUserMedia 报出更准确的原因。
         */
        grantWebviewMediaPermission() {
            return new Promise(resolve => {
                if (!window.plus || !window.plus.android) {
                    resolve();
                    return;
                }
                try {
                    const main = window.plus.android.runtimeMainActivity();
                    const need = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'].filter(p => {
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

                    // 权限请求是异步的，这里不阻塞：用户点完「允许」再点一次即可
                    window.plus.android.invoke(main, 'requestPermissions', need, 1001);
                    resolve();
                } catch (e) {
                    resolve();
                }
            });
        },

        /* ---------------- 开始 / 清理 ---------------- */

        async start() {
            if (this.running) return;
            this.running = true;
            this.destroyed = false;
            this.setStatus('connecting');

            try {
                // 1. 本地流
                const stream = await this.acquireLocal();
                this.localStream = stream;
                if (this.localVideoEl) {
                    this.localVideoEl.srcObject = stream;
                    try {
                        await this.localVideoEl.play();
                    } catch (e) { /* 自动播放可能被拦，忽略 */ }
                }
                const hasVideo = stream.getVideoTracks().length > 0;
                // 本地小窗的标签与占位状态随后统一刷新
                this.updateLocalBadge();

                // 2. 信令连接
                await this.connectSignal();

                this.emit('localready', { hasVideo, hasAudio: stream.getAudioTracks().length > 0 });
            } catch (e) {
                this.running = false;
                this.setStatus('error');
                this.emit('error', { message: (e && e.message) || '启动通话失败' });
            }
        },

        async connectSignal() {
            const io = await this.loadSocketIO();
            if (!io) throw new Error('socket.io 未就绪');

            const roomId = this.conf.roomId || '';
            if (!roomId) throw new Error('缺少房间号');

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

        discover() {
            if (this.socket && this.socket.connected) {
                // 必须传字符串（房间名）
                this.socket.emit(EV.discover, this.conf.roomId || '');
            }
        },

        startRediscover() {
            this.stopRediscover();
            this.rediscoverTimer = setInterval(() => {
                this.discover();
                this.updateWaitHint();
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
                     * 我是较大的一方：正常应等对方发起。
                     * 记一个待定标记 + 超时兜底 —— 若若干秒后仍未建立连接，
                     * 说明对方的 offer 可能丢了，由我补发。
                     */
                    this.connectedIds[peerId] = 'waiting';
                    const target = peerId;
                    setTimeout(() => {
                        if (this.destroyed) return;
                        if (this.connectedIds[target] === 'waiting') {
                            this.connectedIds[target] = 'pending';
                            this.createPeer(target, true);
                        }
                    }, 4000);
                }
            }
        },

        /** 收到对方 offer。 */
        async onOffer({ initiator, sessionId, signal, metadata }) {
            // 对方的名字随 offer 的 metadata 送来
            this.rememberPeerName(initiator, metadata);

            let peer = this.peers[sessionId];
            if (!peer) {
                peer = this.createPeer(initiator, false, sessionId);
            }
            try {
                await peer.setRemoteDescription(signal);

                // 补投在 offer 之前就到了的候选
                const pending = peer._pendingCandidates.splice(0);
                for (const c of pending) {
                    try {
                        await peer.addIceCandidate(c);
                    } catch (e) { /* 忽略 */ }
                }

                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                this.socket.emit(EV.signal, {
                    signal: { type: answer.type, sdp: answer.sdp },
                    // 应答也带上自己的名字，否则发起方拿不到对方昵称
                    metadata: { name: this.conf.displayName || '' },
                    sessionId,
                    target: initiator
                });
            } catch (e) {
                this.emit('error', { message: '应答失败：' + (e && e.message) });
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
            if (!peer) return;

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
            /**
             * 远端描述就绪前收到的 ICE 候选。
             *
             * 候选与 SDP 是两条独立通道，网络快时候选会先到；
             * 此时 addIceCandidate 会抛错，必须先存起来、等
             * setRemoteDescription 之后再补投。
             */
            peer._pendingCandidates = [];

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

            // 推本地轨道
            if (this.localStream) {
                for (const track of this.localStream.getTracks()) {
                    peer.addTrack(track, this.localStream);
                }
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

            // 远端轨道到达：为这个对端挂上画面
            peer.ontrack = e => {
                const stream = e.streams && e.streams[0];
                if (!stream) return;
                const tile = this.ensureTile(remoteId);
                if (tile && tile.video.srcObject !== stream) {
                    tile.video.srcObject = stream;
                    tile.video.play().catch(() => {});
                    this.watchRemoteTracks(remoteId, stream);
                }
            };

            // 连接状态
            peer.onconnectionstatechange = () => {
                const st = peer.connectionState;
                if (st === 'connected') {
                    this.connectedIds[remoteId] = 'ok';
                    this.emit('remote', true);
                    this.reportPeers();
                    // 连上就建格，先占位后填流 —— 否则对方没开摄像头时一片空白
                    this.ensureTile(remoteId);
                    this.syncGridLayout();
                    if (this.waitEl) this.waitEl.classList.add('is-hidden');
                } else if (st === 'failed' || st === 'closed' || st === 'disconnected') {
                    delete this.connectedIds[remoteId];
                    this.reportPeers();
                    this.removeTile(remoteId);
                    this.syncGridLayout();

                    /*
                     * 多人场景：一条连接断开不代表「所有人都走了」，
                     * 只有再没有任何 connected 的对端时才算全部离开。
                     */
                    const stillAlive = Object.values(this.peers).some(
                        p => p !== peer && p.connectionState === 'connected'
                    );
                    if (!stillAlive) {
                        this.emit('remote', false);
                        if (this.waitEl) this.waitEl.classList.remove('is-hidden');
                    }
                }
            };

            // 发起方：创建 offer（首帧 offer 走 offer 事件，其余走 signal）
            if (initiator) {
                (async () => {
                    try {
                        const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
                        await peer.setLocalDescription(offer);
                        this.socket.emit(EV.offer, {
                            signal: { type: offer.type, sdp: offer.sdp },
                            metadata: { name: this.conf.displayName || '' },
                            sessionId: sid,
                            target: remoteId
                        });
                        this.startConnectTimer(sid);
                    } catch (e) {
                        this.emit('error', { message: '发起通话失败：' + (e && e.message) });
                    }
                })();
            }

            return peer;
        },

        /** 连接超时保护：迟迟连不上就重试一次。 */
        startConnectTimer(sid) {
            const peer = this.peers[sid];
            if (!peer) return;
            setTimeout(() => {
                if (this.destroyed) return;
                if (peer.connectionState !== 'connected') {
                    delete this.connectedIds[peer._remoteId];
                }
            }, CONNECT_TIMEOUT);
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
            };
            channel.onerror = () => { /* 忽略 */ };
        },

        /**
         * 向所有已连接的对端广播一条消息。
         *
         * 播放同步、切集通知都走这里；父组件只关心消息体。
         */
        broadcast(msg) {
            if (!this.channels) return;
            let text = '';
            try {
                text = JSON.stringify(msg);
            } catch (e) {
                return;
            }
            for (const sid of Object.keys(this.channels)) {
                const ch = this.channels[sid];
                try {
                    if (ch && ch.readyState === 'open') ch.send(text);
                } catch (e) { /* 忽略 */ }
            }
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
            if (!tile || tile._bound) return;
            tile._bound = true;

            // 存成 _redraw：昵称变化时由 updateTileTag 复用同一套绘制逻辑
            tile._redraw = () => {
                const cam = stream.getVideoTracks()[0];
                const mic = stream.getAudioTracks()[0];
                const camOff = !cam || cam.muted || cam.readyState === 'ended';
                const micOff = !mic || mic.muted || mic.readyState === 'ended';

                tile.wrap.classList.toggle('is-novideo', camOff);
                const name = this.peerNames[peerId] || '好友';
                tile.tag.textContent = camOff ? `${name}（摄像头关）` : name;
                tile.tag.classList.toggle('is-muted', micOff);
            };

            for (const track of stream.getTracks()) {
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

                // 替换本地预览
                this.localStream.removeTrack(videoTrack);
                this.localStream.addTrack(newTrack);
                videoTrack.stop();
                if (this.localVideoEl) {
                    this.localVideoEl.srcObject = this.localStream;
                    await this.localVideoEl.play().catch(() => {});
                }

                // 替换所有对端发送轨道
                for (const sid of Object.keys(this.peers)) {
                    const peer = this.peers[sid];
                    const sender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) await sender.replaceTrack(newTrack);
                }
                this.emit('camera', next);
            } catch (e) {
                this.emit('error', { message: '切换摄像头失败' });
            }
        },

        /* ---------------- 清理 ---------------- */

        cleanup() {
            this.destroyed = true;
            this.running = false;
            this.stopRediscover();

            // 关闭所有 PeerConnection
            for (const sid of Object.keys(this.peers)) {
                try {
                    this.peers[sid].close();
                } catch (e) { /* 忽略 */ }
            }
            this.peers = {};
            this.connectedIds = {};
            this.channels = {};

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

            // 断开信令
            if (this.socket) {
                try {
                    this.socket.removeAllListeners();
                    this.socket.disconnect();
                } catch (e) { /* 忽略 */ }
                this.socket = null;
            }

            this.setStatus('idle');
            this.emit('remote', false);
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
