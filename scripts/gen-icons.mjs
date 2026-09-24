// 生成「映话」应用图标（各平台尺寸）
// 无图像库依赖，手写 PNG 编码：RGBA + zlib deflate
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ===================== 绘图基础 ===================== */

const BG = [11, 13, 16];        // #0b0d10 页面底色
const GOLD = [240, 166, 60];    // #f0a63c 琥珀金
const GOLD_SOFT = [240, 166, 60];

/** 创建画布（RGBA）。 */
function createCanvas(size) {
    return {
        size,
        data: new Uint8Array(size * size * 4)
    };
}

/** 写像素（带边界与 alpha 混合）。 */
function blend(canvas, x, y, r, g, b, a = 255) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
    const i = (y * canvas.size + x) * 4;

    const sa = a / 255;
    const da = canvas.data[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;

    canvas.data[i] = Math.round((r * sa + canvas.data[i] * da * (1 - sa)) / outA);
    canvas.data[i + 1] = Math.round((g * sa + canvas.data[i + 1] * da * (1 - sa)) / outA);
    canvas.data[i + 2] = Math.round((b * sa + canvas.data[i + 2] * da * (1 - sa)) / outA);
    canvas.data[i + 3] = Math.round(outA * 255);
}

/** 抗锯齿：按覆盖率混合（4x4 超采样）。 */
function blendCoverage(canvas, x, y, color, coverage) {
    if (coverage <= 0) return;
    blend(canvas, x, y, color[0], color[1], color[2], Math.round(255 * Math.min(coverage, 1)));
}

/**
 * 圆角矩形（超采样抗锯齿）。
 *
 * @param corner 圆角半径；传 size/2 即圆形
 */
function fillRoundRect(canvas, left, top, w, h, corner, color) {
    const SS = 4; // 每像素 4x4 采样
    const x0 = Math.max(0, Math.floor(left));
    const y0 = Math.max(0, Math.floor(top));
    const x1 = Math.min(canvas.size, Math.ceil(left + w));
    const y1 = Math.min(canvas.size, Math.ceil(top + h));
    const r = Math.min(corner, w / 2, h / 2);

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            let hit = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = x + (sx + 0.5) / SS;
                    const py = y + (sy + 0.5) / SS;
                    if (insideRoundRect(px, py, left, top, w, h, r)) hit++;
                }
            }
            if (hit) blendCoverage(canvas, x, y, color, hit / (SS * SS));
        }
    }
}

function insideRoundRect(px, py, left, top, w, h, r) {
    if (px < left || py < top || px > left + w || py > top + h) return false;
    // 四角做圆角判定
    const cx = px < left + r ? left + r : (px > left + w - r ? left + w - r : px);
    const cy = py < top + r ? top + r : (py > top + h - r ? top + h - r : py);
    if (cx === px && cy === py) return true;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
}

/** 三角形（超采样）。 */
function fillTriangle(canvas, ax, ay, bx, by, cx, cy, color) {
    const SS = 4;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const x1 = Math.min(canvas.size, Math.ceil(Math.max(ax, bx, cx)));
    const y1 = Math.min(canvas.size, Math.ceil(Math.max(ay, by, cy)));

    const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            let hit = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = x + (sx + 0.5) / SS;
                    const py = y + (sy + 0.5) / SS;
                    const d1 = sign(px, py, ax, ay, bx, by);
                    const d2 = sign(px, py, bx, by, cx, cy);
                    const d3 = sign(px, py, cx, cy, ax, ay);
                    const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
                    const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
                    if (!(neg && pos)) hit++;
                }
            }
            if (hit) blendCoverage(canvas, x, y, color, hit / (SS * SS));
        }
    }
}

/** 圆弧描边（超采样，用于「话」的声波弧）。 */
function strokeArc(canvas, cx, cy, radius, thickness, startDeg, endDeg, color) {
    const SS = 4;
    const rad = Math.max(radius + thickness, 1);
    const x0 = Math.max(0, Math.floor(cx - rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const x1 = Math.min(canvas.size, Math.ceil(cx + rad));
    const y1 = Math.min(canvas.size, Math.ceil(cy + rad));

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            let hit = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = x + (sx + 0.5) / SS;
                    const py = y + (sy + 0.5) / SS;
                    const dx = px - cx;
                    const dy = py - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (Math.abs(dist - radius) > thickness / 2) continue;
                    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
                    if (deg >= startDeg && deg <= endDeg) hit++;
                }
            }
            if (hit) blendCoverage(canvas, x, y, color, hit / (SS * SS));
        }
    }
}

/* ===================== 图标设计 ===================== */

/**
 * 绘制图标。
 *
 * 设计：深色圆角底 + 琥珀金「播放三角」+ 右侧两道声波弧。
 * 三角呼应「映」（放映），弧线呼应「话」（通话），
 * 配色沿用应用内的 #0b0d10 / #f0a63c。
 *
 * @param size  边长（像素）
 * @param pad   外边距比例（Android 自适应图标需要留白，iOS 不需要）
 * @param round 是否为圆角矩形（false = 满幅方形，系统自行裁切）
 */
function drawIcon(size, opts = {}) {
    const { pad = 0, round = true, radiusRatio = 0.22 } = opts;
    const canvas = createCanvas(size);
    const inset = size * pad;
    const box = size - inset * 2;

    // 底：圆角矩形（满幅时可视为方形，圆角为 0）
    const corner = round ? box * radiusRatio : 0;
    fillRoundRect(canvas, inset, inset, box, box, corner, BG);

    // 内容区（相对底再留白，保证视觉重心居中）
    const cInset = box * 0.2;
    const cx0 = inset + cInset;
    const cw = box - cInset * 2;
    const cy0 = inset + cInset;
    const ch = box - cInset * 2;

    // 播放三角：略偏左，给右侧声波留位
    const triLeft = cx0 + cw * 0.02;
    const triW = cw * 0.46;
    const triH = ch * 0.62;
    const triTop = cy0 + (ch - triH) / 2;
    fillTriangle(
        canvas,
        triLeft, triTop,
        triLeft, triTop + triH,
        triLeft + triW, triTop + triH / 2,
        GOLD
    );

    // 声波弧两道：以三角右侧为圆心
    const arcCx = triLeft + triW + cw * 0.02;
    const arcCy = cy0 + ch / 2;
    const thick = Math.max(1, box * 0.055);

    strokeArc(canvas, arcCx, arcCy, cw * 0.20, thick, -52, 52, GOLD_SOFT);
    strokeArc(canvas, arcCx, arcCy, cw * 0.36, thick, -52, 52, GOLD_SOFT);

    return canvas;
}

/* ===================== PNG 编码 ===================== */

function crc32(buf) {
    let c;
    const table = crc32.table || (crc32.table = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
        return t;
    })());
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** 把画布编码为 PNG（RGBA8）。 */
function encodePng(canvas) {
    const { size, data } = canvas;

    // 每行前置 filter byte（0 = None）
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        for (let x = 0; x < size * 4; x++) {
            raw[y * (size * 4 + 1) + 1 + x] = data[y * size * 4 + x];
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // color type: RGBA
    ihdr[10] = 0;   // compression
    ihdr[11] = 0;   // filter
    ihdr[12] = 0;   // interlace

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/* ===================== 输出 ===================== */

const OUT = 'unpackage/res/icons';
fs.mkdirSync(OUT, { recursive: true });

// Android 各密度（自适应图标需留白，故 pad 略大且满幅方形）
const android = [
    ['72x72.png', 72],
    ['96x96.png', 96],
    ['144x144.png', 144],
    ['192x192.png', 192]
];
for (const [name, size] of android) {
    // 圆形图标：留白 12%，圆角固定为 22%
    const c = drawIcon(size, { pad: 0.06, round: true, radiusRatio: 0.22 });
    fs.writeFileSync(path.join(OUT, name), encodePng(c));
    console.log('  生成 ' + name + '  (' + size + '×' + size + ')');
}

// iOS：满幅方形，系统自行切圆角
const ios = [
    ['120x120.png', 120],
    ['180x180.png', 180],
    ['1024x1024.png', 1024]
];
for (const [name, size] of ios) {
    const c = drawIcon(size, { pad: 0, round: false });
    fs.writeFileSync(path.join(OUT, name), encodePng(c));
    console.log('  生成 ' + name + '  (' + size + '×' + size + ')');
}

// 应用内 logo（导航栏/启动页用）
const logoSizes = [
    ['logo.png', 192]
];
for (const [name, size] of logoSizes) {
    const c = drawIcon(size, { pad: 0.04, round: true, radiusRatio: 0.22 });
    fs.writeFileSync(path.join('src/static/icons', name), encodePng(c));
    console.log('  生成 src/static/icons/' + name + '  (' + size + '×' + size + ')');
}

console.log('完成');
