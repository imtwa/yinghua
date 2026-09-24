/**
 * 用户资料（纯本地）。
 *
 * 本应用数据源为公开采集源，**没有账号体系**，因此不存在服务端昵称。
 * 这里为用户生成一个默认昵称并持久化：
 *   - 首次进入时随机取名（如「映画7K2M9Q」），避免界面出现空白称谓
 *   - 用户可在「我的」页自行修改
 *
 * 昵称只存本地，不上报任何服务端。
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('profile');

const NICKNAME_KEY = 'yinghua_nickname';

/**
 * 默认昵称用的字符集。
 *
 * 去掉易混淆的 `0/O`、`1/I/L`，避免用户口播或转述时出错。
 */
const SUFFIX_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 随机后缀长度。 */
const SUFFIX_LEN = 6;

/**
 * 生成本地默认昵称，形如「映画7K2M9Q」。
 *
 * 36^6 ≈ 22 亿种组合，重合概率可忽略；即便撞了也无妨 ——
 * 昵称随时可改，且不参与任何身份判定（房间靠 6 位房间号区分）。
 */
export function makeDefaultNickname(): string {
    let suffix = '';
    for (let i = 0; i < SUFFIX_LEN; i++) {
        suffix += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)];
    }
    return `映画${suffix}`;
}

/**
 * 读取昵称；不存在时生成一个并落盘。
 *
 * 注意：这里**必须写回存储**而不是每次现算 ——
 * 否则每次进「我的」页都会看到不同的昵称。
 */
export function getNickname(): string {
    try {
        const saved = uni.getStorageSync(NICKNAME_KEY) as string;
        if (saved && typeof saved === 'string' && saved.trim()) {
            return saved.trim();
        }
    } catch {
        // 读失败则走默认生成
    }

    const name = makeDefaultNickname();
    setNickname(name);
    return name;
}

/** 保存昵称（长度与空值做一次收敛）。 */
export function setNickname(name: string): string {
    const clean = (name || '').trim().slice(0, 16) || makeDefaultNickname();
    try {
        uni.setStorageSync(NICKNAME_KEY, clean);
    } catch (e) {
        log.warn('保存昵称失败', String(e));
    }
    return clean;
}

/** 头像占位字符：取昵称首字（中文取第一个字，英文取首字母大写）。 */
export function avatarChar(name: string): string {
    const n = (name || '').trim();
    if (!n) return '映';
    const first = n[0];
    return /[a-z]/.test(first) ? first.toUpperCase() : first;
}
