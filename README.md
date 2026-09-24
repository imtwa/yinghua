# 映话

> 一起看，聊着看。

基于 uni-app 的影视聚合客户端，支持 H5 与 App（Android / iOS）。
无广告，含双人同步观影。

---

## 名称由来

**映** —— 放映、映画；**话** —— 通话、对话。
合起来谐音「映画」（日语中的「电影」），正好扣住「一起看片 + 视频通话」。

---

## 技术栈

| 项 | 选型 |
| --- | --- |
| 框架 | uni-app（Vue 3 + TypeScript） |
| 构建 | Vite 5 + pnpm |
| CLI 架构 | unibest 风格（文件路由 + 约定式配置） |
| 样式 | UnoCSS + SCSS |
| 状态 | Pinia + 持久化 |
| 播放器 | renderjs 自绘（H5 与 App 统一） |
| HLS | hls.js（非 Safari 内核） |
| 通话 | 原生 WebRTC + socket.io 信令（自实现，见 `constants/rtc.ts`） |
| 离线 | m3u8 分片落盘 + 本地 loader 播放（仅 App） |

---

## 快速开始

```bash
cd D:\aProject\Uniapp\yinghua

# 安装依赖（必须用 pnpm）
pnpm install

# 初始化 husky（首次）
pnpm init-husky

# 启动 H5 开发
pnpm dev:h5

# 启动 App 开发（需 HBuilderX 或真机调试基座）
pnpm dev:app

# 构建
pnpm build:h5
pnpm build:app-android
pnpm build:app-ios
```

开发服务器默认端口 `9010`（见 `env/.env` 的 `VITE_APP_PORT`）。

---

## 目录结构

```
yinghua/
├── env/                        环境变量（.env / .env.development / .env.production）
├── scripts/                    构建辅助脚本
├── vite-plugins/               Vite 自定义插件（H5 跨域代理）
├── src/
│   ├── api/types.ts            接口类型定义
│   ├── components/
│   │   ├── yh-player/          播放器（renderjs 自绘 + hls.js，H5/App 统一）
│   │   ├── yh-rtc/             视频通话（renderjs：socket.io 信令 + WebRTC）
│   │   ├── yh-vod-card/        影片卡片
│   │   ├── yh-episode/         剧集宫格
│   │   ├── yh-nav/             自定义导航栏
│   │   └── yh-empty/           空状态
│   ├── constants/
│   │   ├── source.ts           采集源、首页栏目、最新栏目
│   │   └── rtc.ts              通话信令配置与协议说明
│   ├── http/request.ts         统一请求（GET + JSON，无需签名）
│   ├── pages/
│   │   ├── index/              首页（轮播 + 栏目流）
│   │   ├── category/           分类（左栏 + 宫格）
│   │   ├── catlist/            分类列表（横向标签，从首页「更多」进入）
│   │   ├── detail/             详情 + 选集
│   │   ├── play/               播放（片源解析、全屏、缓存、选集抽屉）
│   │   ├── room/               双人观影（通话悬浮窗 + 进度同步）
│   │   ├── history/            观看历史
│   │   ├── favorite/           我的收藏
│   │   ├── cache/              离线缓存管理
│   │   ├── search/             搜索
│   │   └── mine/               我的（昵称、统计、输入房间号进房）
│   ├── services/
│   │   ├── video.ts            影片接口（多源容错 + 分类聚合）
│   │   ├── play.ts             播放地址解析
│   │   ├── user.ts             观看历史与收藏（本地）
│   │   ├── profile.ts          默认昵称（本地生成并持久化）
│   │   ├── download.ts         m3u8 离线缓存（分片落盘 + 本地播放）
│   │   └── index.ts            统一导出
│   ├── stores/                 play / user
│   ├── utils/
│   │   ├── url.ts              H5 跨域地址包装
│   │   ├── room-sync.ts        房间同步协议 + 房间号持久化
│   │   └── logger.ts           分级日志
│   ├── static/js/
│   │   ├── hls.min.js          hls.js（renderjs 动态加载）
│   │   └── socket.io.min.js    socket.io-client 打包产物（通话信令用）
│   └── tabbar/config.ts        tabbar 配置
├── unpackage/res/icons/        应用图标（由脚本生成，随代码分发）
├── pages.config.ts             pages.json 生成配置
├── manifest.config.ts          manifest.json 生成配置
└── uno.config.ts               UnoCSS 主题
```

> 注意：`src/pages.json` 与 `src/manifest.json` 是**生成产物**（分别由
> `pages.config.ts`、`manifest.config.ts` 生成），已在 `.gitignore` 中忽略。
> 改配置请改源文件，不要直接编辑产物。

### 应用图标

图标由 `scripts/gen-icons.mjs` **用代码生成**（手写 PNG 编码，不依赖图像库）：

```bash
pnpm gen:icons       # 手动生成
pnpm build:app-android   # 打包前自动生成（prebuild:app 钩子）
```

设计：深色圆角底（`#0b0d10`）+ 琥珀金播放三角与两道声波弧（`#f0a63c`），
三角呼应「映」、声波呼应「话」，配色与应用内一致。

输出到两处：

| 位置 | 用途 | 尺寸 |
| --- | --- | --- |
| `unpackage/res/icons/` | App 打包图标 | Android 72/96/144/192，iOS 120/180/1024 |
| `src/static/icons/logo.png` | 应用内展示 | 192 |

> Android 图标带圆角与留白（系统自适应），iOS 为满幅方形（由系统自行切圆角）。
> `unpackage/` 整体被忽略，但 `unpackage/res/icons/` 通过 `!` 规则**保留入库** ——
> 图标是源资源而非构建产物，忽略了会导致换机器打包退回默认图标。

---

## 数据源

数据源已从原 APK（`com.hjmore.oeqvv`）的私有接口**整体切换为公开采集源**
（苹果CMS v10 标准接口），原因见下方「为什么换源」。

### 接口形态

GET + JSON，**无签名、无加密、无需 token**：

```
GET <api>?ac=list                     分类列表
GET <api>?ac=detail&t=<分类id>&pg=N   分类列表页
GET <api>?ac=detail&ids=<影片id>      影片详情（含 vod_play_url）
GET <api>?ac=detail&wd=<关键词>       搜索
```

播放地址在 `vod_play_url`，格式为 `第01集$https://x.m3u8#第02集$https://y.m3u8`。

因此 `src/utils/sign.ts`、AES 解密、设备指纹等**整套旧体系已移除**，
`src/http/request.ts` 只剩最简的请求与日志。

### 多源容错

`constants/source.ts` 配置了主源 + 备用源，`services/video.ts` 按顺序尝试，
任一源不可用就落到下一个。**实测（2026-09）39 个候选源，仅 13 个可用**。

**各源分类 id 完全不同，不能硬编码**：

| 源 | 短剧 | 动漫 | 连续剧 | 综艺 |
| --- | --- | --- | --- | --- |
| 暴风（主） | 58 | 39 | 30 | 45 |
| 量子 | 46 | 4 | 2 | 3 |
| 无尽 | 41 | 4 | 2 | 3 |

因此首页栏目改成**按分类名实时解析 id**（`getClassTree` + `pickClassNode`），
并配别名兜底（有的源叫「电视剧」而非「连续剧」、「爽文短剧」而非「短剧」）。
写死 id 一旦落到备用源，栏目会取到毫不相干的分类。

另有两点实测坑：

- 部分源（红牛、无尽、索尼）的分类表**不返回 `type_pid`**。
  若按 `type_pid === 0` 过滤会把它们整体滤空，须按字段缺失即一级处理。
- `t=` 是**唯一**真正过滤分类的参数。`type_id` / `type` / `class` 传了无效
  （返回全库总数），故不依赖它们。

### 栏目取数：聚合子分类

**该源的顶级分类几乎是空壳。** 以「连续剧(30)」为例，直接查它只返回
**7 条 2023 年的老剧**，而它的子类国产剧/韩剧/日剧/泰剧每天都在更新：

| 一级分类 | 直接查询 | 聚合子类后 |
| --- | --- | --- |
| 连续剧 | 7 条（2023-04） | **147 条**（当天） |
| 动漫 | 53 条（2025-04） | **120 条**（当天） |
| 综艺 | 20 条（2025-05） | **100 条**（当天） |

故 `getChannelInfo` 会取「父类 + 全部子类」并发查询、再按 `vod_time` 归并。
源端**不支持多分类一次查询**（`t=30,31,32` 与 `t=30` 返回相同），只能客户端归并。

> 归并后每页条数不固定（可达上百条），因此调用方**不能用 `list.length >= 20`
> 判断是否到底**，应以「本页返回 0 条」为准。

### 最新栏目

不传 `t` 即为按 `vod_time` 倒序，各源实测一致，无需排序参数。
放在首页第一位，也充当轮播来源。

> 注意：实测**多数源并不支持 `order` / `by` 排序参数**（传了返回字节级相同的结果），
> 因此不要试图用它做排行榜。`vod_hits` 系列字段还存在「日点击 > 总点击」的矛盾值。

### 片源失效处理

`vod_url` 会随 CDN 节点上下线变化。`services/play.ts` 的 `resolvePlayUrl()`
已实现「取地址 → 可选探测 → 交给播放器」，探测判据是
HTTP 200 且响应体以 `#EXTM3U` 开头。

可用开关：

```
VITE_PLAY_PROBE_ENABLE   是否开启探测（默认 true）
VITE_PLAY_PROBE_TIMEOUT  单次探测超时（毫秒）
```

> **H5 端不直连探测**：片源 CDN 不返回 CORS 头，须走本地代理（见 `utils/url.ts`）。

### 为什么换源

原 APK 走**私有 P2P 协议**（`libpp_hls.so`，端口 ≥7000），
普通 HTTP 客户端只能拿到占位警告片 —— 实测 9 部完全不同的影片返回的是
同一个 11.3 秒的「请重启 APP」提示流，而真实片源域名的鉴权网关返回 403。

该协议无法用 HTTP 复刻，故整体改用公开采集源，代价是内容质量依赖源站。


### 禁止页面弹动

三处配置协同，覆盖各端：

| 位置 | 配置 | 作用 |
| --- | --- | --- |
| `pages.config.ts` → `globalStyle['app-plus']` | `bounce: 'none'` | App 端禁止整页橡皮筋回弹 |
| `pages.config.ts` → `globalStyle` | `enablePullDownRefresh: false` | 关闭下拉刷新 |
| `src/App.vue` | `overscroll-behavior: none` | H5 端禁止滚动链与回弹 |

另外所有 `<scroll-view>` 都显式加了 `:bounce="false"`（App 端 scroll-view 的回弹独立于页面）。

> 背景色也一并统一：`backgroundColorContent` / `backgroundColorTop` / `backgroundColorBottom`
> 全部设为页面底色 `#0b0d10`，避免 iOS 回弹区域露出白边。

### 日志

统一用 `src/utils/logger.ts`，输出带 `[yinghua]` 前缀，便于过滤。

手机端查看方式：

```bash
# Android
adb logcat | findstr yinghua

# 或在 HBuilderX 的运行时控制台查看
```

> **注意**：`env/.env.production` 里 `VITE_DELETE_CONSOLE` 必须为 `false`，
> 否则 esbuild 会在构建时删除所有 `console` 调用，连手机就看不到任何日志。
> 上线前若不需要日志，可改为 `true`。

---

## 播放器实现

播放器位于 `src/components/yh-player/yh-player.vue`，**H5 与 App 统一走 renderjs**。

为什么这么做：

1. App（vue 页面）与 H5 都是 WebView 渲染，renderjs 可直接操作 DOM
2. 自绘控件，样式与层级完全可控，不受原生组件层级限制
3. m3u8 统一用 hls.js 播放，两端行为一致
4. 可直接读写 `currentTime`，seek 精确

### 已实现的交互

- **点击画面**：控件可见时立即隐藏，不可见时唤出并 3.2 秒自隐
- **左半屏竖滑调亮度**、**右半屏竖滑调音量**（App 端写系统亮度，H5 回落 CSS filter）
- **全屏**：App 端 `plus.navigator.setFullscreen` 隐藏状态栏 + 锁方向；
  H5 端 CSS 铺满（不用原生全屏，否则父页面浮层会被裁掉）
- **全屏内可切横竖屏**，控制条上有方向按钮
- **加载浮层**：缓冲百分比 + 实时网速（取自 hls 分片的真实字节增量）
- **切集反馈**：压黑并标出目标集数，新源出画后自动揭开
- 换集时不销毁播放器实例（`playUrl` 直接换源），避免全屏状态被打断

注意（踩坑点）：

- renderjs **不能使用 `import`**，故 hls.js 以静态文件形式放在 `src/static/js/hls.min.js`，
  运行时用 `<script>` 标签动态加载（App 端路径相对根目录 `./static/`，H5 端用 `/static/`）
- renderjs **不支持 `<script setup>`**，故逻辑层必须用 Options API
- renderjs 只能通过 `$ownerInstance.callMethod()` 回调**逻辑层 methods** 中定义的方法
- **renderjs 的属性同步不支持函数**（跨实例会丢），需要的能力须在 renderjs 内自行实现；
  `window.plus` 与页面同处一个 WebView，可直接调用
- 自研组件统一加 `yh-` 前缀，避免与内置组件（`view` / `text` / `navigation` 等）重名

控件视觉：半透明浮层 + CSS 绘制图标，无 emoji、无字体图标、无图片资源。

### 离线缓存

`services/download.ts` 把 m3u8 的**分片逐个落盘**到应用沙箱
（`_doc/yinghua_cache/`），播放时用自定义 hls.js loader 从本地读取，
**完全不碰网络**。文件名用 URL 哈希，因此无需维护上千条映射表。

两个必须注意的点：

- 下载时要把索引里的**相对地址改写成绝对地址**再保存。否则离线时
  无法由哈希命中本地分片，整集黑屏。
- 分片失败**不能计入完成数**，否则进度虚高、也看不出完整性。

仅 App 端可用（H5 的浏览器配额约 5MB，装不下一部影片）。

---

## 双人观影

### 设计原则

**影片流各自拉取，不走 RTC。**

```
房主                                   观众
 │ 创建房间（6 位房间号）                │
 │                                      │
 │ ◄════ WebRTC：音视频通话（人像/语音）══► │
 │ ◄════ dataChannel：片源 + 播放进度 ═══► │
 │                                      │
 │  广播「正在看哪部、第几集」 ────────►  │ 自动加载同一影片
 │  每 3s 广播播放位置 ─────────────►    │
 │                                      │ 偏差 > 2s → seek 对齐
```

RTC 只传人像与语音；影片本体由两端**各自从 CDN 拉流**，靠进度对齐保持同步。
这样成本低、画质好，也不占用通话带宽。

### 通话与同步都走 WebRTC

信令复用在线 lobby 服务（`weston-vue-webrtc-lobby.azurewebsites.net`，
socket.io v4），协议细节见 `src/constants/rtc.ts`。
播放进度不再单开通道，直接走通话的 dataChannel。

**两个实测踩到的坑**（改动前务必先读）：

1. `discover` 的载荷必须是**房间名字符串**。传对象 `{}` 服务器会忽略分组，
   每个客户端只看到自己（`peers` 仅含自身），表现为「连上了但永远发现不了对方」。
2. 服务端**没有成员变更推送**，只在 discover 那一刻返回成员快照。
   后加入者能看到先到者，反之不行 —— 因此房间页采用**定时 rediscover**（3s）。

### 时间基准

**房主是唯一时间基准**，观众只跟随。观众侧用本地时钟补偿广播间隔：

```
期望位置 = 房主位置 + (本地时间 - 广播时间) / 1000
偏差 = |本地位置 - 期望位置|
偏差 > 阈值(2s) 才 seek
```

实现在 `src/utils/room-sync.ts`。

### 进入方式

| 入口 | 身份 | 行为 |
| --- | --- | --- |
| 「我的」页输入 6 位房间号 | 观众 | 片源由房主同步过来，无需自己选片 |
| 播放页点「一起看」 | 房主 | 带着当前影片进房 |
| 「我的」页「自己开一个」 | 房主 | 进房后再挑片 |

房主中途回首页挑片时，房间号会保留（见 `saveActiveRoom`），
回到房间页复用同一房间，观众不会掉线。

### 通话式样

通话以**悬浮小窗**叠在播放器右上角，可「缩小」成一条，因此
**通话与观影可同时进行**，画面不被挤压。双方昵称经信令 `metadata`
交换，显示在远端画面左下角与本地小窗底部。

---

## 平台差异与限制

| 能力 | App | H5 |
| --- | --- | --- |
| 接口请求 | 直连 | dev 走 Vite 代理，生产需后端同源 |
| m3u8 播放 | renderjs + hls.js | renderjs + hls.js |
| 跨域取流 | 不受限 | **受限** |
| 双人 RTC | 支持 | 支持（WebRTC） |

### H5 的硬约束

片源 CDN **不返回 CORS 头**，浏览器直接拉流会被同源策略拦截。

实测结果：

```
Origin: https://example.com  →  200（无 Access-Control-Allow-Origin）
```

因此 H5 生产环境需要**同源中转**：由自家后端代理 m3u8 与分片，
并**改写 m3u8 内的分片地址**（CDN 返回的是绝对地址，原样转发浏览器会直奔 CDN 又被拦）。

App 端无此问题，可直连。

---

## 代码规范

- 文件名小写，单词间用 `-` 连接
- TS 用单引号，模板属性用双引号，SCSS 用双引号
- 标签属性超过 2 个时换行排版
- 关键词、冒号、逗号后留一个空格
- 句尾加分号
- 不同功能的代码块之间插入空行

格式化：

```bash
pnpm lintfix
```

提交前只格式化本次变更的文件：

```bash
prettier --write <变更文件列表>
git diff --check
```

---

## 免责声明

本项目为技术学习与协议分析产物。接口与数据结构均来自对公开 APK 的静态分析，
内容版权归原始权利人所有。请勿用于商业用途。
