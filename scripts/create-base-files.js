/**
 * 保证 src/pages.json 与 src/manifest.json 存在。
 *
 * 背景：uni-app 的 CLI 会在 Vite 启动**之前**读取 src/manifest.json
 * （`initEnv` → `parseManifestJson`），而 @uni-helper 的 Vite 插件
 * 是在配置阶段才生成它 —— 启动顺序上插件来不及。
 *
 * 因此这里在 pre 钩子里先落一份实体文件；
 * 之后 Vite 插件运行时会基于 pages.config.ts / manifest.config.ts 覆盖它。
 *
 * 若文件已存在则不覆盖，避免把用户手工调整过的配置冲掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

const PAGES_MIN = {
    pages: [
        { path: 'pages/index/index', style: { navigationBarTitleText: '映话' } },
        { path: 'pages/category/category', style: { navigationBarTitleText: '分类' } },
        { path: 'pages/mine/mine', style: { navigationBarTitleText: '我的' } }
    ],
    globalStyle: {
        navigationStyle: 'custom',
        navigationBarTitleText: '映话',
        navigationBarBackgroundColor: '#0b0d10',
        navigationBarTextStyle: 'white',
        backgroundColor: '#0b0d10'
    }
};

const MANIFEST_MIN = {
    name: '映话',
    appid: '__UNI__YINGHUA',
    description: '映话 - 一起看，聊着看',
    versionName: '1.0.0',
    versionCode: '100',
    transformPx: false,
    vueVersion: '3'
};

const targets = [
    { file: 'src/pages.json', data: PAGES_MIN },
    { file: 'src/manifest.json', data: MANIFEST_MIN }
];

for (const { file, data } of targets) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
    console.log(`[init-base-files] created ${file}`);
}
