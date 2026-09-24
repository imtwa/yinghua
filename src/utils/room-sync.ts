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
    /** 记录写入时间戳，用于判断是否还在同一次使用会话内 */
    savedAt?: number;
    /** 写入时所在的运行会话标识（见 SESSION_ID） */
    session?: string;
}

/**
 * 本次 App 运行的会话标识。
 *
 * 模块级常量，**每次 App 启动都会重新生成** ——
 * 因此「记录里的 session 与当前不一致」就等价于「App 重启过」。
 *
 * 为什么不能只靠时间戳：用户 swipe 掉 App 立刻重开（几秒内），
 * 时间戳仍在有效期内，记录会被误判为可用，
 * 表现为「退出重进后开一个房间，却残留上一次的视频」。
 * 会话标识没有这个时间窗口问题。
 */
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 房间记录的兜底有效期（毫秒）。
 *
 * 会话标识已能覆盖「重启 App」的场景，这个 TTL 只用来兜住
 * 长时间挂后台（JS 上下文未重建但已隔夜）的情况。
 * 取 6 小时：足够一次连续观影，又不会让陈旧记录跨天存活。
 */
const ROOM_TTL = 6 * 60 * 60 * 1000;

/**
 * 记住当前房间。
 *
 * 为什么需要：房主可能中途去选片页挑片，或从播放页点「一起看」
 * 再接回原房间。房间号若只存在页面局部状态里，一离开就丢，
 * 回来会新建房间、观众找不到人。
 */
export function saveActiveRoom(info: ActiveRoom) {
    try {
        uni.setStorageSync(ROOM_KEY, { ...info, savedAt: Date.now(), session: SESSION_ID });
    } catch {
        /* 忽略 */
    }
}

/**
 * 读取当前房间（无、已过期、或不属于本次运行会话时返回 null）。
 *
 * 返回 null 即视为无记录 —— 调用方会因此新建房间，
 * 这正是「重启 App 后点开一个，应该是全新房间」的预期行为。
 */
export function loadActiveRoom(): ActiveRoom | null {
    try {
        const v = uni.getStorageSync(ROOM_KEY) as ActiveRoom | '';
        if (!v || typeof v !== 'object' || !isRoomCode(v.roomId)) return null;

        /*
         * 会话不符 → App 重启过 → 记录作废。
         * 这条是解决「退出重进 App 后残留上次视频」的关键：
         * 记录存在本地存储里，重启不会自动清除，只能靠会话标识识别。
         */
        if (v.session !== SESSION_ID) {
            clearActiveRoom();
            return null;
        }

        // 时间兜底：长时间挂后台（JS 上下文未重建）也算过期
        if (!v.savedAt || Date.now() - v.savedAt > ROOM_TTL) {
            clearActiveRoom();
            return null;
        }
        return v;
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

/* ------------------------------------------------------------------
 * 房主换片：选片结果的跨页传递
 * ------------------------------------------------------------------ */

const PICK_KEY = 'yinghua_pending_pick';

export interface PendingPick {
    vodId: number;
    vodName: string;
    vodPic: string;
}

/**
 * 暂存「房主刚选中的影片」。
 *
 * 为什么用存储而不是页面参数：选片页是**独立页面**（用 navigateTo 打开，
 * 房间页留在栈里不销毁，通话因此不断），选完要 `navigateBack` 返回。
 * 返回时无法带参，只能借存储把结果交回房间页。
 *
 * 房间页在 onShow 里读取并立即清除，保证一次性消费 ——
 * 否则用户下次从别的路径回到房间页，会被这条陈旧记录又切一次片。
 */
export function savePendingPick(pick: PendingPick) {
    try {
        uni.setStorageSync(PICK_KEY, pick);
    } catch {
        /* 忽略 */
    }
}

/** 读取待应用的选片结果（无则返回 null）。 */
export function loadPendingPick(): PendingPick | null {
    try {
        const v = uni.getStorageSync(PICK_KEY) as PendingPick | '';
        if (v && typeof v === 'object' && v.vodId) return v;
    } catch {
        /* 忽略 */
    }
    return null;
}

/** 清除待应用的选片结果。 */
export function clearPendingPick() {
    try {
        uni.removeStorageSync(PICK_KEY);
    } catch {
        /* 忽略 */
    }
}
