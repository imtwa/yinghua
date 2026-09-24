/**
 * 双人同步观影 —— 房间同步逻辑。
 *
 * ## 两条独立通道
 *
 * 1. **影片流**：各自拉 CDN，不走 RTC。靠「进度对齐」保持同步 ——
 *    省带宽、画质最好、实现最简。
 * 2. **通话流**：WebRTC 传人像与语音（见 components/yh-rtc）。
 *
 * 通话的信令复用毕业设计在线的 lobby 服务（协议见 constants/rtc.ts），
 * 播放进度也经同一条 WebRTC 通道的 dataChannel 交换，
 * 因此不再需要单独的 WebSocket 同步通道。
 *
 * 时间基准：**房主为唯一基准**，观众只跟随。
 */

export interface RoomState {
    playing: boolean;
    /** 房主侧播放位置（秒） */
    position: number;
    /** 房主广播时的本地时间戳 */
    updatedAt: number;
}

export type RoomMessage =
    | ({ type: 'state' } & RoomState)
    | { type: 'seek'; position: number }
    | { type: 'episode'; collectionId: number; index: number }
    | { type: 'chat'; text: string; from: string };

/** 允许的最大进度偏差（秒），超过才 seek。 */
export const DRIFT_THRESHOLD = 2;

/** 房主广播播放状态的间隔（毫秒）。 */
export const STATE_BROADCAST_INTERVAL = 3000;

/**
 * 计算观众侧需要 seek 到的目标位置。
 *
 * 用本地时钟补偿广播间隔：
 * 收到 `{playing: true, position: P, updatedAt: T}` 后，
 * 经过 `now - T` 毫秒，房主实际已播到 `P + (now - T) / 1000`。
 *
 * @returns 需要 seek 的目标秒数；返回 null 表示偏差在阈值内，无需处理
 */
export function computeSyncTarget(
    localPosition: number,
    state: RoomState,
    threshold = DRIFT_THRESHOLD
): number | null {
    const elapsed = (Date.now() - state.updatedAt) / 1000;
    const expected = state.position + (state.playing ? elapsed : 0);
    const drift = Math.abs(localPosition - expected);
    return drift > threshold ? expected : null;
}

/** 生成房间号（6 位大写字母数字，便于口播）。 */
export function generateRoomId(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}

/**
 * 校验房间号格式。
 *
 * 与 generateRoomId 使用同一字符集（去掉了易混淆的 I/O/0/1），
 * 因此用户手输时不会因为形近字符而对不上。
 */
export function isRoomCode(code: string): boolean {
    return /^[A-HJ-NP-Z2-9]{6}$/.test((code || '').toUpperCase());
}

/* ------------------------------------------------------------------
 * 房间号的跨页保留
 * ------------------------------------------------------------------ */

const ROOM_KEY = 'yinghua_active_room';

export interface ActiveRoom {
    roomId: string;
    isHost: boolean;
    /** 影片信息（房主选好片后写入，供返回房间时恢复） */
    vodId?: number;
    index?: number;
}

/**
 * 记住当前房间。
 *
 * 为什么需要：房主可能中途回首页挑片，或从播放页点「一起看」
 * 再接回原房间。房间号若只存在页面局部状态里，一离开就丢，
 * 回来会新建房间、观众找不到人。
 */
export function saveActiveRoom(info: ActiveRoom) {
    try {
        uni.setStorageSync(ROOM_KEY, info);
    } catch {
        /* 忽略 */
    }
}

/** 读取当前房间（无则返回 null）。 */
export function loadActiveRoom(): ActiveRoom | null {
    try {
        const v = uni.getStorageSync(ROOM_KEY) as ActiveRoom | '';
        if (v && typeof v === 'object' && isRoomCode(v.roomId)) return v;
    } catch {
        /* 忽略 */
    }
    return null;
}

/** 清除房间（主动退出时调用）。 */
export function clearActiveRoom() {
    try {
        uni.removeStorageSync(ROOM_KEY);
    } catch {
        /* 忽略 */
    }
}
