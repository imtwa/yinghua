import type { Plugin } from 'vite';
import http from 'node:http';
import https from 'node:https';

/**
 * H5 开发期跨域代理。
 *
 * ## 为什么需要它
 *
 * 采集源接口与片源 CDN **都不返回 CORS 头**，浏览器直连会被同源策略拦截。
 * 且片源域名是**动态的**（每部影片的 CDN 主机不同，如 `bfeng11.com`、
 * `tyyszywvod2.com`），无法像固定接口那样预先枚举成静态 proxy 规则。
 *
 * ## 用法
 *
 * 把目标地址做 base64url 编码后拼到 `/__p/` 之后：
 *
 *   /__p/aHR0cHM6Ly9leGFtcGxlLmNvbS9hLm0zdTg
 *
 * 中间件解码后转发请求，并回写响应（含 Range 支持，视频分片需要）。
 *
 * ## m3u8 重写（关键）
 *
 * m3u8 里的分片是**相对路径**（如 `output_000000.ts`）。
 * 若原样返回，浏览器会把它解析到 `/__p/` 下，导致 404。
 * 故对 m3u8 响应做重写：把每个分片行换成**绝对地址再包装**的代理地址。
 *
 * ## 生效范围
 *
 * **仅开发期**（`vite dev`）。生产构建产物不含此中间件，
 * 部署 H5 时需在 nginx 配置等价的反向代理（见 README「H5 部署」）。
 * App 端无同源限制，不走此代理。
 */
export function createH5CorsProxy(): Plugin {
    const PREFIX = '/__p/';

    /** 包装成代理地址。 */
    const wrap = (target: string): string => {
        const b64 = Buffer.from(target, 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        return `${PREFIX}${b64}`;
    };

    return {
        name: 'yh-h5-cors-proxy',
        apply: 'serve',

        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url || !req.url.startsWith(PREFIX)) {
                    next();
                    return;
                }

                // 解析目标地址
                let target = '';
                try {
                    const raw = req.url.slice(PREFIX.length).split('?')[0];
                    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
                    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
                    target = Buffer.from(b64 + pad, 'base64').toString('utf8');
                } catch {
                    res.statusCode = 400;
                    res.end('bad target');
                    return;
                }

                if (!/^https?:\/\//.test(target)) {
                    res.statusCode = 400;
                    res.end('bad target');
                    return;
                }

                // 转发原始查询串（若有）
                const qs = req.url.indexOf('?');
                if (qs >= 0) {
                    target += req.url.slice(qs);
                }

                const u = new URL(target);
                const client = u.protocol === 'https:' ? https : http;

                const proxyReq = client.request(
                    {
                        protocol: u.protocol,
                        hostname: u.hostname,
                        port: u.port || (u.protocol === 'https:' ? 443 : 80),
                        path: u.pathname + u.search,
                        method: req.method,
                        headers: {
                            'User-Agent':
                                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            Accept: (req.headers.accept as string) || '*/*',
                            ...(req.headers.range ? { Range: req.headers.range as string } : {})
                        },
                        timeout: 25000
                    },
                    upstream => {
                        const ctype = String(upstream.headers['content-type'] || '');
                        const isPlaylist =
                            ctype.indexOf('mpegurl') >= 0 ||
                            ctype.indexOf('m3u') >= 0 ||
                            /\.m3u8(\?|$)/i.test(u.pathname);

                        // 回写上游响应头
                        for (const [k, v] of Object.entries(upstream.headers)) {
                            if (v === undefined) continue;
                            const key = k.toLowerCase();
                            if (key === 'transfer-encoding' || key === 'content-length') continue;
                            // m3u8 要改写，长度会变，跳过 content-type 保留即可
                            try {
                                res.setHeader(k, v as any);
                            } catch {
                                /* 忽略非法头 */
                            }
                        }
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Access-Control-Allow-Headers', '*');
                        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

                        if (!isPlaylist) {
                            res.statusCode = upstream.statusCode || 502;
                            upstream.pipe(res);
                            return;
                        }

                        // ---- m3u8：缓冲后重写分片地址 ----
                        const chunks: Buffer[] = [];
                        upstream.on('data', c => chunks.push(c as Buffer));
                        upstream.on('end', () => {
                            const text = Buffer.concat(chunks).toString('utf8');

                            // 若非 m3u8（有些源返回错误页），原样返回
                            if (text.indexOf('#EXTM3U') < 0) {
                                res.statusCode = upstream.statusCode || 502;
                                res.end(text);
                                return;
                            }

                            // 基准目录：分片相对此目录解析
                            const baseDir = u.href.slice(0, u.href.lastIndexOf('/') + 1);

                            const lines = text.split(/\r?\n/);
                            const out = lines.map(line => {
                                const t = line.trim();
                                if (!t || t.startsWith('#')) {
                                    // 保留注释行（含 #EXT-X-KEY 的 URI 属性暂不处理）
                                    return line;
                                }
                                // 分片行：转绝对地址后包装
                                const abs = /^https?:\/\//.test(t) ? t : baseDir + t;
                                return wrap(abs);
                            });

                            const body = out.join('\n');
                            res.statusCode = upstream.statusCode || 200;
                            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                            res.setHeader('Content-Length', Buffer.byteLength(body));
                            res.end(body);
                        });
                    }
                );

                proxyReq.on('timeout', () => {
                    proxyReq.destroy();
                    if (!res.headersSent) {
                        res.statusCode = 504;
                        res.end('upstream timeout');
                    }
                });

                proxyReq.on('error', () => {
                    if (!res.headersSent) {
                        res.statusCode = 502;
                        res.end('upstream error');
                    }
                });

                req.pipe(proxyReq);
            });
        }
    };
}
