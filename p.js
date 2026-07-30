'use strict';

/*
 * yt-tv-adskip PROBE —— 测量用，不是生产脚本。
 *
 * 它回答一个我们一直缺的问题：**YouTube 现在到底有没有给这台设备投广告？**
 *
 * 为什么需要它：今天所有"广告有没有出现"的实验都失效了 ——
 * 用同一个 APK 差一字节做的 A/B 显示，无拦截那边也没有广告，
 * 也就是投放本身被频次上限耗尽了。而"没广告"既可能是我们拦住了，
 * 也可能是根本没投，两者在屏幕上无法区分。
 *
 * 靠颜色识别广告界面也失败了：实测正片里恰好出现的黄色（Gangnam Style
 * 右下角的攀爬架）能拿到 83–251 分，而最弱的真广告只有 8 分，四种关注区域
 * 都不可分离。像素这条路是死的。
 *
 * 所以换个问法：canary 已经证明我们的 hook 拦得到 player response，
 * 那就直接读服务器发来的广告字段，而不是猜屏幕。
 *
 *   有广告字段 -> 故意让播放失败（屏幕出错误页，截图约 25 KB）
 *   没有广告字段 -> 什么都不做（正常播放，截图约 1.4 MB）
 *
 * 判据因此是二值且机器可读的，用截图大小就能区分，不需要任何视觉识别，
 * 也没有误报 —— 数据来自服务器本身。
 *
 * 语法同样限制在 ES2015 以内（目标是旧版 Cobalt 引擎）。
 */

var PLAYER_FIELDS = ['videoDetails', 'streamingData', 'playabilityStatus'];

function looksLikePlayerResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  for (var i = 0; i < PLAYER_FIELDS.length; i++) {
    if (PLAYER_FIELDS[i] in value) { return true; }
  }
  return false;
}

/*
 * 数出响应里真正带内容的广告槽位。
 * 只看"存在"是不够的 —— 服务端有时会带一个空数组，那不算投放。
 */
function countAdSlots(value) {
  var n = 0;
  if (value.adPlacements && value.adPlacements.length) { n += value.adPlacements.length; }
  if (value.adSlots && value.adSlots.length) { n += value.adSlots.length; }
  if (value.playerAds) {
    if (value.playerAds.length) { n += value.playerAds.length; }
    else if (value.playerAds === true) { n += 1; }
  }
  return n;
}

function describe(value) {
  var parts = [];
  parts.push('adPlacements=' + (value.adPlacements ? value.adPlacements.length : 'absent'));
  parts.push('adSlots=' + (value.adSlots ? value.adSlots.length : 'absent'));
  parts.push('playerAds=' + (value.playerAds ? (value.playerAds.length || 'true') : 'absent'));
  return parts.join(' ');
}

function inspectAndReport(value) {
  try {
    if (!looksLikePlayerResponse(value)) { return value; }
    var n = countAdSlots(value);
    if (n === 0) { return value; }   // 没投广告：完全不干预，正常播放

    /* 投了广告：故意让播放失败，并把计数写进错误原因。
       屏幕上出现这行字 = 服务器这次确实发了广告。 */
    var msg = 'ADSKIP PROBE AD PRESENT n=' + n;
    value.playabilityStatus = {
      status: 'ERROR',
      reason: msg,
      errorScreen: {
        playerErrorMessageRenderer: {
          reason: { simpleText: msg },
          subreason: { simpleText: describe(value) }
        }
      }
    };
  } catch (e) {
    /* 测量脚本也不能把页面搞崩 —— 那样就分不清是"投了广告"还是"脚本炸了"。 */
  }
  return value;
}

var MARKER = '__ytAdskipHooked';

function installHook(root) {
  var original = root.JSON.parse;
  if (original[MARKER]) { return original; }
  function patched(text, reviver) {
    return inspectAndReport(original.call(root.JSON, text, reviver));
  }
  patched[MARKER] = true;
  try { root.JSON.parse = patched; } catch (e) {}
  return patched;
}

function rebindModuleJson(root) {
  var patched = root.JSON && root.JSON.parse;
  if (!patched || !patched[MARKER]) { return 0; }
  var modules = root._yttv;
  if (!modules || typeof modules !== 'object') { return 0; }
  var count = 0;
  var keys;
  try { keys = Object.keys(modules); } catch (e) { return 0; }
  for (var i = 0; i < keys.length; i++) {
    try {
      var m = modules[keys[i]];
      if (m && m.JSON && typeof m.JSON.parse === 'function' && !m.JSON.parse[MARKER]) {
        m.JSON.parse = patched;
        count++;
      }
    } catch (e) {}
  }
  return count;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    looksLikePlayerResponse: looksLikePlayerResponse,
    countAdSlots: countAdSlots,
    describe: describe,
    inspectAndReport: inspectAndReport,
    installHook: installHook,
    rebindModuleJson: rebindModuleJson
  };
}

if (typeof window !== 'undefined' && window.JSON) {
  installHook(window);
  rebindModuleJson(window);
}
