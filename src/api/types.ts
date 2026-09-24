/** 接口通用响应包装。 */
export interface ApiResponse<T = any> {
    code: number;
    message: string;
    result: T;
}

/** 频道（首页 tab）。对应 `/api/channel/get_list`。 */
export interface Channel {
    id: number;
    channel_name: string;
    vod_type_id: number;
}

/** 剧集。对应 `vod_collection[]` 元素，即原包 `BaseContentInfoBean`。 */
export interface Collection {
    id: number;
    collection: number;
    title: string;
    vod_id: number;
    vod_token: string;
    cur_time: string;
    vod_url: string;
    ck: string;
    duration: string;
    is_p2p: number;
    is_selected: number;
    position: number;
}

/** 影片。列表与详情共用。 */
export interface Vod {
    id: number;
    vod_id: number;
    vod_name: string;
    vod_pic: string;
    vod_year: string;
    vod_serial: string;
    vod_actors: string;
    vod_area: string;
    vod_lang: string;
    vod_remarks: string;
    vod_score: string;
    vod_content: string;
    vod_total: number;
    type_pid: number;
    vod_collection?: Collection[];
}

/** 首页模块（含 banner 与影片列表）。 */
export interface HomeModule {
    module_id: number;
    module_name: string;
    type: number;
    is_title: number;
    is_more: number;
    is_change: number;
    block_list: HomeBlock[];
}

/** 首页模块内的区块。 */
export interface HomeBlock {
    banner_pic?: string;
    jump_url?: string;
    topic_id?: number;
    vod_info?: Vod;
    vod_list?: Vod[];
}

/** 播放信息。对应 `/api/video/collection` 的 result。 */
export interface PlayInfo {
    id: number;
    vod_id: number;
    vod_token: string;
    vod_url: string;
    out_vod_url: string;
    tc_vod_url: string;
    sub_vod_url: string;
    ck: string;
    header_json: string;
    is_p2p: number;
    source_id: number;
    server_time: number;
    title: string;
    title_desc: string;
    duration: string;
}

/** 播放地址解析结果，交给播放器使用。 */
export interface ResolvedPlay {
    /** 可直接播放的地址 */
    url: string;
    /** 备用线路 */
    backups: string[];
    /** 剧集标题 */
    title: string;
    /** 是否走 P2P（仅记录，本客户端不使用） */
    isP2p: number;
    /** 片源 id */
    sourceId: number;
}
