import path from 'node:path';
import process from 'node:process';
import Uni from '@uni-helper/plugin-uni';
import UniComponents from '@uni-helper/vite-plugin-uni-components';
// @see https://uni-helper.js.org/vite-plugin-uni-layouts
import UniLayouts from '@uni-helper/vite-plugin-uni-layouts';
// @see https://github.com/uni-helper/vite-plugin-uni-manifest
import UniManifest from '@uni-helper/vite-plugin-uni-manifest';
// @see https://uni-helper.js.org/vite-plugin-uni-pages
import UniPages from '@uni-helper/vite-plugin-uni-pages';
// @see https://github.com/uni-helper/vite-plugin-uni-platform
// 需要与 @uni-helper/vite-plugin-uni-pages 插件一起使用
import UniPlatform from '@uni-helper/vite-plugin-uni-platform';
/**
 * 分包优化、模块异步跨包调用、组件异步跨包引用
 * @see https://github.com/uni-ku/bundle-optimizer
 */
import UniOptimization from '@uni-ku/bundle-optimizer';
// https://github.com/uni-ku/root
import UniKuRoot from '@uni-ku/root';
import UnoCSS from 'unocss/vite';
import AutoImport from 'unplugin-auto-import/vite';
import { defineConfig, loadEnv } from 'vite';
import ViteRestart from 'vite-plugin-restart';
import { createProxy } from './vite-plugins/proxy';
import { createH5CorsProxy } from './vite-plugins/h5-cors-proxy';

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
    const { UNI_PLATFORM } = process.env;
    console.log('UNI_PLATFORM -> ', UNI_PLATFORM);

    const env = loadEnv(mode, path.resolve(process.cwd(), 'env'));
    const { VITE_APP_PORT, VITE_APP_PROXY_ENABLE, VITE_API_HOST, VITE_API_PROTOCOL, VITE_DELETE_CONSOLE } = env;
    console.log('环境变量 env -> ', env);

    // H5 dev 走 devServer 代理绕开跨域；App / 生产直连接口域名。
    const proxyEnabled = VITE_APP_PROXY_ENABLE === 'true' && UNI_PLATFORM === 'h5' && command === 'serve';

    return defineConfig({
        // 自定义 env 目录
        envDir: './env',
        base: '/',
        plugins: [
            // UniXXX 需要在 Uni 之前引入
            UniLayouts(),
            UniPlatform(),
            UniManifest(),
            UniComponents({
                extensions: ['vue'],
                // 是否递归扫描子目录
                deep: true,
                // 是否把目录名作为命名空间前缀
                directoryAsNamespace: false,
                // 自动生成的组件类型声明文件路径
                dts: 'src/types/components.d.ts'
            }),
            UniPages({
                exclude: ['**/components/**/**.*'],
                homePage: ['pages/index/index'],
                dts: 'src/types/uni-pages.d.ts'
            }),
            // UniOptimization 插件需要 pages.json 文件，故应在 UniPages 插件之后执行
            UniOptimization({
                enable: {
                    optimization: true,
                    'async-import': true,
                    'async-component': true
                },
                dts: {
                    base: 'src/types'
                },
                logger: false
            }),
            // 若存在改变 pages.json 的插件，请将 UniKuRoot 放置其后。
            // 它负责把 App.ku.vue 注入每个页面外层，并把 <KuRootView /> 替换成 <slot />。
            UniKuRoot({
                excludePages: ['**/components/**/**.*']
            }),
            Uni(),
            // uni-h5-vite 的 define 会覆盖根配置，故在 Uni() 之后再写一次锁定 history 路由
            UNI_PLATFORM === 'h5' && {
                name: 'force-h5-history-router',
                config() {
                    return {
                        define: {
                            __UNI_FEATURE_ROUTER_MODE__: JSON.stringify('history')
                        }
                    };
                }
            },
            {
                // 规避 @dcloudio/uni-mp-compiler 的编译 BUG
                // https://github.com/dcloudio/uni-app/issues/4952
                name: 'fix-vite-plugin-vue',
                configResolved(config) {
                    const plugin = config.plugins.find(p => p.name === 'vite:vue');
                    if (plugin && plugin.api && plugin.api.options) {
                        plugin.api.options.devToolsEnabled = false;
                    }
                }
            },
            UnoCSS(),
            AutoImport({
                imports: ['vue', 'uni-app'],
                dts: 'src/types/auto-import.d.ts',
                // 自动导入 hooks
                dirs: ['src/hooks'],
                vueTemplate: true
            }),
            // 修改 vite.config.js 与 uni.scss 时自动重启，无需手动重跑
            ViteRestart({
                restart: ['vite.config.js', 'uni.scss']
            }),

            // H5 开发期跨域代理：采集源与片源 CDN 均无 CORS 头，
            // 且片源域名是动态的，故用中间件按 base64 目标动态转发
            createH5CorsProxy()
        ],
        resolve: {
            alias: {
                '@': path.join(process.cwd(), './src'),
                '@img': path.join(process.cwd(), './src/static')
            }
        },
        server: {
            host: '0.0.0.0',
            hmr: true,
            port: Number.parseInt(VITE_APP_PORT, 10),
            // 仅 H5 端生效（其他端走 build，不走 devServer）
            proxy: proxyEnabled
                ? createProxy({
                      prefix: '/api',
                      host: VITE_API_HOST,
                      protocol: VITE_API_PROTOCOL
                  })
                : undefined
        },
        esbuild: {
            drop: VITE_DELETE_CONSOLE === 'true' ? ['console', 'debugger'] : []
        },
        build: {
            sourcemap: false,
            // 方便非 h5 端调试
            target: 'es6',
            minify: mode === 'development' ? false : 'esbuild'
        }
    });
});
