'use strict';

/*
 * yt-tv-adskip CANARY —— 诊断用，不是生产脚本。
 *
 * 它存在的唯一目的：证明我们的 hook 真的拦到了 player response。
 *
 * 为什么需要它：广告拦截是否生效，正常只能靠"广告有没有出现"来判断，
 * 而 YouTube 的广告投放是随机且有频次上限的 —— 实测今天播了二十来个视频之后
 * 就完全不投了，于是实验组和对照组都是"没广告"，什么都证明不了。
 * 角标也不渲染（两次确认），所以没有任何正面证据。
 *
 * canary 把因果反过来：它**故意破坏播放**，并把我们的标记写进错误原因。
 * 电视上出现那行标记 = hook 装上了、且确实经过 player response。
 * 播放正常 = hook 没生效，那是一个需要修的真 bug。
 *
 * 判断依据刻意用 videoDetails / streamingData / playabilityStatus 而不是
 * adPlacements —— 因为不投广告时 adPlacements 可能根本不存在，
 * 用它判断会在最需要观测的时候恰好观测不到。
 *
 * 语法同样限制在 ES2015 以内（目标是旧版 Cobalt 引擎）。
 */

var MARK = 'YT-TV-ADSKIP CANARY OK';
var PLAYER_FIELDS = ['videoDetails', 'streamingData', 'playabilityStatus'];

function looksLikePlayerResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  for (var i = 0; i < PLAYER_FIELDS.length; i++) {
    if (PLAYER_FIELDS[i] in value) { return true; }
  }
  return false;
}

function sabotage(value) {
  try {
    if (!looksLikePlayerResponse(value)) { return value; }
    /* 把标记写进 reason：YouTube TV 会把 reason 显示在屏幕上，
       所以这行字出现在电视上就是不可伪造的证据。 */
    value.playabilityStatus = {
      status: 'ERROR',
      reason: MARK,
      errorScreen: {
        playerErrorMessageRenderer: {
          reason: { simpleText: MARK },
          subreason: { simpleText: 'hook reached the player response' }
        }
      }
    };
  } catch (e) {
    /* 连 canary 也不能把页面搞崩 —— 那样就分不清是 hook 生效还是脚本炸了。 */
  }
  return value;
}

var MARKER = '__ytAdskipHooked';

function installHook(root) {
  var original = root.JSON.parse;
  if (original[MARKER]) { return original; }
  function patched(text, reviver) {
    return sabotage(original.call(root.JSON, text, reviver));
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
    sabotage: sabotage,
    installHook: installHook,
    rebindModuleJson: rebindModuleJson,
    MARK: MARK
  };
}

if (typeof window !== 'undefined' && window.JSON) {
  installHook(window);
  rebindModuleJson(window);
}
