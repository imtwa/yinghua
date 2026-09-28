/**
 * 生成本地开发用 https 证书。
 *
 * ## 为什么需要
 *
 * 浏览器的安全上下文（Secure Context）规则决定了：
 * **只有在 https / localhost / 127.0.0.1 下，`navigator.mediaDevices` 才存在**。
 *
 * 用 `http://192.168.x.x:9010` 打开 H5 页面时（手机连同一 WiFi 调试的常见做法），
 * `navigator.mediaDevices` 直接是 `undefined`，getUserMedia 无从调用 ——
 * 房间通话的摄像头/麦克风必然失败。
 *
 * 注意这不是「本工程的问题」：WebRTC 全系（含 RTCPeerConnection）都受此约束，
 * 任何网页端实现都一样。App 端不受限，因为它跑在原生 WebView 里，
 * 没有这个安全上下文的概念（`file://` / `https://localhost` 均由原生层接管）。
 *
 * ## 用法
 *
 *   pnpm dev:cert      # 生成证书（重复执行会覆盖，用于换网络后更新 IP）
 *   pnpm dev:h5        # 之后启动即自动启用 https
 *
 * 证书落在 `env/certs/`，已在 .gitignore 中忽略（含私钥，不可入库）。
 *
 * ## 前置
 *
 * 需要 mkcert（本机已安装）。它会生成一个**本地根 CA** 并装入系统信任库；
 * 首次使用请先执行一次 `mkcert -install`（本脚本会自动补做）。
 *
 * ⚠️ 手机端要正常访问，需把 mkcert 的根证书也装到手机上，否则浏览器会
 * 因证书不受信任而拦截页面。根证书路径见脚本输出的提示。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const certDir = path.join(root, 'env', 'certs');
const keyFile = path.join(certDir, 'dev-key.pem');
const certFile = path.join(certDir, 'dev-cert.pem');

/** 执行命令并把 stderr 一并回传（mkcert 的正常输出走 stderr）。 */
function run(cmd, args) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasMkcert() {
    try {
        run('mkcert', ['-version']);
        return true;
    } catch {
        return false;
    }
}

/**
 * 收集本机所有局域网 IPv4。
 *
 * 必须把 IP 写进证书的 SAN —— 证书校验的是「你访问时用的地址」，
 * 用 IP 访问却没有该 IP 的 SAN，浏览器会直接判定证书无效。
 * 换网络（家里/公司/热点）后 IP 会变，重跑本脚本即可。
 */
function localIPv4() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const info of ifaces[name] || []) {
            if (info.family !== 'IPv4' || info.internal) continue;
            out.push(info.address);
        }
    }
    return out;
}

function main() {
    if (!hasMkcert()) {
        console.error('[dev-cert] 未找到 mkcert。');
        console.error('  Windows: choco install mkcert   或   scoop install mkcert');
        console.error('  macOS:   brew install mkcert');
        process.exit(1);
    }

    // 确保本地 CA 存在且已装入信任库（已装则此命令是空操作）
    try {
        run('mkcert', ['-install']);
    } catch (e) {
        console.warn('[dev-cert] mkcert -install 未成功，可能需要管理员权限：', String(e).slice(0, 200));
    }

    fs.mkdirSync(certDir, { recursive: true });

    const ips = localIPv4();
    const hosts = ['localhost', '127.0.0.1', '::1', ...ips];

    console.log('[dev-cert] 为以下地址签发证书：');
    for (const h of hosts) console.log('  -', h);

    try {
        run('mkcert', [
            '-key-file', keyFile,
            '-cert-file', certFile,
            ...hosts
        ]);
    } catch (e) {
        console.error('[dev-cert] 签发失败：', String(e).slice(0, 400));
        process.exit(1);
    }

    let caRoot = '';
    try {
        caRoot = run('mkcert', ['-CAROOT']).trim();
    } catch {
        /* 取不到就跳过提示 */
    }

    console.log('');
    console.log('[dev-cert] 完成：');
    console.log('  私钥  ', path.relative(root, keyFile));
    console.log('  证书  ', path.relative(root, certFile));
    console.log('');
    console.log('  桌面浏览器：直接访问 https://localhost:9010 即可（CA 已装入系统）。');
    if (ips.length) {
        console.log(`  手机浏览器：需先把根证书装到手机上，再访问 https://${ips[0]}:9010`);
        if (caRoot) console.log(`  根证书路径：${path.join(caRoot, 'rootCA.pem')}`);
    }
    console.log('');
    console.log('  提示：换网络后 IP 会变，重跑 pnpm dev:cert 即可。');
}

main();
