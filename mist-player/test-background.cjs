const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'background/mist.js'), 'utf8');
const COVER = 'data:image/jpeg;base64,AAAA';

function recorder() {
  const log = { fills: [], filters: [], images: [], glows: [] };
  const ctx = {
    filter: 'none',
    save() {},
    restore() {},
    translate(x, y) { log.glows.push({ x, y }); },
    scale() {},
    fillRect() { log.fills.push(typeof this.fillStyle === 'string' ? this.fillStyle : 'gradient'); },
    drawImage(img, x, y, w, h) { log.images.push({ img, x, y, w, h, filter: this.filter }); },
    createRadialGradient() {
      const glow = log.glows.at(-1);
      return { addColorStop(position, color) { if (position === 0) glow.color = color; } };
    }
  };
  Object.defineProperty(ctx, 'filter', {
    get() { return this._filter ?? 'none'; },
    set(v) { this._filter = v; log.filters.push(v); }
  });
  return { ctx, log };
}

function load({ withImage = true, withDocument = true } = {}) {
  const surfaces = [];
  const context = { background: {} };
  if (withImage) {
    context.Image = class {
      constructor() { this.width = 128; this.height = 128; }
      set src(value) { this._src = value; if (this.onload) this.onload(); }
      get src() { return this._src; }
    };
  }
  if (withDocument) {
    context.document = {
      createElement() {
        const { ctx, log } = recorder();
        const surface = { width: 0, height: 0, log, getContext: () => ctx };
        surfaces.push(surface);
        return surface;
      }
    };
  }
  vm.runInNewContext(source, context);
  return { bg: context.background, surfaces };
}

function render(bg, state, theme = 'dark') {
  const { ctx, log } = recorder();
  bg.render(ctx, { width: 1280, height: 800, pixelRatio: 1, theme, ...state }, 0);
  return log;
}

const palette = ['#5E6B5F', '#2A3550'];

// 封面就绪：离屏画一次（铺底、模糊封面、两个光晕、遮罩），主画布只贴图
{
  const { bg, surfaces } = load();
  const main = render(bg, { palette, cover: { src: COVER } });
  assert.equal(surfaces.length, 1);
  const off = surfaces[0].log;
  assert.equal(main.images.length, 1);
  assert.equal(main.images[0].img, surfaces[0]);
  assert.equal(off.images.length, 1);
  const drawn = off.images[0];
  assert.match(drawn.filter, /^blur\(76\.80px\) saturate\(1\.6\) brightness\(0\.75\)$/);
  // inset -20% + cover：方形封面按 1.4 倍宽铺满，居中
  assert.equal(drawn.w, 1280 * 1.4);
  assert.equal(drawn.h, 1280 * 1.4);
  assert.equal(drawn.x, (1280 - 1792) / 2);
  assert.equal(off.filters.at(-1), 'none');
  assert.equal(off.glows.length, 2);
  assert.deepEqual(off.glows.map(g => [g.x, g.y]), [[256, 240], [1088, 640]]);
  assert.match(off.glows[0].color, /, 0\.45\)$/);
  assert.match(off.glows[1].color, /, 0\.55\)$/);
  assert.equal(off.fills.at(-1), 'rgba(0, 0, 0, 0.18)');

  // 状态不变时复用缓存，不再重复模糊
  render(bg, { palette, cover: { src: COVER } });
  assert.equal(surfaces.length, 1);
  // 换封面或换主题才重建
  render(bg, { palette, cover: { src: COVER + 'B' } });
  assert.equal(surfaces.length, 2);
  const light = render(bg, { palette, cover: { src: COVER + 'B' } }, 'light');
  assert.equal(surfaces.length, 3);
  assert.equal(surfaces[2].log.fills.at(-1), 'rgba(255, 255, 255, 0.24)');
  assert.ok(light.images.length === 1);
}

// 没有封面或封面不是 data 图片：只画底色、光晕与遮罩
{
  const { bg, surfaces } = load();
  render(bg, { palette, cover: null });
  assert.equal(surfaces[0].log.images.length, 0);
  assert.equal(surfaces[0].log.glows.length, 2);
  render(bg, { palette, cover: { src: 'https://example.com/a.jpg' } });
  assert.equal(surfaces.at(-1).log.images.length, 0);
}

// 灰色封面光晕退到低饱和；无调色板时用 coverBase / coverAccent
{
  const { bg, surfaces } = load();
  render(bg, { palette: ['#777777'] });
  assert.match(surfaces[0].log.glows[0].color, /^hsla\(0, 5\.2%, 61%/);
  render(bg, { colors: { coverBase: '#803020', coverAccent: '#2050A0' } });
  assert.match(surfaces.at(-1).log.glows[0].color, /^hsla\(10/);
  assert.match(surfaces.at(-1).log.glows[1].color, /^hsla\(217\.5/);
}

// 运行环境缺少 document 或 Image 时直接画到主画布，不崩溃
{
  const { bg } = load({ withImage: false, withDocument: false });
  const log = render(bg, { palette, cover: { src: COVER } });
  assert.equal(log.images.length, 0);
  assert.equal(log.glows.length, 2);
  assert.equal(log.fills.at(-1), 'rgba(0, 0, 0, 0.18)');
}

// 尺寸无效时不绘制
{
  const { bg, surfaces } = load();
  const { ctx, log } = recorder();
  bg.render(ctx, { width: 0, height: 800, theme: 'dark' }, 0);
  bg.render(ctx, { width: 800, height: Number.NaN, theme: 'dark' }, 0);
  assert.equal(log.fills.length + log.images.length, 0);
  assert.equal(surfaces.length, 0);
}

console.log('设计稿复刻背景：模糊参数、铺满方式、光晕、缓存与降级检查通过。');
