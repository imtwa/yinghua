/**
 * 视频通话信令配置。
 *
 * ⚠️ **本文件不参与运行**。
 *
 * 通话的实质逻辑跑在 `components/yh-rtc/yh-rtc.vue` 的 **renderjs** 段，
 * 而 renderjs 不能 `import` —— 因此信令地址、ICE 列表、事件名常量
 * 在那边**各存了一份**，实际生效的是那一份。本文件仅作参考与类型说明，
 * 改动时必须两边同步，否则会出现「改了没生效」的困惑。
 *
 * ## 服务端
 *
 * 自建服务见仓库 `deploy/` 目录（信令 + coturn 一键部署）。
 * 此前借用的 `weston-vue-webrtc-lobby.azurewebsites.net` 在海外且不稳定
 * （实测频繁 `信令连接失败：timeout`），现已改为可配置：
 * 页面从 `VITE_RTC_SIGNAL_URL` 读地址、经 prop 传入 renderjs。
 *
 * ## 协议（实测抓包确认）
 *
 * 客户端 → 服务端：
 *   `simple-signal[discover]`  载荷必须是**房间名字符串**
 *   `simple-signal[offer]`     { signal, metadata, sessionId, target }
 *   `simple-signal[signal]`    { signal, metadata, sessionId, target }
 *   `simple-signal[reject]`    { metadata, sessionId, target }
 *
 * 服务端 → 客户端：
 *   `simple-signal[discover]`  { id, discoveryData: { peers: string[] } }
 *   `simple-signal[offer]`     { initiator, metadata, sessionId, signal }
 *   `simple-signal[signal]`    { sessionId, signal, metadata }
 *   `simple-signal[reject]`    { sessionId, metadata }
 *
 * ⚠️ 两个实测踩到的坑，务必注意：
 *   1. `discover` 的载荷**不能是对象** —— 传 `{}` 服务器会忽略分组，
 *      每个客户端只看到自己（peers 仅含自身）。必须传房间名字符串。
 *   2. 服务端只在 discover **那一刻**返回成员快照。后加入者能看到先到者，
 *      但先到者不会自动收到通知，需**重新 discover** 才能发现新成员。
 *      通话页因此采用「定时 rediscover」+「入房即双向 discover」。
 */

/** 内置信令服务地址（兜底）。生产环境应改用 `VITE_RTC_SIGNAL_URL`。 */
export const SIGNAL_URL = 'https://weston-vue-webrtc-lobby.azurewebsites.net';

/** 事件名常量（与服务端约定，不可改动）。 */
export const SIGNAL_EVENTS = {
    discover: 'simple-signal[discover]',
    offer: 'simple-signal[offer]',
    signal: 'simple-signal[signal]',
    reject: 'simple-signal[reject]'
} as const;

/**
 * 重新 discover 的间隔（毫秒）。
 *
 * 用于发现中途加入的成员。实测服务端无成员变更推送，
 * 只能靠轮询；3 秒是「发现及时」与「请求量」的折中。
 */
export const REDISCOVER_INTERVAL = 3000;

/** 连接超时（毫秒）。 */
export const CONNECT_TIMEOUT = 15000;

/**
 * 兜底 STUN 列表。
 *
 * ## 只有 STUN 是不够的
 *
 * STUN 仅用于「发现自己的公网地址」（srflx 候选）。两端都拿到公网地址后，
 * 简单 NAT 下可直接 P2P 打通，但**对称型 NAT / CGNAT 下打洞必然失败** ——
 * 此时唯一出路是 TURN 中继，而国内移动网络几乎都是这种情况。
 *
 * 因此本工程的实际做法是：由信令服务的 `/rtc-config` 在**运行时**下发
 * ICE 列表（含 TURN 临时凭据），本数组只作拉取失败时的兜底。
 *
 * ## 为什么并列多个 STUN
 *
 * 单个服务器不一定可达 —— 实测：
 *   stun.l.google.com / stun1.l.google.com / stun.miwifi.com / stun.chat.bilibili.com  可达
 *   stun.qq.com:3478                                                                  超时
 * 因此并列多个，任一成功即可。
 */
export const ICE_SERVERS: RTCIceServer[] = [
    // Google 公共 STUN：用于发现公网地址
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // 国内可用备选（实测可达）
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' }
];
