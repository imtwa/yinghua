/**
 * 内容源配置。
 *
 * 采用「苹果CMS v10」标准采集接口的公开源。
 * 特点：**不使用 P2P 分发**，m3u8 与分片均可由普通 HTTP 客户端直连。
 *
 * 对比原 APK（`com.hjmore.oeqvv`）：
 *   原源走私有 P2P 协议（libpp_hls.so），普通客户端只能拿到占位警告片；
 *   本配置改用公开采集源，可直接播放。
 *
 * 已实测（分片首字节 0x47 = 真实 MPEG-TS）：
 *   暴风资源    ✅ 分片正常 + 搜索可用
 *   天涯资源    ✅ 分片正常
 *   无尽资源    ✅ 分片正常
 *   魔都资源    ✅ 分片正常
 */

export interface ContentSource {
    /** 源名称，展示用 */
    name: string;
    /** 接口基址 */
    api: string;
    /** 是否支持关键词搜索 */
    searchable: boolean;
}

/**
 * 主源：暴风资源。
 *
 * 实测（2026-09-24）：
 *   - 四个首页栏目全部有数据（短剧 20 / 动漫 20 / 连续剧 / 综艺 20）
 *   - 最新条目时间与本地时间同分钟，更新最勤
 *   - 唯一支持搜索的源
 */
export const PRIMARY_SOURCE: ContentSource = {
    name: '暴风资源',
    api: 'https://bfzyapi.com/api.php/provide/vod/',
    searchable: true
};

/**
 * 备用源列表。
 *
 * ⚠️ 选中标准是「按分类名取列表真的能返回数据」，而不是「接口能通」。
 *
 * 2026-09-24 实测 39 个候选源，结论：
 *   - 13 个接口可访问，但其中多数源的 `t=<分类id>` 几乎取不到条目
 *     （返回 n=0，或干脆返回全库混排）——这类源只有「最新」可用，
 *     放在列表中间会白白拖慢首页加载，故不选。
 *   - 只有暴风与**量子资源**的四个栏目全部可用，故量子排第一。
 *
 * 采集源寿命普遍不稳定：若某源失效，删除对应条目即可；
 * 若某源出现「分类错乱」，说明它开始忽略 t 参数，
 * 此时 fetchAny 的 type_name 校验会自动跳过它。
 */
export const BACKUP_SOURCES: ContentSource[] = [
    {
        name: '量子资源',
        api: 'https://cj.lziapi.com/api.php/provide/vod/',
        searchable: false
    },
    {
        name: '魔都资源',
        api: 'https://www.mdzyapi.com/api.php/provide/vod/',
        searchable: false
    },
    {
        name: '电影天堂',
        api: 'https://caiji.dyttzyapi.com/api.php/provide/vod/',
        searchable: false
    },
    {
        name: '红牛资源',
        api: 'https://www.hongniuzy2.com/api.php/provide/vod/',
        searchable: false
    },
    {
        name: '索尼资源',
        api: 'https://suoniapi.com/api.php/provide/vod/',
        searchable: false
    },
    {
        name: '无尽资源',
        api: 'https://api.wujinapi.me/api.php/provide/vod/',
        searchable: false
    }
];

/** 全部源（主源在前）。 */
export const ALL_SOURCES: ContentSource[] = [PRIMARY_SOURCE, ...BACKUP_SOURCES];

/** 请求超时（毫秒）。 */
export const SOURCE_TIMEOUT = 20000;

/** 每页条数（源端固定 20，此处仅作说明）。 */
export const PAGE_SIZE = 20;

/**
 * 首页栏目配置。
 *
 * ⚠️ 这里用的是**分类名称**而不是 id。
 *
 * 原因：各采集源的 type_id 完全不同 ——
 *   暴风源   短剧=58 动漫=39 连续剧=30 综艺=45
 *   量子源   短剧=46 动漫=4  连续剧=2  综艺=3
 *   无尽源   短剧=41 动漫=4  连续剧=2  综艺=3
 * 写死 id 一旦落到备用源就会取到完全无关的分类。
 * 名称由各源的分类表实时解析（见 services/video.ts 的 resolveChannelId）。
 *
 * `alias` 是同一含义的其他叫法：部分源不叫「连续剧」而叫「电视剧」、
 * 不叫「短剧」而叫「爽文短剧」。
 * 解析顺序：精确匹配 name → 精确匹配 alias → 包含匹配 name → 包含匹配 alias。
 *
 * 顺序即为首页展示顺序：短剧、动漫、连续剧、综艺。
 */
export const HOME_SECTIONS: Array<{ name: string; alias?: string[] }> = [
    { name: '短剧', alias: ['短剧大全', '爽文短剧', '擦边短剧'] },
    { name: '动漫', alias: ['动漫片', '动画片', '国产动漫'] },
    { name: '连续剧', alias: ['电视剧', '国产剧'] },
    { name: '综艺', alias: ['综艺片', '大陆综艺'] }
];

/**
 * 「最新」栏目。
 *
 * 不传 `t` 参数时，苹果CMS 默认按 `vod_time` 倒序返回 ——
 * 实测各源均满足（首条即最新条目，时间与本地时间同分钟级）。
 * 因此该栏目只需翻页，无需任何排序参数。
 *
 * 注意：实测多数源并不支持 `order`/`by` 排序参数（传了也无效），
 * 故不要试图用它做排行榜。
 */
export const LATEST_SECTION = { name: '最新' };

/** 取「最新」栏目的页数（每页 20 条）。 */
export const LATEST_PAGES = 1;
