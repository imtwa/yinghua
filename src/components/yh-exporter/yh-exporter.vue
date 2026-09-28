<template>
    <!--
        MP4 导出组件（无 UI 的服务型组件）。

        逻辑层负责「下载分片」，渲染层负责「remux + 写盘」。
        分工原因见下方各段注释。
    -->
    <view
        :id="wrapperId"
        class="yh-exporter"
        :vseed="seed"
        :change:vseed="dom.onSeed"
        :vcmd="command"
        :change:vcmd="dom.onCmd" />
</template>

<script>
/**
 * MP4 导出 —— 逻辑层（Options API）。
 *
 * ## 为什么必须分两层
 *
 * · **下载**在逻辑层：`uni.downloadFile` 是原生能力，不受 WebView
 *   同源策略限制（片源 CDN 不返回 CORS 头，渲染层 fetch/XHR 会被拦）。
 * · **remux** 在渲染层：mux.js 是 UMD 包，要靠 DOM 注入 script 加载。
 * · **写盘**在渲染层：App 端写二进制必须用 Native.js，而 plus 对象
 *   挂在 WebView 的 window 上（`plus.io` 的 FileWriter 只接受字符串，
 *   写不了二进制 —— 这是本方案唯一可行的写盘路径）。
 *
 * ## 为什么「边下边写」
 *
 * 实测单集可达 2142 片 / 1.4GB。若先全部下载再统一转换，
 * 峰值需要近 3GB 空间，手机上必然失败。
 * 现在每片处理完立刻删除临时文件，峰值只需成品本身的大小。
 */
import { parseManifest } from '@/services/download';
import { unwrapUrl } from '@/utils/url';
import { createLogger } from '@/utils/logger';

const log = createLogger('export');

export default {
    name: 'Mp4Exporter',
    props: {
        /** 该集的 m3u8 地址（未包装代理的原始地址） */
        m3u8Url: { type: String, default: '' },
        /** 影片名（用于生成文件名） */
        vodName: { type: String, default: '' },
        /** 集名（用于生成文件名） */
        episodeTitle: { type: String, default: '' }
    },
    data() {
        return {
            seed: Math.floor(Math.random() * 100000000),
            /** 渲染层指令 */
            command: '',
            /** 指令队列：同帧连发多条会互相覆盖，必须排队 */
            cmdQueue: [],
            /** 是否正在导出 */
            busy: false,
            /** 已请求取消 */
            cancelled: false,
            /** 分片总数 / 已完成 / 已写入字节 */
            total: 0,
            done: 0,
            bytes: 0,
            /** 成品路径 */
            outPath: '',
            /** 当前请求序号（用于把响应精确配对到请求） */
            curSeq: 0,
            /** 渲染层是否已上报过错误（避免同一次失败重复提示） */
            renderErrorReported: false
        };
    },
    computed: {
        wrapperId() {
            return `yh-exp-${this.seed}`;
        }
    },
    watch: {
        command(val) {
            if (val) {
                this.$nextTick(() => {
                    if (this.command === val) {
                        this.command = '';
                        this.$nextTick(() => this.flushQueue());
                    }
                });
            }
        }
    },
    created() {
        /*
         * 等待中的「请求 → 响应」回调。
         *
         * 逻辑层无法同步拿到渲染层方法的返回值，只能发指令等回调。
         * 这里用普通 Map 而不是 data：它不需要响应式，
         * 放进 data 会让每次 set/delete 都触发依赖通知。
         */
        this._pending = new Map();
    },
    methods: {
        /** 排队发送指令。 */
        sendCommand(cmd) {
            if (!cmd) return;
            if (this.command) {
                this.cmdQueue.push(cmd);
                return;
            }
            this.command = cmd;
        },
        flushQueue() {
            if (this.command) return;
            const next = this.cmdQueue.shift();
            if (next) this.command = next;
        },

        /** 渲染层唯一回调入口。 */
        onRenderEvent(payload) {
            const { event, data } = payload || {};

            /*
             * 按 seq 配对等待者（见 request 的说明）。
             *
             * 只有「带 seq 且正好有等待者」的响应才算数；
             * 迟到的响应（对应请求已超时）直接丢弃。
             */
            const seq = data && data.seq;
            if (seq && this._pending.has(seq)) {
                const waiter = this._pending.get(seq);
                this._pending.delete(seq);
                waiter(data || {});
            }

            if (event === 'outpath') this.outPath = (data && data.path) || '';
            if (event === 'error') {
                /*
                 * 标记「渲染层已报过错」。
                 *
                 * start() 的 catch 里据此决定是否再对外发一次 ——
                 * 否则同一次失败会弹出两条提示。
                 */
                this.renderErrorReported = true;
                log.error('导出出错', (data && data.message) || data);
            }

            this.$emit(event, data);
        },

        /**
         * 发一条指令并等待对应响应。
         *
         * ⚠️ 用**序号**配对，而不是事件名。
         *
         * 早先按事件名存等待者（`_pending.set('written', fn)`），
         * 会踩一个隐蔽的坑：某次请求超时后，等待者已从表里删除，
         * 但渲染层的响应可能**迟到**；它抵达时正好赶上下一片已经在等
         * 同一个事件名，于是被误认为「下一片的响应」——
         * 结果是进度错位、字节数统计错乱，且极难复现。
         *
         * 现在每次请求分配一个自增 seq 并带给渲染层，
         * 响应必须带着同一个 seq 才算数，迟到的一律丢弃。
         */
        request(cmd, expectEvent, timeout = 60000) {
            return new Promise(resolve => {
                const seq = ++this.curSeq;
                const timer = setTimeout(() => {
                    this._pending.delete(seq);
                    resolve(null);
                }, timeout);
                this._pending.set(seq, d => {
                    clearTimeout(timer);
                    resolve(d);
                });
                // 把 seq 编进指令，渲染层原样回传
                this.sendCommand(`${cmd}#${seq}`);
            });
        },

        /* ---------------- 对外接口 ---------------- */

        /**
         * 开始导出 MP4。
         *
         * 逐片：下载 → 交给渲染层 remux 并追加写 → 删除临时文件。
         */
        async start() {
            if (this.busy) return;
            if (!this.m3u8Url) {
                this.$emit('error', { message: '缺少播放地址' });
                return;
            }

            this.busy = true;
            this.cancelled = false;
            this.total = 0;
            this.done = 0;
            this.bytes = 0;

            let opened = false;
            try {
                const rawUrl = unwrapUrl(this.m3u8Url);

                // 1. 拉索引并解析（复用缓存模块的解析器，含去重）
                const text = await this.fetchText(rawUrl);
                const parsed = parseManifest(text, rawUrl);
                if (!parsed.segments.length) throw new Error('该片源没有可下载的分片');

                this.total = parsed.segments.length;

                // 2. 建立输出文件
                const fileName = this.buildFileName();
                const ready = await this.request('init:' + this.b64(fileName), 'ready');
                /*
                 * ready 为 null 表示超时；ok===false 表示渲染层初始化失败
                 * （如设备不支持、目录不可写）。两者都要中断，
                 * 否则会一路跑完 2142 片却什么都没写进去。
                 */
                if (!ready || ready.ok === false) throw new Error('无法创建输出文件');
                opened = true;

                this.$emit('start', { total: this.total, fileName });

                // 3. 逐片处理
                for (let i = 0; i < parsed.segments.length; i++) {
                    if (this.cancelled) break;

                    let tempPath = '';
                    try {
                        tempPath = await this.downloadSegment(parsed.segments[i]);
                    } catch (e) {
                        /*
                         * 单片失败不整体中断。
                         *
                         * 实测源站偶发 5xx，若一片失败就放弃整集，
                         * 用户要重头再来 —— 代价太大。
                         * remux 会跳过缺失片，成品在对应位置轻微跳帧，
                         * 但整片仍可正常观看。
                         */
                        log.warn('分片下载失败，跳过', parsed.segments[i], (e && e.message) || '');
                        this.done += 1;
                        this.emitProgress();
                        continue;
                    }

                    const written = await this.request('push:' + this.b64(tempPath), 'written');
                    this.removeTemp(tempPath);

                    this.done += 1;
                    if (written && written.bytes) this.bytes = written.bytes;
                    this.emitProgress();
                }

                // 4. 收尾
                if (this.cancelled) {
                    /*
                     * 取消：发 abort 并等渲染层删掉半成品。
                     *
                     * 同样走 request 拿序号 —— 直接 sendCommand 的话
                     * doFinish 回传的 seq 会指向**上一个请求**的号，
                     * 那个等待者早已被删（或属于别的请求），
                     * 结果 abort 的响应无人接收，逻辑层又白等一轮超时。
                     */
                    await this.request('abort', 'aborted');
                    this.$emit('cancelled');
                } else {
                    const fin = await this.request('finish', 'finished');
                    this.$emit('done', {
                        path: (fin && fin.path) || this.outPath,
                        bytes: (fin && fin.bytes) || this.bytes
                    });
                }
            } catch (e) {
                log.error('导出失败', (e && e.message) || e);
                /*
                 * 这里只对外发 error，**不重复发**：
                 * 渲染层初始化失败时自己会 emit 一次 error（经 onRenderEvent
                 * 透传出去），随后这里又 emit 一次 —— 父组件会收到两条错误
                 * 提示、连弹两次 toast。
                 * 用标记区分「已由渲染层报过」，避免重复打扰用户。
                 */
                if (!this.renderErrorReported) {
                    this.$emit('error', { message: (e && e.message) || '导出失败' });
                }
                /*
                 * 清理半成品。
                 *
                 * 刻意**不等响应**（不 await）：出错路径上不该再引入
                 * 一次可能超时的等待，否则「导出失败」之后还要再卡一分钟。
                 * 清理失败也只是留个残文件，不影响正确性。
                 */
                if (opened) this.sendCommand('abort');
            } finally {
                this.busy = false;
                this.renderErrorReported = false;
            }
        },

        /** 请求取消（当前分片处理完后停止）。 */
        cancel() {
            if (!this.busy) return;
            this.cancelled = true;
        },

        emitProgress() {
            this.$emit('progress', {
                done: this.done,
                total: this.total,
                bytes: this.bytes,
                percent: this.total ? Math.round((this.done / this.total) * 100) : 0
            });
        },

        /** 生成文件名（去掉文件系统不接受的字符）。 */
        buildFileName() {
            const raw = [this.vodName, this.episodeTitle].filter(Boolean).join('_') || '影片';
            const safe = raw
                .replace(/[\\/:*?"<>|\r\n\t]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 80);
            return `${safe || '影片'}.mp4`;
        },

        /** 拉取索引文本。 */
        fetchText(url) {
            return new Promise((resolve, reject) => {
                uni.request({
                    url,
                    method: 'GET',
                    dataType: 'text',
                    timeout: 20000,
                    success: res => {
                        if (res.statusCode === 200 && typeof res.data === 'string') resolve(res.data);
                        else reject(new Error(`索引请求失败 HTTP ${res.statusCode}`));
                    },
                    fail: err => reject(new Error('索引请求失败：' + JSON.stringify(err)))
                });
            });
        },

        /** 下载单个分片，返回临时文件路径。 */
        downloadSegment(url) {
            return new Promise((resolve, reject) => {
                uni.downloadFile({
                    url,
                    timeout: 60000,
                    success: res => {
                        if (res.statusCode === 200 && res.tempFilePath) resolve(res.tempFilePath);
                        else reject(new Error(`HTTP ${res.statusCode}`));
                    },
                    fail: err => reject(new Error(JSON.stringify(err)))
                });
            });
        },

        /** 删除临时文件（不删会迅速吃满存储）。 */
        removeTemp(path) {
            if (!path) return;
            try {
                // #ifdef APP-PLUS
                plus.io.resolveLocalFileSystemURL(
                    path,
                    entry => entry.remove(() => {}, () => {}),
                    () => {}
                );
                // #endif
            } catch (e) {
                /* 忽略 */
            }
        },

        /**
         * 字符串 → base64（UTF-8 安全）。
         *
         * 不用 `unescape(encodeURIComponent(...))` —— `unescape` 是废弃 API，
         * 未来 WebView 可能移除。这里手工把 UTF-8 字节拼成二进制串，
         * 效果等价且不依赖废弃接口。
         */
        b64(s) {
            try {
                const utf8 = encodeURIComponent(String(s || '')).replace(
                    /%([0-9A-F]{2})/g,
                    (_, p) => String.fromCharCode(parseInt(p, 16))
                );
                return btoa(utf8);
            } catch (e) {
                return '';
            }
        }
    }
};
</script>

<script module="dom" lang="renderjs">
/**
 * MP4 导出 —— 渲染层。
 *
 * 职责：加载 mux.js、把 TS 分片 remux 成 fMP4、把字节写入成品文件。
 */

/** mux.js 路径（App 相对根目录，H5 用绝对路径）。 */
const MUX_URL = (function () {
    const isApp = typeof window !== 'undefined' && (!!window.plus || /Html5Plus/i.test(navigator.userAgent || ''));
    return isApp ? './static/js/mux.min.js' : '/static/js/mux.min.js';
})();

export default {
    data() {
        return {
            num: '',
            /** mux.js 的 Transmuxer 实例 */
            tx: null,
            /** Java 侧的输出文件流 */
            outStream: null,
            /** 输出文件绝对路径 */
            outPath: '',
            /** 累计写入字节 */
            bytes: 0,
            /** 是否已写入 init segment */
            initWritten: false,
            /** 是否已初始化 */
            inited: false,
            /** 当前请求序号（由 onCmd 从指令后缀解析，回传时带上） */
            curSeq: 0
        };
    },
    methods: {
        /* ---------------- 与逻辑层通信 ---------------- */

        onSeed(seed) {
            this.num = seed;
        },

        onCmd(cmd) {
            if (!cmd) return;

            /*
             * 拆出序号后缀（逻辑层用 `#seq` 标记请求，见 request）。
             *
             * 序号必须原样回传，逻辑层靠它把响应精确配对到请求 ——
             * 否则迟到的响应会被误当成下一次请求的结果。
             */
            let body = cmd;
            let seq = 0;
            const hash = cmd.lastIndexOf('#');
            if (hash > 0) {
                const tail = cmd.slice(hash + 1);
                if (/^\d+$/.test(tail)) {
                    seq = Number(tail);
                    body = cmd.slice(0, hash);
                }
            }
            this.curSeq = seq;

            if (body.indexOf('init:') === 0) this.doInit(this.unb64(body.slice(5)));
            else if (body.indexOf('push:') === 0) this.doPush(this.unb64(body.slice(5)));
            else if (body === 'finish') this.doFinish(false);
            else if (body === 'abort') this.doFinish(true);
        },

        /** 回报逻辑层。 */
        emit(event, data) {
            const owner = this.$ownerInstance;
            if (!owner || typeof owner.callMethod !== 'function') return;
            try {
                owner.callMethod('onRenderEvent', { event, data });
            } catch (e) {
                /* 实例已销毁 */
            }
        },

        /** base64 → 字符串（UTF-8 安全，与逻辑层 b64 对称）。 */
        unb64(s) {
            try {
                const bin = atob(String(s || ''));
                let pct = '';
                for (let i = 0; i < bin.length; i++) {
                    pct += '%' + bin.charCodeAt(i).toString(16).padStart(2, '0');
                }
                return decodeURIComponent(pct);
            } catch (e) {
                return '';
            }
        },

        /* ---------------- mux.js ---------------- */

        /** 动态加载 mux.js（renderjs 不能 import）。 */
        loadMux() {
            return new Promise((resolve, reject) => {
                if (window.muxjs && window.muxjs.mp4 && window.muxjs.mp4.Transmuxer) {
                    resolve(window.muxjs);
                    return;
                }
                const exist = document.querySelector('script[data-yh-mux="1"]');
                if (exist) {
                    exist.addEventListener('load', () => resolve(window.muxjs));
                    exist.addEventListener('error', () => reject(new Error('mux.js 加载失败')));
                    return;
                }
                const s = document.createElement('script');
                s.src = MUX_URL;
                s.setAttribute('data-yh-mux', '1');
                s.onload = () => resolve(window.muxjs);
                s.onerror = () => reject(new Error('mux.js 加载失败'));
                document.head.appendChild(s);
            });
        },

        /* ---------------- 初始化输出 ---------------- */

        /**
         * 创建输出文件并打开追加流。
         *
         * 输出到 `_downloads/yinghua/`（应用公共下载目录），
         * 对应 `/sdcard/Android/data/<包名>/downloads/yinghua/`。
         *
         * 选这里的理由：它属于**应用专属的外部目录**，
         * 读写**无需任何存储权限**，用户也能用文件管理器找到。
         * 而系统公共的 `/sdcard/Download` 自 Android 10 起受分区存储
         * 限制，写入需要 MediaStore 或 MANAGE_EXTERNAL_STORAGE，
         * 代价与风险都不划算。
         */
        async doInit(fileName) {
            try {
                await this.loadMux();

                if (!window.plus || !window.plus.android) {
                    this.emit('ready', { ok: false, seq: this.curSeq });
                    this.emit('error', { message: 'MP4 导出目前仅支持 App 端' });
                    return;
                }

                /*
                 * 先清掉上一次的残留。
                 *
                 * 若上次导出因异常退出（doFinish 没走到），
                 * this.tx 与 this.outStream 仍指向旧对象 ——
                 * 直接覆盖会让旧 tx 的 data 监听器继续活着，
                 * 两边同时往流里写，产物结构错乱。
                 */
                this.releasePrev();

                const File = window.plus.android.importClass('java.io.File');
                const FileOutputStream = window.plus.android.importClass('java.io.FileOutputStream');

                /*
                 * ⚠️ 路径拼接必须自己补分隔符。
                 *
                 * convertLocalFileSystemURL 的返回值**末尾不带斜杠**
                 * （如 `/storage/emulated/0/Android/data/<pkg>/downloads/yinghua`），
                 * 直接 `dirPath + fileName` 会拼成 `.../yinghua影片.mp4` ——
                 * 文件会落到 downloads 目录下、名字带上前一级目录名，
                 * 而 File 对象因父目录不存在而创建失败。
                 */
                const dirPath = this.ensureSlash(
                    window.plus.io.convertLocalFileSystemURL('_downloads/yinghua/')
                );
                const dir = new File(dirPath);
                if (!dir.exists()) dir.mkdirs();

                const fullPath = dirPath + fileName;
                const outFile = new File(fullPath);
                // 同名直接覆盖，避免重复导出堆积副本
                if (outFile.exists()) outFile.delete();

                // 追加模式（第二参 true）：后续每片都往同一个流写
                this.outStream = new FileOutputStream(outFile, true);
                this.outPath = fullPath;
                this.bytes = 0;
                this.initWritten = false;

                const Transmuxer = window.muxjs.mp4.Transmuxer;
                this.tx = new Transmuxer({ remux: true });
                this.tx.on('data', segment => this.onSegment(segment));

                this.inited = true;
                this.emit('outpath', { path: fullPath });
                this.emit('ready', { ok: true, seq: this.curSeq });
            } catch (e) {
                /*
                 * ⚠️ 失败时**也必须回 ready**（ok:false）。
                 *
                 * 逻辑层等的就是这个事件；只发 error 的话它会一直等到
                 * 60 秒超时才报「无法创建输出文件」—— 用户点了按钮后
                 * 干等一分钟，且看不到真实原因。
                 */
                this.emit('ready', { ok: false, seq: this.curSeq });
                this.emit('error', { message: '初始化失败：' + ((e && e.message) || e) });
            }
        },

        /** 确保路径以 / 结尾。 */
        ensureSlash(p) {
            const s = String(p || '');
            if (!s) return s;
            return /\/$/.test(s) ? s : s + '/';
        },

        /**
         * 释放上一次遗留的 tx / 输出流。
         *
         * 供 doInit 在建立新任务前调用：上次若因异常退出，
         * doFinish 可能没执行到，旧对象还活着。
         */
        releasePrev() {
            if (this.tx) {
                try {
                    this.tx.off && this.tx.off('data');
                } catch (e) {
                    /* 忽略 */
                }
                try {
                    this.tx.dispose && this.tx.dispose();
                } catch (e) {
                    /* 忽略 */
                }
                this.tx = null;
            }
            if (this.outStream) {
                try {
                    this.outStream.close();
                } catch (e) {
                    /* 忽略 */
                }
                this.outStream = null;
            }
            this.inited = false;
        },

        /** 处理一片：读本地文件 → 喂给 mux.js。 */
        doPush(tempPath) {
            if (!this.inited || !this.tx) {
                this.emit('written', { bytes: this.bytes, seq: this.curSeq });
                return;
            }
            this.readFileBytes(tempPath)
                .then(data => {
                    /*
                     * ⚠️ 必须重新检查 tx。
                     *
                     * readFileBytes 是异步的（要等 FileReader 回调）。
                     * 若期间发生了 doFinish（超时兜底、用户取消、出错清理），
                     * this.tx 已被置 null —— 此时再 push 会抛
                     * "Cannot read property 'push' of null"，
                     * 而这个异常发生在 Promise 里，外层 catch 抓不到，
                     * 表现为控制台报错 + 该片静默丢失。
                     */
                    if (!this.tx || !this.inited) {
                        this.emit('written', { bytes: this.bytes, seq: this.curSeq });
                        return;
                    }
                    if (data && data.length) {
                        this.tx.push(data);
                        /*
                         * 每片推完立刻 flush。
                         *
                         * 不 flush 的话 mux.js 会把数据攒在内部缓冲里，
                         * 直到最后才一次性吐出 —— 那就不是「边下边写」，
                         * 内存会随分片数线性增长（2142 片撑不住）。
                         */
                        this.tx.flush();
                    }
                    this.emit('written', { bytes: this.bytes, seq: this.curSeq });
                })
                .catch(() => this.emit('written', { bytes: this.bytes, seq: this.curSeq }));
        },

        /** 收尾：flush 剩余数据、关闭流。 */
        doFinish(abort) {
            /*
             * ⚠️ 用局部变量抓住当前对象再置空。
             *
             * doFinish 之后 this.tx / this.outStream 会被清掉，
             * 而下面 flush 与 close 之间可能触发 onSegment 回调 ——
             * 那时 this.outStream 已为 null，写入会被静默丢弃。
             * 先在本地留下引用，保证收尾期间的产出仍能落盘。
             */
            const tx = this.tx;
            const stream = this.outStream;
            const target = this.outPath;

            try {
                if (tx && !abort) tx.flush();
            } catch (e) {
                /* 忽略 */
            }
            try {
                if (stream) {
                    stream.flush();
                    stream.close();
                }
            } catch (e) {
                /* 忽略 */
            }

            this.outStream = null;
            this.tx = null;
            this.inited = false;

            if (abort) {
                // 取消：删掉半成品，避免留一个放不了的文件
                try {
                    const File = window.plus.android.importClass('java.io.File');
                    const f = new File(target);
                    if (f.exists()) f.delete();
                } catch (e) {
                    /* 忽略 */
                }
                this.emit('aborted', { seq: this.curSeq });
            } else {
                /*
                 * 用 `finished` 而不是 `done`。
                 *
                 * 逻辑层收到它之后会**对外**发出 `done`；
                 * 若这里也叫 done，逻辑层 onRenderEvent 的透传
                 * 会让父组件收到两次 done —— 用户看到两个「导出完成」
                 * 弹窗，第二次还得再点一次「知道了」。
                 * 内部事件与对外事件分开命名，从根上避免撞名。
                 */
                this.emit('finished', { path: target, bytes: this.bytes, seq: this.curSeq });
            }
        },

        /* ---------------- remux 产出 → 写盘 ---------------- */

        /**
         * 收到一段 remux 结果。
         *
         * 第一段必带 initSegment（ftyp + moov + mvex），必须先写 ——
         * 播放器要靠它才知道轨道信息（编码、分辨率、时间基）。
         * 之后才是媒体段（moof + mdat）。
         */
        onSegment(segment) {
            /*
             * outStream 可能已被 doFinish 关闭（取消 / 出错清理），
             * 此时再写会抛 "Stream closed"。
             * 这里静默丢弃即可 —— 那些数据本来也不该再落盘。
             */
            if (!this.outStream) return;

            if (segment.initSegment && !this.initWritten) {
                this.appendBytes(segment.initSegment);
                this.initWritten = true;
            }
            if (segment.data && segment.data.byteLength) {
                this.appendBytes(segment.data);
            }
        },

        /**
         * 追加字节到输出文件。
         *
         * 用 base64 在 JS 与 Java 之间传数据：
         * Native.js 传递「大块字节数组」性能很差
         * （JS 数组要逐元素转 byte[]，800KB 就明显卡顿），
         * 而字符串是原生高效支持的。
         */
        appendBytes(u8) {
            if (!u8 || !u8.length || !this.outStream) return;
            try {
                const Base64 = window.plus.android.importClass('android.util.Base64');
                const b64 = this.u8ToBase64(u8);
                // 0 = Base64.DEFAULT
                const bytes = Base64.decode(b64, 0);
                this.outStream.write(bytes);
                this.bytes += u8.length;
            } catch (e) {
                this.emit('error', { message: '写入失败：' + ((e && e.message) || e) });
            }
        },

        /** Uint8Array → base64（分块，避免参数过多导致栈溢出）。 */
        u8ToBase64(u8) {
            let s = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < u8.length; i += CHUNK) {
                s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
            }
            return btoa(s);
        },

        /**
         * 读本地文件为 Uint8Array。
         *
         * 走 plus.io.FileReader.readAsDataURL —— 它虽然会做一次
         * base64 编码，但这是**已被本工程验证可靠**的路径
         * （见 services/download.ts 的 readLocalBuffer）。
         * 而 Native.js 侧用 FileInputStream 读大文件时，
         * 不同机型上 byte[] 的创建方式存在差异，风险更高。
         */
        readFileBytes(path) {
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
                                            const comma = url.indexOf(',');
                                            resolve(comma < 0 ? null : this.base64ToU8(url.slice(comma + 1)));
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

        /** base64 → Uint8Array。 */
        base64ToU8(b64) {
            const bin = atob(String(b64 || ''));
            const len = bin.length;
            const out = new Uint8Array(len);
            for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
    }
};
</script>

<style lang="scss" scoped>
/* 纯服务型组件：不占布局、不可见 */
.yh-exporter {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;
}
</style>
