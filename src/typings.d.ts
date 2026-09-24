/**
 * 应用类型声明。
 */

declare module '*.vue' {
    import type { DefineComponent } from 'vue';

    const component: DefineComponent<{}, {}, any>;
    export default component;
}

/** Vite 环境变量类型。 */
interface ImportMetaEnv {
    readonly VITE_APP_TITLE: string;
    readonly VITE_APP_PORT: string;
    readonly VITE_APP_PUBLIC_BASE: string;
    readonly VITE_FALLBACK_LOCALE: string;
    readonly VITE_PLAY_PROBE_ENABLE: string;
    readonly VITE_PLAY_PROBE_TIMEOUT: string;
    readonly VITE_LOG_ENABLE: string;
    readonly VITE_DELETE_CONSOLE: string;
    readonly VITE_SHOW_SOURCEMAP: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
