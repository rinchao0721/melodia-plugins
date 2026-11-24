// 背景 API v1：按设计稿的 CSS 复刻模糊封面背景
// 封面放大 1.4 倍 → blur(6% 宽) saturate(1.6) brightness(.75) → 两个径向光晕 → 18% 黑色遮罩
(() => {
  const FALLBACK = '#404040';
  // 设计稿取值：光晕位置与半径均为宽高百分比
  const GLOWS = [
    { slot: 0, x: 0.20, y: 0.30, rx: 0.60, ry: 0.60, light: 61, sat: 13, alpha: 0.45 },
    { slot: 1, x: 0.85, y: 0.80, rx: 0.50, ry: 0.60, light: 30, sat: 23, alpha: 0.55 }
  ];
  const TONE = {
    dark: { base: 26, baseSat: 10, filter: 'saturate(1.6) brightness(0.75)', glowShift: 0, veil: 'rgba(0, 0, 0, 0.18)' },
    // 浅色主题下宿主歌词是深色字，背景整体提亮
    light: { base: 88, baseSat: 14, filter: 'saturate(1.5) brightness(1.15)', glowShift: 26, veil: 'rgba(255, 255, 255, 0.24)' }
  };

  let imageSrc = null;
  let image = null;
  let cache = null;

  function parse(hex) {
    const color = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : FALLBACK;
    const [red, green, blue] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const chroma = high - low;
    let hue = 0;
    if (chroma > 0) {
      if (high === red) hue = ((green - blue) / chroma + 6) % 6;
      else if (high === green) hue = 2 + (blue - red) / chroma;
      else hue = 4 + (red - green) / chroma;
    }
    return { hue: hue * 60, vivid: Math.min(chroma / 0.18, 1) };
  }

  function sources(s) {
    const colors = s.colors || {};
    const base = colors.coverBase ?? s.coverColor;
    const list = Array.isArray(s.palette) ? s.palette.filter(c => typeof c === 'string') : [];
    return [list[0] ?? base, list[1] ?? colors.coverAccent ?? base].map(parse);
  }

  // 封面图异步解码，就绪后清缓存，下一帧重画
  function track(src) {
    const next = typeof src === 'string' && src.startsWith('data:image/') ? src : null;
    if (next === imageSrc) return;
    imageSrc = next;
    if (!next || typeof Image === 'undefined') {
      image = null;
      cache = null;
      return;
    }
    const pending = new Image();
    pending.onload = () => {
      if (imageSrc !== next) return;
      image = pending;
      cache = null;
    };
    pending.src = next;
  }

  function ellipse(ctx, w, h, glow, color) {
    ctx.save();
    ctx.translate(w * glow.x, h * glow.y);
    ctx.scale(w * glow.rx, h * glow.ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `hsla(${color}, ${glow.alpha})`);
    g.addColorStop(1, `hsla(${color}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  function paint(ctx, s, w, h) {
    const tone = s.theme === 'dark' ? TONE.dark : TONE.light;
    const [primary, secondary] = sources(s);
    ctx.fillStyle = `hsl(${primary.hue}, ${tone.baseSat * (0.4 + 0.6 * primary.vivid)}%, ${tone.base}%)`;
    ctx.fillRect(0, 0, w, h);

    if (image && image.width > 0 && image.height > 0) {
      // 等同 CSS inset:-20% 加 background-size:cover
      const boxW = w * 1.4, boxH = h * 1.4;
      const scale = Math.max(boxW / image.width, boxH / image.height);
      const drawW = image.width * scale, drawH = image.height * scale;
      ctx.filter = `blur(${(w * 0.06).toFixed(2)}px) ${tone.filter}`;
      ctx.drawImage(image, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
      ctx.filter = 'none';
    }

    GLOWS.forEach(glow => {
      const source = glow.slot === 0 ? primary : secondary;
      const sat = glow.sat * (0.4 + 0.6 * source.vivid);
      ellipse(ctx, w, h, glow, `${source.hue}, ${sat}%, ${Math.min(glow.light + tone.glowShift, 92)}%`);
    });
    ctx.fillStyle = tone.veil;
    ctx.fillRect(0, 0, w, h);
  }

  function offscreen(width, height) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  background.onState = s => track(s && s.cover && s.cover.src);

  background.render = (ctx, s, time) => {
    const w = s.width, h = s.height;
    if (!(w > 0) || !(h > 0)) return;
    track(s.cover && s.cover.src);
    const ratio = Number.isFinite(s.pixelRatio) && s.pixelRatio > 0 ? s.pixelRatio : 1;
    const palette = Array.isArray(s.palette) ? s.palette.slice(0, 2).join() : '';
    const colors = s.colors || {};
    const key = [w, h, ratio, s.theme, palette, colors.coverBase, colors.coverAccent, image ? imageSrc : ''].join('|');

    // 背景静止，模糊开销只在封面、尺寸或配色变化时付一次
    if (!cache || cache.key !== key) {
      const surface = offscreen(Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio)));
      if (surface) {
        const octx = surface.getContext('2d');
        octx.scale(ratio, ratio);
        paint(octx, s, w, h);
        cache = { key, surface };
      } else {
        cache = null;
      }
    }
    if (cache) ctx.drawImage(cache.surface, 0, 0, w, h);
    else paint(ctx, s, w, h);
  };
})();
