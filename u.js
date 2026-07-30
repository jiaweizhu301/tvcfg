'use strict';

/*
 * yt-tv-adskip userscript
 *
 * 自托管的广告拦截层。单文件、无构建步骤、无第三方依赖。
 * 语法刻意保持 ES2015 以内（var / 函数声明，不用箭头函数、模板串、let）——
 * 目标引擎是旧版 Cobalt，JS 能力未知，语法不被支持会导致整个脚本静默失效。
 *
 * 三件事，缺一不可（每一条都是代码评审指出来的）：
 *
 * 1. 播放广告：在 JSON.parse 出口清空 player response 里的广告槽位，
 *    播放器"看不到"广告，于是广告根本不渲染，不是出现后被跳过。
 *
 * 2. 界面广告：首页/信息流里的 adSlotRenderer 与 tvMastheadRenderer 是另一条
 *    通路，只清 player response 拦不住它们。
 *
 * 3. **必须 rebind 每个 YouTube 模块自己的 JSON 引用。** YouTube 的 TV 模块
 *    （window._yttv 下）各自持有 JSON 对象的引用，只改 window.JSON.parse 不够。
 *    而且 YouTube 用过 Object.defineProperty 把 JSON.parse 设成不可写，那样赋值
 *    会**静默失败** —— 所以赋值之后必须回读验证。
 *
 * 另外：hook 内部一律 try/catch。这个 wrapper 坐在页面上每一次 JSON.parse 的
 * 路径上，我们自己抛一个异常就会让整个页面解析崩掉、白屏 —— 那正是
 * fail-open 契约禁止的事情。拦截失败必须退化成"有广告"，不能退化成"打不开"。
 */

/* ------------------------------------------------------------ 播放广告 -- */

var AD_FIELDS = ['adPlacements', 'playerAds', 'adSlots'];

function isPlayerResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  for (var i = 0; i < AD_FIELDS.length; i++) {
    if (AD_FIELDS[i] in value) {
      return true;
    }
  }
  return false;
}

function stripAds(value) {
  if (!isPlayerResponse(value)) {
    return value;
  }
  /* 只动本来就存在的字段：凭空添加会让响应结构与服务端不一致。 */
  if ('adPlacements' in value) { value.adPlacements = []; }
  if ('playerAds' in value) { value.playerAds = false; }
  if ('adSlots' in value) { value.adSlots = []; }
  return value;
}

/* ------------------------------------------------------------ 界面广告 -- */

var AD_ITEM_KEYS = ['adSlotRenderer', 'tvMastheadRenderer', 'promotedSparklesTextRenderer'];

function looksLikeAdItem(item) {
  if (!item || typeof item !== 'object') { return false; }
  for (var i = 0; i < AD_ITEM_KEYS.length; i++) {
    if (AD_ITEM_KEYS[i] in item) { return true; }
  }
  /* Shorts：reelWatchEndpoint.adClientParams.isAd */
  var reel = item.reelWatchEndpoint ||
             (item.reelItemRenderer && item.reelItemRenderer.navigationEndpoint &&
              item.reelItemRenderer.navigationEndpoint.reelWatchEndpoint);
  if (reel && reel.adClientParams && reel.adClientParams.isAd) { return true; }
  return false;
}

/* 只在看起来像 feed/browse 响应时才递归，避免在弱 SoC 上对每个 JSON 做全树遍历。 */
var FEED_HINTS = ['contents', 'onResponseReceivedActions', 'continuationContents', 'items'];

function looksLikeFeed(value) {
  if (!value || typeof value !== 'object') { return false; }
  for (var i = 0; i < FEED_HINTS.length; i++) {
    if (FEED_HINTS[i] in value) { return true; }
  }
  return false;
}

var MAX_DEPTH = 16;

function removeAdItems(value, depth) {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') { return value; }

  var i;
  if (Array.isArray(value)) {
    /* 原地删除，不重建数组：调用方可能持有同一个引用。 */
    for (i = value.length - 1; i >= 0; i--) {
      if (looksLikeAdItem(value[i])) {
        value.splice(i, 1);
      } else {
        removeAdItems(value[i], depth + 1);
      }
    }
    return value;
  }

  var keys = Object.keys(value);
  for (i = 0; i < keys.length; i++) {
    removeAdItems(value[keys[i]], depth + 1);
  }
  return value;
}

function stripFeedAds(value) {
  if (!looksLikeFeed(value)) { return value; }
  return removeAdItems(value, 0);
}

/* 两条通路合起来的入口，异常一律吞掉：见文件头关于 fail-open 的说明。 */
function scrub(value) {
  try {
    stripAds(value);
    stripFeedAds(value);
  } catch (e) {
    /* 拦截失败可以接受（会有广告）；让页面崩掉不可以。 */
  }
  return value;
}

/* ---------------------------------------------------------------- hook -- */

var MARKER = '__ytAdskipHooked';

function installHook(root) {
  var original = root.JSON.parse;
  if (original[MARKER]) {
    /* 幂等：重复注入（脚本被加载两次）不能套两层 wrapper。 */
    return original;
  }

  function patched(text, reviver) {
    return scrub(original.call(root.JSON, text, reviver));
  }
  patched[MARKER] = true;

  try {
    root.JSON.parse = patched;
  } catch (e) {
    /* JSON.parse 可能被 Object.defineProperty 设成不可写 —— 严格模式下赋值抛错。
       不要让它把整个脚本带走；由 verifyInstalled() 报告真实结果。 */
  }
  return patched;
}

/*
 * YouTube 的 TV 模块各自持有 JSON 的引用，只改 window.JSON.parse 不够。
 * 上游 adblock.js 正是因此加了这个循环。
 */
function rebindModuleJson(root) {
  var patched = root.JSON && root.JSON.parse;
  if (!patched || !patched[MARKER]) { return 0; }

  var modules = root._yttv;
  if (!modules || typeof modules !== 'object') { return 0; }

  var count = 0;
  var keys;
  try {
    keys = Object.keys(modules);
  } catch (e) {
    return 0;
  }
  for (var i = 0; i < keys.length; i++) {
    try {
      var m = modules[keys[i]];
      if (m && m.JSON && typeof m.JSON.parse === 'function' && !m.JSON.parse[MARKER]) {
        m.JSON.parse = patched;
        count++;
      }
    } catch (e) {
      /* 某个模块是 getter 或被冻结 —— 跳过它，继续处理其余的。 */
    }
  }
  return count;
}

/*
 * 赋值成功不等于装上了：不可写属性在非严格调用点会静默失败。
 * 回读验证是唯一可信的判据。
 */
function verifyInstalled(root) {
  var p = root && root.JSON && root.JSON.parse;
  return !!(p && p[MARKER]);
}

/* -------------------------------------------------------------- 可见性 -- */

/*
 * 静默失效是这套东西最大的风险：服务器没开、IP 变了、防火墙规则丢了、
 * JSON.parse 被锁住 —— 表现全都一样（广告回来了，没有任何提示）。
 * 所以在电视上给一个开机可见的角标：**看到它就是装上了**，看不到就是没装上。
 * 6 秒后自动消失，不长期占屏。
 */
/* 角标停留时长。够你在电视前看清，又不至于长期占屏。 */
var BADGE_MS = 12000;

function showBadge(doc, ok) {
  try {
    if (!doc || !doc.body) { return false; }
    var el = doc.createElement('div');
    el.setAttribute('data-yt-tv-adskip', '1');
    el.textContent = ok ? 'adskip on' : 'adskip FAILED';
    el.style.cssText = [
      'position:fixed', 'right:28px', 'bottom:24px', 'z-index:2147483647',
      'font:500 20px/1 sans-serif', 'letter-spacing:.08em',
      'padding:10px 16px', 'border-radius:4px',
      'color:' + (ok ? '#dff5e6' : '#ffe1de'),
      'background:' + (ok ? 'rgba(20,80,45,.88)' : 'rgba(120,30,25,.92)'),
      'pointer-events:none'
    ].join(';');
    doc.body.appendChild(el);
    if (typeof doc.defaultView !== 'undefined' && doc.defaultView && doc.defaultView.setTimeout) {
      doc.defaultView.setTimeout(function () {
        try { if (el.parentNode) { el.parentNode.removeChild(el); } } catch (e) {}
      }, BADGE_MS);
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* --------------------------------------------------------------- 导出 -- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isPlayerResponse: isPlayerResponse,
    stripAds: stripAds,
    looksLikeAdItem: looksLikeAdItem,
    looksLikeFeed: looksLikeFeed,
    removeAdItems: removeAdItems,
    stripFeedAds: stripFeedAds,
    scrub: scrub,
    installHook: installHook,
    rebindModuleJson: rebindModuleJson,
    verifyInstalled: verifyInstalled,
    showBadge: showBadge
  };
}

/* 只在真实页面里自动安装；被 Node 测试 require 时不产生副作用。 */
if (typeof window !== 'undefined' && window.JSON) {
  installHook(window);
  var rebound = rebindModuleJson(window);
  var ok = verifyInstalled(window);
  try {
    console.log('[yt-tv-adskip] installed=' + ok + ' rebound=' + rebound);
  } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.body) {
      showBadge(document, ok);
    } else if (document.addEventListener) {
      document.addEventListener('DOMContentLoaded', function () { showBadge(document, ok); });
    }
  }
}
