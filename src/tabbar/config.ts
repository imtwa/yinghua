import type { TabBar } from '@uni-helper/vite-plugin-uni-pages';

/**
 * tabbar 配置。
 *
 * 采用原生 tabbar + 纯文字（不配图标）。
 * 理由：本应用内容为影片海报，界面已足够丰富；
 * 文字 tabbar 更克制，也避免图标资源缺失导致的构建告警。
 *
 * 注意：修改本文件后需重启 dev server，pages.json 才会更新。
 */

export const TABBAR_STRATEGY_MAP = {
    NO_TABBAR: 0,
    NATIVE_TABBAR: 1,
    CUSTOM_TABBAR: 2
} as const;

export const selectedTabbarStrategy = TABBAR_STRATEGY_MAP.NATIVE_TABBAR;

/** tabbar 页面列表，pagePath 必须与 pages 目录下的实际路径一致。 */
export const nativeTabbarList = [
    {
        pagePath: 'pages/index/index',
        text: '首页'
    },
    {
        pagePath: 'pages/category/category',
        text: '分类'
    },
    {
        pagePath: 'pages/mine/mine',
        text: '我的'
    }
];

export const tabbarList = nativeTabbarList;

const _tabbar: TabBar = {
    color: '#6b7280',
    selectedColor: '#f0a63c',
    backgroundColor: '#14171c',
    borderStyle: 'black',
    list: nativeTabbarList as unknown as TabBar['list']
};

export const tabBar = _tabbar;
