/**
 * 视频通话信令配置。
 *
 * ## 服务端
 *
 * 复用毕业设计（`exam-interview`）在线的信令服务：
 * `weston-vue-webrtc-lobby.azurewebsites.net`（socket.io v4）。
 *
 * 已实测（2026-09）：
 *   - `GET /` 返回 `Lobby server<br/>rooms: N<br/>members: N`
 *   - `EIO=4` 握手成功、`EIO=3` 返回 400 → 服务端为 socket.io v4
 *   - 事件名与 simple-signal 协议一致（见下）
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

/** 信令服务地址。 */
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
 * ICE 服务器配置。
 *
 * ## 为什么要多个 STUN
 *
 * STUN 只用来「发现自己的公网地址」（srflx 候选）。两端都拿到公网地址后，
 * 多数家庭宽带下可直接 P2P 打通，不必依赖 TURN 中转。
 *
 * 但单个 STUN 服务器并不总是可达 —— 本机实测（2026-09）：
 *   stun.l.google.com / stun1.l.google.com / stun.miwifi.com / stun.chat.bilibili.com  可达
 *   stun.qq.com:3478                                                                  超时
 * 因此这里**并列多个**，浏览器/WebView 会并发查询，任一成功即可。
 * 只配一个的话，那个正好不通就收集不到公网候选，
 * 双方都只有内网地址（srflx 缺失），跨网络连接直接失败。
 *
 * ## 关于 TURN
 *
 * 严格对称型 NAT 或企业网络下，P2P 仍可能打不通，此时必须有 TURN 中转。
 * 公共免费 TURN 稀缺且不稳定，故本工程不内置 ——
 * 若你的场景需要跨复杂网络，请自建 coturn 并在此追加：
 *   { urls: 'turn:你的主机:3478', username: '...', credential: '...' }
 */
export const ICE_SERVERS: RTCIceServer[] = [
    // Google 公共 STUN：用于发现公网地址
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // 国内可用备选（实测可达）
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' }
];
