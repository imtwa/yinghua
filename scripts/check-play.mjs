/**
 * 验证播放链路（用真实可用的影片 id）。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9232;
const TARGET_URL = process.argv[2] || 'http://localhost:9010/';
const profile = path.join(os.tmpdir(), `yh-play2-${Date.now()}`);

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
const logs = [];

function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
}

async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
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
            return;
        }
        if (m.method === 'Runtime.consoleAPICalled') {
            const txt = m.params.args
                .map(a => (a.value !== undefined ? String(a.value) : a.description || a.type))
                .join(' ');
            logs.push(`[${m.params.type}] ${txt}`);
        }
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: TARGET_URL });
    await new Promise(r => setTimeout(r, 14000));

    console.log('=== 详情接口返回结构（vod_id=171074）===');
    console.log(await evalJs(`(async () => {
        const svc = await import('/src/services/video.ts');
        const d = await svc.getVodDetail(171074);
        if (!d) return '详情为空';
        const keys = Object.keys(d).slice(0, 25).join(',');
        const colls = d.vod_collection;
        return 'name=' + d.vod_name + '  keys=[' + keys + ']  vod_collection=' + (Array.isArray(colls) ? colls.length : typeof colls);
    })()`));

    console.log('\n=== 播放解析（vod_id=171074，index=0）===');
    console.log(await evalJs(`(async () => {
        const play = await import('/src/services/play.ts');
        try {
            const r = await play.resolvePlayUrl(171074, 4190283, '', 0);
            return '成功  备用=' + r.backups.length + '  url=' + r.url.slice(0, 110);
        } catch (e) {
            return '失败: ' + (e && e.message || e);
        }
    })()`));

    console.log('\n=== 再测两部（170123 / 171960）===');
    console.log(await evalJs(`(async () => {
        const play = await import('/src/services/play.ts');
        const out = [];
        for (const id of [170123, 171960]) {
            try {
                const r = await play.resolvePlayUrl(id, 0, '', 0);
                out.push(id + ' -> 成功 ' + r.url.slice(0, 80));
            } catch (e) {
                out.push(id + ' -> 失败: ' + (e && e.message || e));
            }
        }
        return out.join('\\n');
    })()`));

    console.log('\n=== 片源解析日志 ===');
    const rel = logs.filter(l => /play-resolve|片源|线路|vod_token/.test(l));
    console.log(rel.length ? rel.slice(-20).join('\n') : '(无)');
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
