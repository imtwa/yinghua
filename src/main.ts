import { createPinia } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import { createSSRApp } from 'vue';
import App from './App.vue';

const store = createPinia();
store.use(
    createPersistedState({
        storage: {
            getItem: uni.getStorageSync,
            setItem: uni.setStorageSync
        }
    })
);

export function createApp() {
    const app = createSSRApp(App);
    app.use(store);

    return { app };
}
