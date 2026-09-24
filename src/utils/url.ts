/**
 * 跨域地址处理。
 *
 * ## 背景
 *
 * 采集源接口与片源 CDN **都不返回 CORS 头**，且片源域名是**动态的**
 * （每部影片的 CDN 主机不同），因此无法用静态 proxy 规则覆盖。
 *
 * ## 策略
 *
 * - **H5 开发期**：把地址包装成 `/__p/<base64url>`，由 devServer 中间件转发
 *   （见 vite-plugins/h5-cors-proxy.ts）
 * - **H5 生产**：同样走 `/__p/` 前缀，需在 nginx 配置等价反向代理
 * - **App 端**：无同源限制，直接使用原始地址
 */

/** 代理前缀，需与 vite-plugins/h5-cors-proxy.ts 保持一致。 */
const PROXY_PREFIX = '/__p/';

/**
 * 判断是否需要走本地代理。
 *
 * 仅 H5 端需要；App 端（含小程序）直接请求。
 */
export function needProxy(): boolean {
    // #ifdef H5
    return true;
    // #endif

    // #ifndef H5
    return false;
    // #endif
}

/**
 * 把真实地址包装为可跨域访问的地址。
 *
 * @param url 原始地址（http/https）
 * @returns H5 端返回代理地址，其它端返回原地址
 */
export function wrapUrl(url: string): string {
    if (!url || !/^https?:\/\//.test(url)) {
        return url;
    }
    if (!needProxy()) {
        return url;
    }

    // base64url 编码（去掉 padding，避免路径中出现 = 引发歧义）
    const b64 = btoa(unescape(encodeURIComponent(url)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    return `${PROXY_PREFIX}${b64}`;
}

/**
 * 还原被包装的地址（用于日志展示）。
 *
 * @param url 可能是代理地址
 * @returns 原始地址
 */
export function unwrapUrl(url: string): string {
    if (!url || !url.startsWith(PROXY_PREFIX)) {
        return url;
    }
    try {
        const raw = url.slice(PROXY_PREFIX.length).split('?')[0];
        const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        return decodeURIComponent(escape(atob(b64 + pad)));
    } catch {
        return url;
    }
}
