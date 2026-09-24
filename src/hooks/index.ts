/**
 * 常用组合式函数。
 *
 * 放在 src/hooks 下会被 unplugin-auto-import 自动导入
 * （见 vite.config.ts 的 AutoImport.dirs 配置），
 * 页面中无需手动 import 即可使用。
 */

import { ref, onUnmounted } from 'vue';

/**
 * 异步数据加载。
 *
 * 统一处理 loading 状态与错误，避免每个页面重复写 try/finally。
 *
 * @param loader 加载函数
 * @param options.immediate 是否立即执行，默认 false
 */
export function useAsyncData<T>(loader: () => Promise<T>, options: { immediate?: boolean } = {}) {
    const data = ref<T | null>(null);
    const loading = ref(false);
    const error = ref<Error | null>(null);

    async function run() {
        loading.value = true;
        error.value = null;
        try {
            data.value = await loader();
            return data.value;
        } catch (e) {
            error.value = e as Error;
            throw e;
        } finally {
            loading.value = false;
        }
    }

    if (options.immediate) {
        run().catch(() => {
            /* 错误已记录在 error 中 */
        });
    }

    return { data, loading, error, run };
}

/**
 * 节流。
 *
 * 用于进度上报、滚动监听等高频场景。
 */
export function useThrottleFn<T extends (...args: any[]) => void>(fn: T, wait = 300) {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    onUnmounted(() => {
        if (timer) clearTimeout(timer);
    });

    return function throttled(this: any, ...args: Parameters<T>) {
        const now = Date.now();
        const remain = wait - (now - last);
        if (remain <= 0) {
            last = now;
            fn.apply(this, args);
        } else if (!timer) {
            timer = setTimeout(() => {
                last = Date.now();
                timer = null;
                fn.apply(this, args);
            }, remain);
        }
    } as T;
}

/**
 * 防抖。
 */
export function useDebounceFn<T extends (...args: any[]) => void>(fn: T, wait = 300) {
    let timer: ReturnType<typeof setTimeout> | null = null;

    onUnmounted(() => {
        if (timer) clearTimeout(timer);
    });

    return function debounced(this: any, ...args: Parameters<T>) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, wait);
    } as T;
}

/**
 * 格式化秒数为 mm:ss / hh:mm:ss。
 */
export function useTimeFormat() {
    function format(sec: number): string {
        const s = Math.max(0, Math.floor(sec || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n: number) => String(n).padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    return { format };
}
