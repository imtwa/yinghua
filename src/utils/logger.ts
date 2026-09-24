/**
 * 统一日志。
 *
 * 只打控制台，不落本地存储。手机端查看方式：
 * - Android：`adb logcat | findstr yinghua`
 * - iOS：Xcode 控制台
 * - HBuilderX：运行时控制台
 *
 * 注意：`env/.env.production` 的 `VITE_DELETE_CONSOLE` 必须为 false，
 * 否则 esbuild 会在构建时把所有 console 调用删除，连手机就看不到日志了。
 */

/** 是否输出日志（由 VITE_LOG_ENABLE 控制，默认开）。 */
const ENABLED = import.meta.env.VITE_LOG_ENABLE !== 'false';

/** 统一前缀，便于在 logcat 里过滤。 */
const PREFIX = '[映话]';

/** 中文标签，替换原来的 debug/info/warn/error。 */
const LEVEL_LABEL = {
    debug: '调试',
    info: '信息',
    warn: '警告',
    error: '错误'
} as const;

type LogLevel = keyof typeof LEVEL_LABEL;

function write(level: LogLevel, tag: string, args: any[]) {
    if (!ENABLED) return;

    const head = `${PREFIX}[${tag}][${LEVEL_LABEL[level]}]`;

    // 透传原始对象，保留控制台的可展开能力 —— 数组与对象会完整显示，不做截断
    if (level === 'error') console.error(head, ...args);
    else if (level === 'warn') console.warn(head, ...args);
    else console.log(head, ...args);
}

/** 创建带标签的 logger。 */
export function createLogger(tag: string) {
    return {
        debug: (...args: any[]) => write('debug', tag, args),
        info: (...args: any[]) => write('info', tag, args),
        warn: (...args: any[]) => write('warn', tag, args),
        error: (...args: any[]) => write('error', tag, args)
    };
}
