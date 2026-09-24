/**
 * 统一请求封装。
 *
 * 数据源为公开采集源（苹果CMS v10 标准接口），特点：
 *   - GET + JSON，无加密、无签名、无需 token
 *   - 因此这里只保留最简的请求与日志能力
 *
 * 与旧版对比：原先面向原 APK 的 POST 表单 + 签名 + AES 解密逻辑已整体移除，
 * 因为换源后不再需要（详见 README「数据源」章节）。
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('http');

export interface RequestOptions {
    /** 完整请求地址 */
    url: string;
    /** 查询参数（会拼到 URL 上） */
    query?: Record<string, any>;
    /** 请求方法，默认 GET */
    method?: 'GET' | 'POST';
    /** 请求体（POST 时使用） */
    data?: Record<string, any>;
    /** 是否静默失败（不弹 toast） */
    silent?: boolean;
    /** 超时时间，默认 20s */
    timeout?: number;
}

/** 拼接查询串。 */
function buildQuery(query?: Record<string, any>): string {
    if (!query) return '';
    const parts = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * 发送请求，返回解析后的数据。
 *
 * 采集源直接返回 JSON，无需解密。
 */
export function request<T = any>(options: RequestOptions): Promise<T> {
    const { url, query, method = 'GET', data, silent = false, timeout = 20000 } = options;
    const fullUrl = `${url}${buildQuery(query)}`;

    log.info(`请求 ${fullUrl}`);

    return new Promise<T>((resolve, reject) => {
        uni.request({
            url: fullUrl,
            method,
            data,
            timeout,
            header: { Accept: 'application/json,*/*' },
            dataType: 'json',
            success: res => {
                if (res.statusCode !== 200) {
                    log.error(`请求失败 ${fullUrl}`, `HTTP ${res.statusCode}`);
                    if (!silent) {
                        uni.showToast({ icon: 'none', title: `网络错误 ${res.statusCode}` });
                    }
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                log.info(`返回 ${fullUrl}`, res.data);
                resolve(res.data as T);
            },
            fail: err => {
                log.error(`请求异常 ${fullUrl}`, err);
                if (!silent) {
                    uni.showToast({ icon: 'none', title: '网络异常，请稍后重试' });
                }
                reject(err);
            }
        });
    });
}

/**
 * 拉取纯文本（用于 m3u8 探测）。
 *
 * 片源 CDN 是公开 HTTP 服务，裸 GET 即可。
 * H5 端受同源策略限制无法直连，见 README「H5 限制」。
 */
export function requestRaw(url: string, timeout = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
        uni.request({
            url,
            method: 'GET',
            timeout,
            dataType: 'text',
            success: res => {
                if (res.statusCode === 200) {
                    resolve(res.data as string);
                } else {
                    log.warn('拉流失败', res.statusCode, url.slice(0, 120));
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            },
            fail: err => {
                log.warn('拉流异常', url.slice(0, 120), err);
                reject(err);
            }
        });
    });
}
