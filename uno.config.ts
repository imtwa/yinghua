import { presetUni } from '@uni-helper/unocss-preset-uni';
import { presetLegacyCompat } from '@unocss/preset-legacy-compat';
import { defineConfig, transformerDirectives, transformerVariantGroup } from 'unocss';

/**
 * UnoCSS 配置。
 *
 * 使用 `@uni-helper/unocss-preset-uni`（uni-app 专用预设），
 * 而非裸 `presetUno` —— 前者处理了 rpx 单位与条件编译等差异。
 *
 * 设计取向：影院感暗色基调 —— 近黑背景 + 琥珀金点缀。
 * `brand` 为暖金，呼应「放映机的光」；`ink` 为分层深灰。
 */
export default defineConfig({
    presets: [
        presetUni({
            attributify: false
        }),
        presetLegacyCompat({
            commaStyleColorFunction: true
        })
    ],
    transformers: [transformerDirectives(), transformerVariantGroup()],
    theme: {
        colors: {
            brand: {
                DEFAULT: '#f0a63c',
                light: '#ffc46b',
                dark: '#c47f1f'
            },
            ink: {
                900: '#0b0d10',
                800: '#14171c',
                700: '#1d2128',
                600: '#2a2f38',
                500: '#3d434e',
                400: '#6b7280'
            }
        },
        fontFamily: {
            sans: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
        }
    },
    shortcuts: {
        'flex-center': 'flex items-center justify-center',
        'flex-between': 'flex items-center justify-between',
        'safe-bottom': 'pb-[env(safe-area-inset-bottom)]',
        'safe-top': 'pt-[env(safe-area-inset-top)]'
    },
    rules: []
});
