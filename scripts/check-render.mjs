/**
 * 用 Chrome DevTools Protocol 加载页面，抓取控制台错误与渲染结果。
 *
 * 为什么不用 --dump-dom：它不报告 JS 异常，而白屏问题恰恰是 JS 异常导致的。
 * 这里通过 CDP 监听 Runtime.exceptionThrown 与 Log.entryAdded，
 * 能拿到真实的报错信息。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9222;
const TARGET_URL = process.argv[2] || 'http://localhost:9020/';

const profile = path.join(os.tmpdir(), `yh-cdp-${Date.now()}`);

/** 等待 CDP 端点就绪。 */
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

/** 取一个新的 page target 的 ws 地址（新版 CDP 要求 PUT）。 */
function getPageWs() {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' },
            res => {
                let d = '';
                res.on('data', c => (d += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(d).webSocketDebuggerUrl);
                    } catch (e) {
                        reject(new Error(`解析 target 失败: ${d.slice(0, 120)}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank'
], { stdio: 'ignore' });

let ws;
let msgId = 0;
const pending = new Map();
const errors = [];
const logs = [];

function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
}

async function main() {
    await waitForEndpoint();
    const wsUrl = await getPageWs();

    // 用原生 WebSocket（Node 22 内置）
    ws = new WebSocket(wsUrl);
    await new Promise(r => (ws.onopen = r));

    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m.result);
            pending.delete(m.id);
            return;
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errors.push(d.exception?.description || d.text || 'unknown');
        }
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            logs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
        }
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
            errors.push(m.params.entry.text);
        }
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    await send('Page.navigate', { url: TARGET_URL });

    // 等待渲染
    await new Promise(r => setTimeout(r, 12000));

    const dom = await send('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText.slice(0,500) : "(no body)"',
        returnByValue: true
    });
    const html = await send('Runtime.evaluate', {
        expression: 'document.getElementById("app") ? document.getElementById("app").innerHTML.length : -1',
        returnByValue: true
    });

    console.log('=== 页面文本内容 ===');
    console.log(dom?.result?.value || '(空)');
    console.log('\n=== #app 内 HTML 长度 ===');
    console.log(html?.result?.value);

    console.log('\n=== JS 异常 ===');
    if (errors.length === 0) console.log('(无)');
    else errors.forEach((e, i) => console.log(`${i + 1}. ${e}`));

    console.log('\n=== console.error ===');
    if (logs.length === 0) console.log('(无)');
    else logs.forEach((e, i) => console.log(`${i + 1}. ${e}`));

    const ok = errors.length === 0 && (html?.result?.value ?? 0) > 0;
    console.log(`\n=== 判定: ${ok ? '✅ 渲染正常，无异常' : '❌ 存在问题'} ===`);
}

main()
    .catch(e => {
        console.error('脚本异常:', e.message);
    })
    .finally(() => {
        try { ws?.close(); } catch {}
        chrome.kill();
        setTimeout(() => {
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
            process.exit(0);
        }, 500);
    });
