import { defineUniPages } from '@uni-helper/vite-plugin-uni-pages';
import { tabBar } from './src/tabbar/config';

/**
 * pages.json 生成配置。
 *
 * easycom 规则：
 *   - `yh-*`  → 本项目自研组件（src/components/yh-xxx/yh-xxx.vue）
 *   - `wd-*`  → wot-design-uni 组件库
 *   - `z-paging*` → 分页组件
 *
 * 自研组件统一加 `yh-` 前缀（映话），避免与内置组件（view / text 等）重名。
 */
export default defineUniPages({
    globalStyle: {
        navigationStyle: 'custom',
        navigationBarTitleText: '映话',
        navigationBarBackgroundColor: '#0b0d10',
        navigationBarTextStyle: 'white',
        backgroundColor: '#0b0d10',
        // 页面容器背景色（App / H5 / 小程序）
        backgroundColorContent: '#0b0d10',
        // iOS 上下回弹区域的背景色，与页面底色一致，避免露出白边
        backgroundColorTop: '#0b0d10',
        backgroundColorBottom: '#0b0d10',
        // 关闭下拉刷新
        enablePullDownRefresh: false,
        /* App 端：禁止整页橡皮筋回弹 */
        'app-plus': {
            bounce: 'none',
            // 关闭下拉刷新时的回弹动画
            pullToRefresh: {
                support: false
            }
        },
        /* H5 端：禁止滚动链与回弹 */
        h5: {
            // 页面级滚动容器行为，交由 App.vue 的全局 CSS 处理
        }
    },
    easycom: {
        autoscan: true,
        custom: {
            '^yh-(.*)': '@/components/yh-$1/yh-$1.vue',
            '^(?!z-paging-refresh|z-paging-load-more)z-paging(.*)':
                'z-paging/components/z-paging$1/z-paging$1.vue',
            '^wd-(.*)': 'wot-design-uni/components/wd-$1/wd-$1.vue'
        }
    },
    // tabbar 统一在 src/tabbar/config.ts 维护
    tabBar: tabBar as any
});
