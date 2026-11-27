// 备用下载源：官方下载链接不可用、只给了试听、或请求无损却被降级时，
// 应用会依次询问已安装的下载源插件。这里只负责「取一条直链」，下载与写文件仍由应用完成。
//
// 首选星海后端（自建/自用），失败后再退到公开接口。
// 设计约束（与宿主一致）：
// - 宿主给单个下载源 8 秒（PluginRuntime.SOURCE_TIMEOUT_MS），这里自设 6.8 秒预算；
// - 音质按「请求档位 → 低一档 → 最低档」阶梯重试：后端只有 128k 的曲目也能落到可下的链接；
// - 星海对部分平台返回的是后端自己的转发链接（/lx/api/xxxplay.php），实测出现过 502，
//   交给宿主前先 HEAD 探一次，坏链直接降档重试，避免宿主下载阶段才失败；
// - 返回 null 表示没有结果，宿主会继续问下一个下载源；抛异常会计一次失败，连续 5 次会被自动停用，
//   所以任何一步出错都吞掉并返回 null；
// - 星海 v3.2.20 起服务端只认签发的 xh3. 令牌，拿不到令牌就不要再发取链请求；
// - 宿主 API 1.12 的下载源仍只传 { songId,title,artists,album,durationMs,origin,quality }，
//   quality 是 Android 音质选择弹窗的档位（standard/higher/exhigh/lossless/hires/...），
//   必须原样映射到星海的 128k/320k/flac/hires/master，否则选 Hi-Res 只会拿到普通 flac；
(function () {
    'use strict';

    // 宿主给单个下载源的时间有限，留出余量
    var BUDGET_MS = 6800;
    var TOKEN_WAIT_MS = 1200;
    var REQUEST_WAIT_MS = 3200;
    var PROBE_WAIT_MS = 1500;

    // 星海后端：主域名在部分地区会被 DNS 干扰，失败时切备用域名重试一次
    var XH = {
        primary: 'yy1.zddyr.top',
        backup: 'yy.zddyr.top',
        client: 'XingHaiMusicSource/v3.2.20',
        tokenTtl: 4 * 60 * 1000
    };

    // 应用里的平台 key -> 星海后端的 source 参数
    var PLATFORMS = {
        netease: 'wy', qq: 'tx', kugou: 'kg', kuwo: 'kw', migu: 'mg',
        qishui: 'qs', douyin: 'qs'
    };
    // 应用里的平台 key -> GD / Meting 的 source 参数
    var PUBLIC_SOURCE = { netease: 'netease', qq: 'tencent', kugou: 'kugou', kuwo: 'kuwo', migu: 'migu' };

    // 下载档位 -> 星海音质参数，严格照星海 v3.2.20 的档位表，不再把 Hi-Res/母带压成 flac
    var LEVEL_QUALITY = {
        standard: '128k', higher: '192k', exhigh: '320k', lossless: 'flac',
        hires: 'hires', jyeffect: 'atmos', sky: 'atmos', jymaster: 'master'
    };
    // 各平台真实支持的档位，照星海脚本的 MUSIC_QUALITIES
    var XH_QUALITIES = {
        wy: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
        tx: ['128k', '192k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master'],
        kw: ['128k', '320k', 'flac'],
        kg: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
        mg: ['128k', '320k', 'flac'],
        qs: ['128k', '320k', 'flac', 'spatial', 'hires']
    };
    // 星海降档顺序：从请求的那一档往低走，保证「能下」优先于「音质」
    var QUALITY_ORDER = ['master', 'atmos_plus', 'atmos', 'hires', 'flac24bit', 'spatial', 'flac', '320k', '192k', '128k'];

    // 星海返回的 quality -> 应用里的下载档位
    var QUALITY_LEVEL = {
        '128k': 'standard', '192k': 'higher', '320k': 'exhigh',
        'flac': 'lossless', 'flac24bit': 'hires', 'hires': 'hires',
        'spatial': 'sky', 'atmos': 'jymaster', 'atmos_plus': 'jymaster', 'master': 'jymaster'
    };
    // 宿主可能传来中文档位名、码率数字或旧插件写法，统一到宿主内部档位 key
    var LEVEL_ALIAS = {
        '128k': 'standard', 'standard': 'standard', '标准': 'standard', '标准音质': 'standard',
        '192k': 'higher', 'higher': 'higher', '较高': 'higher', '较高音质': 'higher',
        '320k': 'exhigh', 'exhigh': 'exhigh', '极高': 'exhigh', '极高音质': 'exhigh',
        'flac': 'lossless', 'lossless': 'lossless', '无损': 'lossless', '无损音质': 'lossless',
        'hires': 'hires', 'hi-res': 'hires', 'hi_res': 'hires', 'flac24bit': 'hires', '24bit': 'hires', '高解析': 'hires',
        'jyeffect': 'jyeffect', '沉浸环绕': 'jyeffect', '高清环绕声': 'jyeffect',
        'sky': 'sky', '空间音频': 'sky', '天空音效': 'sky', 'spatial': 'sky',
        'jymaster': 'jymaster', 'master': 'jymaster', '母带': 'jymaster', '超清母带': 'jymaster', '臻品母带': 'jymaster'
    };

    // 公开接口的码率参数
    var LEVEL_BR = {
        standard: 128, higher: 192, exhigh: 320, lossless: 999,
        hires: 999, jyeffect: 999, sky: 999, jymaster: 999
    };

    // 应用里的档位高低，用于判断拿到的链接是否低于请求
    var LEVEL_ORDER = ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster'];
    var LEVEL_NAME = {
        standard: '标准 128k', higher: '较高 192k', exhigh: '极高 320k',
        lossless: '无损 FLAC', hires: 'Hi-Res', jyeffect: '沉浸环绕',
        sky: '天空音效', jymaster: '母带'
    };
    // 「最低可接受音质」设置项 -> 应用档位
    var MIN_LEVEL = { '128k': 'standard', '320k': 'exhigh', 'flac': 'lossless' };

    var FILE_TYPES = ['flac', 'mp3', 'm4a', 'aac', 'ogg', 'wav'];
    var URL_KEYS = ['url', 'src', 'link', 'play_url', 'playUrl', 'downloadUrl'];
    var GROUP_KEYS = ['data', 'result', 'song', 'music', 'list'];

    var cache = null;        // 设置缓存
    var cacheAt = 0;         // 设置缓存时间
    var reason = '';         // 最近一次失败原因，供调试提示
    var xhToken = '';        // 星海令牌
    var xhTokenAt = 0;
    var xhTokenFailAt = 0;   // 令牌拿不到的时间，短时间内不再重试
    var xhDevice = '';       // 稳定设备号，令牌绑定它
    var xhBlocked = false;   // 后端明确 403 后本次进程不再尝试

    // ---------- 设置 ----------

    function readSettings() {
        // 设置改完不必重启应用，最多 60 秒后生效
        if (cache && (Date.now() - cacheAt) < 60000) return Promise.resolve(cache);
        return melodia.settings.all().then(function (all) {
            cache = all && typeof all === 'object' ? all : {};
            cacheAt = Date.now();
            return cache;
        }, function () {
            cache = {};
            cacheAt = Date.now();
            return cache;
        });
    }

    function text(value, fallback) {
        var s = value === undefined || value === null ? '' : String(value).trim();
        return s || fallback;
    }

    function messageOf(e) {
        if (!e) return '未知错误';
        return e.message ? String(e.message) : String(e);
    }

    // 请求头只允许可打印 ASCII，中文卡密之类不能直接塞进去
    function asciiHeader(value) {
        return String(value || '').replace(/[^\x20-\x7e]/g, '').substring(0, 256);
    }

    function levelRank(level) {
        return LEVEL_ORDER.indexOf(String(level || '').toLowerCase());
    }

    // Android 传来的 quality 理论上是标准档位 key，但老版本/其他入口可能出现中文档位名、
    // "320k" 或纯码率数字。统一归一化，避免整首歌按 standard 取链。
    function normalizeLevel(value) {
        var raw = text(value, '').toLowerCase();
        if (!raw) return 'standard';
        if (LEVEL_ALIAS[raw]) return LEVEL_ALIAS[raw];
        var n = parseInt(raw, 10);
        if (/^\d+$/.test(raw) && n > 0) {
            if (n >= 1000000) return 'hires';
            if (n >= 400000) return 'lossless';
            if (n >= 300000) return 'exhigh';
            if (n >= 180000) return 'higher';
            return 'standard';
        }
        return 'standard';
    }

    // 请求档位缺失时，从同一 song 对象的常见别名字段里再找一次
    function requestedLevel(song) {
        var candidates = [song && song.quality, song && song.level, song && song.qualityLevel];
        var fallback = '';
        for (var i = 0; i < candidates.length; i++) {
            var raw = text(candidates[i], '').toLowerCase();
            if (!raw) continue;
            if (LEVEL_ALIAS[raw]) return LEVEL_ALIAS[raw];
            if (/^\d+$/.test(raw)) fallback = normalizeLevel(raw);
        }
        return fallback || 'standard';
    }

    function qualityName(quality) {
        return LEVEL_NAME[String(quality || '').toLowerCase()] || String(quality || '未知音质');
    }

    // 「最低可接受音质」一旦设了上限，低于它的链接宁可不要，免得悄悄下成低音质
    function meetsMin(quality, settings) {
        var min = MIN_LEVEL[text(settings.minQuality, 'auto').toLowerCase()];
        if (!min) return true;
        var have = levelRank(quality);
        return have >= 0 && have >= levelRank(min);
    }

    // ---------- 超时 ----------

    function limit(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                reject(new Error(label + '超时'));
            }, ms);
            promise.then(function (value) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(value);
            }, function (e) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    // 按剩余预算裁剪单次请求的等待时间，返回 0 表示没时间了
    function waitFor(deadline, cap) {
        var left = deadline - Date.now() - 300;
        if (left < 900) return 0;
        return Math.min(cap, left);
    }

    // ---------- 网络 ----------

    function httpGet(url, headers, waitMs) {
        var options = { url: url, method: 'GET', headers: headers || {} };
        return limit(melodia.http.request(options), waitMs, '请求').then(function (res) {
            var status = res && typeof res.status === 'number' ? res.status : 0;
            if (status !== 200) {
                var error = new Error('HTTP ' + (status || '?'));
                error.status = status;
                throw error;
            }
            return String((res && res.body) || '');
        });
    }

    function parseJson(body) {
        var raw = String(body || '').trim();
        if (!raw || (raw.charAt(0) !== '{' && raw.charAt(0) !== '[')) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    // 星海对酷我/咪咕这类平台会给后端自己的转发链接，主机和接口同一域名
    function isProxyUrl(url) {
        return /^https?:\/\/(yy1\.zddyr\.top|yy\.zddyr\.top)\//i.test(String(url || ''));
    }

    // 探测链接是否真的能下：HEAD 不拉音频体；405/501（不支持 HEAD）时用 GET + Range 只取 1 字节。
    // 返回 bad 才算坏链，ok 与 unknown 都交给宿主，避免因探测本身失败而误伤可用链接。
    function probeUrl(url, waitMs) {
        function ask(method, headers) {
            return limit(melodia.http.request({ url: url, method: method, headers: headers }), waitMs, '探测')
                .then(function (res) {
                    return res && typeof res.status === 'number' ? res.status : 0;
                }, function () {
                    return 0;
                });
        }
        return ask('HEAD', { 'User-Agent': 'lx-music' }).then(function (status) {
            if (status === 405 || status === 501) {
                return ask('GET', { 'User-Agent': 'lx-music', 'Range': 'bytes=0-0' });
            }
            return status;
        }).then(function (status) {
            if (status >= 200 && status < 400) return 'ok';
            if (status === 0) return 'unknown';
            return 'bad';
        });
    }

    // 4xx 换域名也没用，只有网络失败和 5xx 才切备用域名
    function xinghaiGet(pathAndQuery, token, waitMs, settings) {
        var license = asciiHeader(text(settings.xhLicense, ''));
        function attempt(host) {
            var headers = {
                'User-Agent': 'lx-music',
                'X-Client': XH.client + ' (Melodia)'
            };
            if (token) headers['X-Token'] = token;
            if (license) headers['X-License'] = license;
            return httpGet('https://' + host + pathAndQuery, headers, waitMs);
        }
        return attempt(XH.primary).then(null, function (e) {
            var status = e && e.status ? e.status : 0;
            if (status >= 400 && status < 500) throw e;
            return attempt(XH.backup);
        });
    }

    // ---------- 星海 ----------

    function deviceIdOf() {
        if (xhDevice) return Promise.resolve(xhDevice);
        function create() {
            return 'melodia-' + Math.random().toString(36).substring(2, 8) + Date.now().toString(36).slice(-4);
        }
        return melodia.storage.get('deviceId').then(function (saved) {
            var id = typeof saved === 'string' ? saved.trim() : '';
            if (id) {
                xhDevice = id;
                return id;
            }
            var fresh = create();
            xhDevice = fresh;
            return melodia.storage.set('deviceId', fresh).then(function () {
                return fresh;
            }, function () {
                return fresh;
            });
        }, function () {
            xhDevice = create();
            return xhDevice;
        });
    }

    // 令牌 4 分钟内有效；v3.2.20 起服务端要求服务器签发的 xh3. 令牌，拿不到就返回空字符串让上层换接口
    function tokenOf(settings) {
        if (xhToken && (Date.now() - xhTokenAt) <= XH.tokenTtl) return Promise.resolve(xhToken);
        // 刚失败过就先用空令牌，别每次都卡 1.2 秒去拿
        if (!xhToken && (Date.now() - xhTokenFailAt) < 60000) return Promise.resolve('');
        return deviceIdOf().then(function (id) {
            return xinghaiGet('/lx/api/token.php?device_id=' + encodeURIComponent(id), '', TOKEN_WAIT_MS, settings);
        }).then(function (body) {
            var data = parseJson(body);
            var token = data && data.data && typeof data.data.token === 'string' ? data.data.token : '';
            if (token) {
                xhToken = token;
                xhTokenAt = Date.now();
            } else {
                xhTokenFailAt = Date.now();
            }
            return token;
        }, function () {
            xhTokenFailAt = Date.now();
            return '';
        });
    }

    // 服务端判定令牌不可用（过期、换网、非服务器签发）时刷新一次
    function tokenStale(data) {
        var auth = data && data.auth;
        if (!auth) return false;
        if (auth.tk_mismatch === true) return true;
        return auth.device_id === 'untrusted-token' || !!auth.tk_error;
    }

    function intervalOf(durationMs) {
        var total = Math.round((parseInt(durationMs, 10) || 0) / 1000);
        if (total <= 0) return '';
        var minutes = Math.floor(total / 60);
        var seconds = total % 60;
        return (minutes < 10 ? '0' + minutes : String(minutes)) + ':' +
            (seconds < 10 ? '0' + seconds : String(seconds));
    }

    // 平台的档位表比请求档位窄时（酷我/咪咕没有 hires），按星海自己的 mapQuality 规则往下找
    function xinghaiQuality(level, source, settings) {
        var want = LEVEL_QUALITY[String(level || '').toLowerCase()] || 'flac';
        var available = XH_QUALITIES[source] || XH_QUALITIES.wy;
        // 星海只有 QQ 支持 192k；其余平台宁可给 320k，不要掉到 128k
        if (want === '192k' && available.indexOf('192k') < 0) want = '320k';
        var start = QUALITY_ORDER.indexOf(want);
        if (start < 0) { want = 'flac'; start = QUALITY_ORDER.indexOf(want); }
        for (var i = start; i < QUALITY_ORDER.length; i++) {
            if (available.indexOf(QUALITY_ORDER[i]) >= 0 || QUALITY_ORDER[i] === 'flac24bit') {
                want = QUALITY_ORDER[i];
                break;
            }
        }
        var cap = text(settings.xhQuality, 'auto');
        if (QUALITY_ORDER.indexOf(cap) >= 0 && QUALITY_ORDER.indexOf(want) < QUALITY_ORDER.indexOf(cap)) return cap;
        return want;
    }

    // 请求档位 -> 依次降档的星海参数列表；不再固定只从 flac 开始
    function qualityLadder(want, source) {
        var available = XH_QUALITIES[source] || XH_QUALITIES.wy;
        var ladder = [];
        var start = QUALITY_ORDER.indexOf(want);
        if (start < 0) return [want];
        for (var i = start; i < QUALITY_ORDER.length; i++) {
            if (available.indexOf(QUALITY_ORDER[i]) >= 0) ladder.push(QUALITY_ORDER[i]);
        }
        return ladder.length ? ladder : [want];
    }

    function backendPath(song, quality) {
        var source = PLATFORMS[text(song.origin, 'netease').toLowerCase()] || 'wy';
        var params = {};
        if (source === 'kg') {
            // v3.2.20 酷狗走 hash / albumId，不再靠歌名+歌手模糊搜
            var hash = text(song.hash, '') || text(song.songId, '');
            params.source = 'kg';
            params.quality = quality;
            params.songmid = text(song.songId, '');
            params.albumId = text(song.albumId, '');
            params.mainHash = text(song.hash, '');
            if (/^[0-9a-f]{32}$/i.test(hash)) params.hash = hash;
        } else {
            params = {
                source: source,
                name: text(song.title, ''),
                singer: text(song.artists, ''),
                songmid: text(song.songId, ''),
                interval: intervalOf(song.durationMs),
                albumName: text(song.album, ''),
                quality: quality
            };
        }
        var parts = [];
        Object.keys(params).forEach(function (key) {
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        });
        return '/lx/api/?' + parts.join('&');
    }

    function typeOf(url) {
        var path = String(url).split('#')[0].split('?')[0];
        var name = path.substring(path.lastIndexOf('/') + 1);
        var dot = name.lastIndexOf('.');
        var ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
        return FILE_TYPES.indexOf(ext) >= 0 ? ext : '';
    }

    function levelByBr(br, type) {
        var n = parseFloat(br) || 0;
        if (n >= 1500000) return 'hires';
        if (type === 'flac' || n > 400000) return 'lossless';
        if (n >= 300000) return 'exhigh';
        if (n >= 180000) return 'higher';
        return 'standard';
    }

    function xinghaiLinkOf(data, wantLevel) {
        if (!data) throw new Error('返回内容不是 JSON');
        if (data.code === 403) xhBlocked = true;
        if (data.code !== 200) {
            throw new Error(text(data.msg, '') || text(data.upstream_msg, '') || '接口没有返回链接');
        }
        var url = text(data.url, '') || text(data.data && data.data.url, '');
        if (!/^https?:\/\/\S{4,}/i.test(url)) throw new Error('没有可用直链');
        var format = text(data.format, '').toLowerCase();
        var type = FILE_TYPES.indexOf(format) >= 0 ? format : typeOf(url);
        var link = { url: url };
        if (type) link.type = type;
        // 仅用于调试提示，宿主只读 url/type/quality/headers，多余字段会被忽略
        // 后端 br 可能是 "4.256422e+06" 这种科学计数法字符串，parseInt 会截成 4
        var nbr = parseFloat(data.br) || 0;
        if (nbr > 0) link.br = nbr;
        var got = QUALITY_LEVEL[text(data.quality, '').toLowerCase()] || levelByBr(data.br, type);
        // 按后端实际给的档位记录（hires/master 不再被压成 lossless），
        // 宿主的下载记录和「已有更高音质就跳过」判断才对得上。
        link.quality = got;
        if (wantLevel && levelRank(got) < levelRank(wantLevel)) link.downgraded = true;
        return link;
    }

    // 同一次调用里按档位阶梯重试：请求 flac 拿到坏链就退 320k、再退 128k
    function resolveXinghai(song, level, settings, deadline) {
        if (xhBlocked) return Promise.reject(new Error('后端刚才返回 403，本次不再尝试'));
        var source = PLATFORMS[text(song.origin, 'netease').toLowerCase()] || 'wy';
        var want = xinghaiQuality(level, source, settings);
        var available = XH_QUALITIES[source] || XH_QUALITIES.wy;
        var ladder = qualityLadder(want, source);
        var index = 0;
        var lastError = null;
        var probes = 0;
        var upgraded = false;     // 后端偷偷降档后是否已上探过更高档位
        var upgradeNote = '';

        function step() {
            if (index >= ladder.length) return Promise.reject(lastError || new Error('所有音质档位都没有可用链接'));
            var wait = waitFor(deadline, REQUEST_WAIT_MS);
            if (!wait) return Promise.reject(lastError || new Error('时间不够，跳过剩余音质档位'));
            var quality = ladder[index++];
            var path = backendPath(song, quality);
            return tokenOf(settings).then(function (token) {
                if (!token) throw new Error('星海令牌获取失败，换其他接口');
                return xinghaiGet(path, token, wait, settings).then(function (body) {
                    var data = parseJson(body);
                    if (!tokenStale(data)) return xinghaiLinkOf(data, level);
                    // 令牌失效：清掉后换新的再试一次，仍失败就交给下一档
                    xhToken = '';
                    xhTokenAt = 0;
                    return tokenOf(settings).then(function (fresh) {
                        if (!fresh) throw new Error('刷新令牌失败');
                        return xinghaiGet(path, fresh, waitFor(deadline, REQUEST_WAIT_MS) || 900, settings);
                    }).then(function (retryBody) {
                        return xinghaiLinkOf(parseJson(retryBody), level);
                    });
                });
            }).then(function (link) {
                // 星海会把 hires 悄悄降成普通 flac（实测冬雨：请求 hires 得 quality=flac/762kbps，
                // 而同一首请求 master 能拿到 4.2Mbps）。默认再往上探一次，别把 16bit 当 Hi-Res 交出去。
                if (!upgraded && settings.preferMaster !== false &&
                    levelRank(link.quality) < levelRank(level)) {
                    upgraded = true;
                    var higher = [];
                    for (var j = 0; j < QUALITY_ORDER.indexOf(want); j++) {
                        if (available.indexOf(QUALITY_ORDER[j]) >= 0) higher.push(QUALITY_ORDER[j]);
                    }
                    if (higher.length) {
                        upgradeNote = '后端把' + qualityName(level) + '降成了' + qualityName(link.quality);
                        ladder = higher.concat(ladder.slice(index));
                        index = 0;
                        lastError = new Error(upgradeNote);
                        return step();
                    }
                }
                if (upgradeNote && levelRank(link.quality) >= levelRank(level)) {
                    notify(upgradeNote + '，已改取' + qualityName(link.quality));
                }
                // 直链一般稳定；后端转发链接实测出现过 502，交给宿主前先探一次
                if (!isProxyUrl(link.url) || probes >= 2) return link;
                var probeWait = waitFor(deadline, PROBE_WAIT_MS);
                if (!probeWait) return link;
                probes++;
                return probeUrl(link.url, probeWait).then(function (verdict) {
                    if (verdict !== 'bad') return link;
                    lastError = new Error(quality + ' 的链接不可用');
                    return step();
                });
            }, function (e) {
                lastError = e;
                return step();
            });
        }

        return step();
    }

    // ---------- 公开接口 ----------

    function platformOf(song) {
        return PUBLIC_SOURCE[text(song.origin, 'netease').toLowerCase()] || 'netease';
    }

    function cookiePart(settings) {
        var cookie = text(settings.cookie, '');
        return cookie ? '&cookie=' + encodeURIComponent(cookie) : '';
    }

    function pickBr(settings, level) {
        var fixed = parseInt(text(settings.br, 'auto'), 10);
        if (fixed === 128 || fixed === 320 || fixed === 999) return fixed;
        return LEVEL_BR[String(level || 'standard').toLowerCase()] || 320;
    }

    function gdstudio(song, br, settings) {
        return 'https://music-api.gdstudio.xyz/api.php?types=url' +
            '&source=' + encodeURIComponent(platformOf(song)) +
            '&id=' + encodeURIComponent(text(song.songId, '')) +
            '&br=' + br + cookiePart(settings);
    }

    function meting(host) {
        return function (song, br, settings) {
            return 'https://' + host + '/meting/?type=url' +
                '&source=' + encodeURIComponent(platformOf(song)) +
                '&id=' + encodeURIComponent(text(song.songId, '')) +
                '&br=' + br + cookiePart(settings);
        };
    }

    // 自定义模板：占位符全部做 URL 编码，模板里的固定参数原样保留
    function custom(song, br, settings) {
        var template = text(settings.endpoint, '');
        if (!template) return '';
        return template
            .replace(/\{id\}/g, encodeURIComponent(text(song.songId, '')))
            .replace(/\{br\}/g, String(br))
            .replace(/\{source\}/g, encodeURIComponent(platformOf(song)))
            .replace(/\{quality\}/g, encodeURIComponent(text(song.quality, 'standard')))
            .replace(/\{title\}/g, encodeURIComponent(text(song.title, '')))
            .replace(/\{artist\}/g, encodeURIComponent(text(song.artists, '')))
            .replace(/\{cookie\}/g, encodeURIComponent(text(settings.cookie, '')));
    }

    var PROVIDERS = {
        custom: { key: 'custom', label: '自定义接口', build: custom },
        gdstudio: { key: 'gdstudio', label: 'GD 接口', build: gdstudio },
        inj: { key: 'inj', label: 'Meting(injahow)', build: meting('api.injahow.cn') },
        qijieya: { key: 'qijieya', label: 'Meting(qijieya)', build: meting('api.qijieya.cn') }
    };

    function labelOf(key) {
        if (key === 'xinghai') return '星海后端';
        return PROVIDERS[key] ? PROVIDERS[key].label : key;
    }

    // 指定了某个接口就只试它；auto 时星海优先，其次自定义，其余按稳定性排
    function chainOf(mode, settings) {
        if (mode === 'xinghai' || mode === 'custom' || mode === 'gdstudio' || mode === 'inj' || mode === 'qijieya') return [mode];
        var list = ['xinghai'];
        if (text(settings.endpoint, '')) list.push('custom');
        list.push('gdstudio', 'inj', 'qijieya');
        return list;
    }

    // 各接口字段名不统一，按 url 优先、再往常见容器里找的结构递归取第一条直链
    function pickUrl(node, depth) {
        if (node === null || node === undefined || depth > 5) return null;
        if (typeof node === 'string') return /^https?:\/\/\S{4,}/i.test(node.trim()) ? node.trim() : null;
        if (Object.prototype.toString.call(node) === '[object Array]') {
            for (var i = 0; i < node.length; i++) {
                var hit = pickUrl(node[i], depth + 1);
                if (hit) return hit;
            }
            return null;
        }
        if (typeof node !== 'object') return null;
        var k;
        for (k = 0; k < URL_KEYS.length; k++) {
            if (typeof node[URL_KEYS[k]] === 'string' && /^https?:\/\/\S{4,}/i.test(node[URL_KEYS[k]].trim())) {
                return node[URL_KEYS[k]].trim();
            }
        }
        for (k = 0; k < GROUP_KEYS.length; k++) {
            var nested = pickUrl(node[GROUP_KEYS[k]], depth + 1);
            if (nested) return nested;
        }
        return null;
    }

    function publicLinkOf(body) {
        var raw = String(body || '').trim();
        if (!raw) throw new Error('接口返回为空');
        var url = null;
        var head = raw.charAt(0);
        if (head === '{' || head === '[') {
            url = pickUrl(parseJson(raw), 0);
        } else if (/^https?:\/\//i.test(raw)) {
            url = raw.split(/\s/)[0];
        }
        if (!url) throw new Error('接口没有返回可用链接');
        return url;
    }

    // 音质宁可靠低：接口给 mp3 就不写 lossless，否则以后选无损会被判成「已下载」
    function toLink(url, br) {
        var type = typeOf(url);
        var link = { url: url };
        if (type) link.type = type;
        if (type === 'flac') link.quality = 'lossless';
        else if (br >= 320) link.quality = 'exhigh';
        else if (br >= 192) link.quality = 'higher';
        else link.quality = 'standard';
        return link;
    }

    // 公开接口同样降档：999 -> 320 -> 128，很多镜像对高码率只会返回空
    function resolvePublic(key, song, level, settings, deadline) {
        var provider = PROVIDERS[key];
        if (!provider) return Promise.reject(new Error('未知接口'));
        var start = pickBr(settings, level);
        var ladder = [start];
        if (start > 320) ladder.push(320);
        if (ladder[ladder.length - 1] > 128) ladder.push(128);
        var index = 0;
        var lastError = null;

        function step() {
            if (index >= ladder.length) return Promise.reject(lastError || new Error('接口没有返回链接'));
            var wait = waitFor(deadline, REQUEST_WAIT_MS);
            if (!wait) return Promise.reject(lastError || new Error('时间不够'));
            var br = ladder[index++];
            var url = '';
            try {
                url = provider.build(song, br, settings);
            } catch (e) {
                url = '';
            }
            if (!url) return Promise.reject(new Error('没有配置接口地址'));
            return httpGet(url, { 'User-Agent': 'Melodia-DownloadBridge/1.2' }, wait).then(function (body) {
                return toLink(publicLinkOf(body), br);
            }).then(null, function (e) {
                lastError = e;
                return step();
            });
        }

        return step();
    }

    // ---------- 入口 ----------

    function notify(content) {
        var message = String(content || '');
        if (message.length > 96) message = message.substring(0, 96) + '…';
        melodia.ui.toast(message).then(function () { }, function () { });
    }

    function reportError(message) {
        if (!cache || !cache.debug) return;
        notify(message || '未取到链接');
    }

    // 宿主把 resolve 当对象方法调用，参数是 {songId,title,artists,album,durationMs,origin,quality}
    function resolve(song) {
        reason = '';
        var query = song && typeof song === 'object' ? song : {};
        return readSettings().then(function (settings) {
            var level = requestedLevel(query);
            if (cache && cache.debug) {
                notify('收到下载档位：' + text(query.quality, '(空)') + ' → ' + qualityName(level));
            }
            var list = chainOf(text(settings.provider, 'auto'), settings);
            var deadline = Date.now() + BUDGET_MS;
            var index = 0;

            function step() {
                if (index >= list.length) {
                    reportError(reason || '所有接口都没有返回直链');
                    return null;
                }
                if (Date.now() > deadline - 600) {
                    reportError(reason || '接口响应超时');
                    return null;
                }
                var key = list[index++];
                var task = key === 'xinghai'
                    ? resolveXinghai(query, level, settings, deadline)
                    : resolvePublic(key, query, level, settings, deadline);
                return task.then(function (link) {
                    if (!link) return step();
                    if (cache && cache.debug && link.br) {
                        notify('星海实际返回：' + qualityName(link.quality) + ' · ' + Math.round(link.br / 1000) + ' kbps');
                    }
                    if (!meetsMin(link.quality, settings)) {
                        reason = labelOf(key) + ' 只给到 ' + qualityName(link.quality) + '，低于设置的最低音质';
                        return step();
                    }
                    // 拿到的比请求的低时明确说出来，避免以为下到了无损
                    var got = levelRank(link.quality);
                    var want = levelRank(level);
                    if (link.downgraded || (got >= 0 && want >= 0 && got < want)) {
                        notify('已降级为' + qualityName(link.quality));
                    }
                    // 插件只能在交出链接这一刻发一条提示。百分比与「下载完成」由 Melodia
                    // 自己的下载横幅/通知负责，沙盒 API 没有下载进度或完成事件可订阅。
                    if (settings.notifyStart !== false) {
                        notify('已取到 ' + qualityName(link.quality) + ' 直链，开始下载');
                    }
                    return link;
                }, function (e) {
                    reason = labelOf(key) + '：' + messageOf(e);
                    return step();
                });
            }

            return step();
        }).then(null, function (e) {
            reportError('插件内部错误：' + messageOf(e));
            return null;
        });
    }

    try {
        melodia.register.downloadSource('main', { resolve: resolve });
    } catch (e) {
        // 注册失败时什么也不做，插件会被宿主标记为无效，不会拖累其他插件
    }
})();
