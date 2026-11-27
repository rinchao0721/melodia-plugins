import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const mainPath = resolve(here, '..', 'main.js');

function load(settings, handler) {
  const toasts = [];
  const requests = [];
  globalThis.melodia = {
    settings: { all: () => Promise.resolve(settings) },
    storage: {
      get: () => Promise.resolve('melodia-test-device'),
      set: () => Promise.resolve()
    },
    http: {
      request: (options) => {
        requests.push(options);
        return Promise.resolve(handler(options));
      }
    },
    ui: {
      toast: (text) => {
        toasts.push(text);
        return Promise.resolve();
      }
    },
    register: {
      downloadSource: (_name, impl) => {
        globalThis.__resolve = impl.resolve;
      }
    }
  };
  delete require.cache[mainPath];
  require(mainPath);
  return { toasts, requests, resolve: globalThis.__resolve };
}

const okResponse = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body) });

function masterHandler(options) {
  if (options.url.includes('token.php')) return okResponse({ data: { token: 'xh3.test' } });
  return okResponse(options.url.includes('quality=master')
    ? { code: 200, url: 'https://cdn.example.com/song.master.flac', format: 'flac', quality: 'master', br: 4256422 }
    : { code: 200, url: 'https://cdn.example.com/song.flac', format: 'flac', quality: 'flac', br: 800000 });
}

function defaultHandler(body) {
  return (options) => options.url.includes('token.php')
    ? okResponse({ data: { token: 'xh3.test' } })
    : okResponse(body);
}

const song = {
  songId: '143466',
  title: '冬雨',
  artists: '齐秦',
  album: '冬雨',
  durationMs: 310000,
  origin: 'netease',
  quality: 'flac'
};

const baseSettings = {
  provider: 'xinghai',
  xhQuality: 'auto',
  preferMaster: true,
  minQuality: 'auto',
  notifyStart: true,
  debug: false
};

test('按档位取链并回写实际音质，取到链接时提示开始下载', async () => {
  const env = load(baseSettings, masterHandler);
  const link = await env.resolve({ ...song, quality: 'jymaster' });

  assert.equal(link.url, 'https://cdn.example.com/song.master.flac');
  assert.equal(link.quality, 'jymaster');
  assert.ok(env.requests.some((r) => r.url.includes('quality=master')), '母带档位应请求 master');
  assert.deepEqual(env.toasts, ['已取到 母带 直链，开始下载']);
});

test('关闭提示开关后不再发开始下载提示', async () => {
  const env = load(
    { ...baseSettings, notifyStart: false },
    defaultHandler({ code: 200, url: 'https://cdn.example.com/song.flac', format: 'flac', quality: 'flac', br: 800000 })
  );
  const link = await env.resolve(song);

  assert.ok(link);
  assert.deepEqual(env.toasts, []);
});

test('取不到链接时返回空，原因提示不重复插件名前缀', async () => {
  const env = load(
    { ...baseSettings, debug: true },
    defaultHandler({ code: 404, msg: '未找到该歌曲' })
  );
  const link = await env.resolve(song);

  assert.equal(link, null);
  assert.deepEqual(env.toasts, ['收到下载档位：flac → 无损 FLAC', '星海后端：未找到该歌曲']);
});
