import type { ProxyOptions } from 'vite';

interface CreateProxyOptions {
    /** 本地代理前缀，默认 /api */
    prefix: string;
    /** 上游主机名，如 u.yyxdmn.com */
    host: string;
    /** 上游协议，默认 https */
    protocol: string;
}

/**
 * 生成 Vite devServer 代理配置。
 *
 * 仅 H5 本地开发使用，用于绕开浏览器跨域：
 * 接口域名不返回 CORS 头，浏览器直连会被同源策略拦截。
 * App 端无此限制，直连接口域名即可。
 *
 * 注意：**不做 rewrite**。
 * 接口本身的业务路径就带 `/api` 前缀（如 `/api/channel/get_list`），
 * 若在此处再剥掉一层，转发到上游就成了 `/channel/get_list`，会 404。
 */
export function createProxy({ prefix, host, protocol = 'https' }: CreateProxyOptions): Record<string, ProxyOptions> {
    return {
        [prefix]: {
            target: `${protocol}://${host}`,
            changeOrigin: true,
            secure: false
        }
    };
}

/**
 * 内容源代理。
 *
 * 采集源（苹果CMS v10 标准接口）同样**不返回 CORS 头**，
 * H5 端必须经由 devServer 代理转发。
 *
 * 每个源分配一个前缀 `/src-<n>`，请求时把前缀换成真实域名。
 * 前缀与真实地址的对应关系在 `src/constants/source.ts` 中维护，
 * 两处需保持一致。
 */
export interface SourceProxyItem {
    /** 本地前缀，如 /src-0 */
    prefix: string;
    /** 上游主机名，如 bfzyapi.com */
    host: string;
    /** 上游协议 */
    protocol?: string;
}

export function createSourceProxies(items: SourceProxyItem[]): Record<string, ProxyOptions> {
    const out: Record<string, ProxyOptions> = {};
    for (const it of items) {
        out[it.prefix] = {
            target: `${it.protocol || 'https'}://${it.host}`,
            changeOrigin: true,
            secure: false
        };
    }
    return out;
}
