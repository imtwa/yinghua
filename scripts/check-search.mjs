/**
 * 验证搜索链路：拉取 screen 分页 → 本地匹配。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9230;
const TARGET_URL = process.argv[2] || 'http://localhost:9010/';
const profile = path.join(os.tmpdir(), `yh-search-${Date.now()}`);

function waitForEndpoint(retries = 40) {
    return new Promise((resolve, reject) => {
        let n = 0;
        const tick = () => {
            http.get(`http://127.0.0.1:${PORT}/json/version`, res => {
                let d = '';
                res.on('data', c => (d += c));
                res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', () => {
                if (++n >= retries) reject(new Error('CDP 未就绪'));
                else setTimeout(tick, 300);
            });
        };
        tick();
    });
}

function getPageWs() {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' },
            res => {
                let d = '';
                res.on('data', c => (d += c));
                res.on('end', () => {
                    try { resolve(JSON.parse(d).webSocketDebuggerUrl); }
                    catch { reject(new Error('解析 target 失败')); }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
}

async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
}

async function main() {
    await waitForEndpoint();
    ws = new WebSocket(await getPageWs());
    await new Promise(r => (ws.onopen = r));

    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m.result);
            pending.delete(m.id);
        }
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: TARGET_URL });
    await new Promise(r => setTimeout(r, 14000));

    console.log('=== 1. 热词接口（新结构）===');
    console.log(await evalJs(`(async () => {
        const svc = await import('/src/services/video.ts');
        const hot = await svc.getHotSearch();
        return '热词 ' + hot.length + ' 个: ' + hot.slice(0,6).map(h => h.name).join(', ');
    })()`));

    console.log('\n=== 2. 搜索「仙逆」===');
    console.log(await evalJs(`(async () => {
        const svc = await import('/src/services/video.ts');
        const r = await svc.searchVod('仙逆');
        return '命中 ' + r.length + ' 条: ' + r.slice(0,8).map(v => v.vod_name).join(', ');
    })()`));

    console.log('\n=== 3. 搜索「兰香如故」===');
    console.log(await evalJs(`(async () => {
        const svc = await import('/src/services/video.ts');
        const r = await svc.searchVod('兰香如故');
        return '命中 ' + r.length + ' 条: ' + r.slice(0,8).map(v => v.vod_name).join(', ');
    })()`));

    console.log('\n=== 4. 按演员搜索「谭松韵」===');
    console.log(await evalJs(`(async () => {
        const svc = await import('/src/services/video.ts');
        const r = await svc.searchVod('谭松韵');
        return '命中 ' + r.length + ' 条: ' + r.slice(0,8).map(v => v.vod_name).join(', ');
    })()`));

    console.log('\n=== 5. 搜索不存在的词 ===');
    console.log(await evalJs(`(async () => {
        const svc = await import('/src/services/video.ts');
        const r = await svc.searchVod('zzz不存在xyz');
        return '命中 ' + r.length + ' 条';
    })()`));
}

main()
    .catch(e => console.error('脚本异常:', e.message))
    .finally(() => {
        try { ws?.close(); } catch {}
        chrome.kill();
        setTimeout(() => {
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
            process.exit(0);
        }, 500);
    });
