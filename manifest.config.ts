import path from 'node:path';
import process from 'node:process';
import { defineManifestConfig } from '@uni-helper/vite-plugin-uni-manifest';
import { loadEnv } from 'vite';

function getMode() {
    const args = process.argv.slice(2);
    const modeFlagIndex = args.findIndex(arg => arg === '--mode');
    return modeFlagIndex !== -1 ? args[modeFlagIndex + 1] : 'development';
}

const env = loadEnv(getMode(), path.resolve(process.cwd(), 'env'));
const { VITE_APP_TITLE, VITE_UNI_APPID, VITE_FALLBACK_LOCALE } = env;

export default defineManifestConfig({
    name: VITE_APP_TITLE,
    appid: VITE_UNI_APPID,
    description: '映话 - 一起看，聊着看',
    versionName: '1.0.0',
    versionCode: '100',
    transformPx: false,
    locale: VITE_FALLBACK_LOCALE,
    /* 5+App 特有相关 */
    'app-plus': {
        usingComponents: true,
        nvueStyleCompiler: 'uni-app',
        compilerVersion: 3,
        /*
         * 应用默认方向：只声明竖屏。
         *
         * 播放页全屏时才用 plus.screen.lockOrientation('landscape-primary')
         * 在运行时临时锁横屏，退出时锁回竖屏。
         *
         * 千万不要在这里加 landscape-primary —— unlockOrientation() 恢复的
         * 就是这份「应用默认方向集」，一旦包含横屏，手机横持时退出全屏后
         * 会仍被判为横屏，页面回不到正常竖屏形态。
         */
        screenOrientation: ['portrait-primary'],
        compatible: {
            ignoreVersion: true
        },
        splashscreen: {
            alwaysShowBeforeRender: true,
            waiting: true,
            autoclose: true,
            delay: 0
        },
        modules: {
            Camera: {},
            Record: {},
            VideoPlayer: {}
        },
        safearea: {
            bottom: {
                offset: 'none'
            }
        },
        distribute: {
            android: {
                minSdkVersion: 24,
                targetSdkVersion: 34,
                abiFilters: ['armeabi-v7a', 'arm64-v8a'],
                schemes: 'yinghua',
                permissions: [
                    '<uses-permission android:name="android.permission.INTERNET"/>',
                    '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>',
                    '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>',
                    '<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE"/>',
                    '<uses-permission android:name="android.permission.CHANGE_WIFI_STATE"/>',
                    '<uses-permission android:name="android.permission.WAKE_LOCK"/>',
                    '<uses-permission android:name="android.permission.VIBRATE"/>',
                    '<uses-permission android:name="android.permission.CAMERA"/>',
                    '<uses-permission android:name="android.permission.RECORD_AUDIO"/>',
                    '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>'
                ],
                excludePermissions: [
                    '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
                    '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
                    '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />',
                    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />',
                    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />'
                ]
            },
            ios: {
                idfa: false,
                urltypes: 'yinghua',
                privacyDescription: {
                    NSCameraUsageDescription: '用于双人视频通话时采集画面',
                    NSMicrophoneUsageDescription: '用于双人视频通话时采集声音',
                    NSPhotoLibraryUsageDescription: '用于保存与分享图片'
                },
                UIBackgroundModes: 'audio'
            },
            sdkConfigs: {},
            icons: {
                android: {
                    hdpi: 'unpackage/res/icons/72x72.png',
                    xhdpi: 'unpackage/res/icons/96x96.png',
                    xxhdpi: 'unpackage/res/icons/144x144.png',
                    xxxhdpi: 'unpackage/res/icons/192x192.png'
                },
                ios: {
                    appstore: 'unpackage/res/icons/1024x1024.png',
                    iphone: {
                        'app@2x': 'unpackage/res/icons/120x120.png',
                        'app@3x': 'unpackage/res/icons/180x180.png'
                    }
                }
            }
        }
    },
    h5: {
        darkmode: true,
        router: {
            mode: 'history',
            base: '/'
        },
        title: VITE_APP_TITLE,
        optimization: {
            treeShaking: {
                enable: true
            }
        }
    },
    uniStatistics: {
        enable: false
    },
    vueVersion: '3'
});
