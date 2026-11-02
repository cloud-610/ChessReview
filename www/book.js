/* =========================================================================
 * 开局库 —— 「谱着」(Book) 判定
 * 收录主流开局主线（UCI 序列）。复盘时，着法序列前缀命中即判「谱着」。
 * 每条主线都会在自测中做合法性验证。
 * ========================================================================= */
'use strict';

var BOOK_LINES = [
  // ---- 王兵开局 ----
  ['西班牙封闭体系', 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8 h2h3 c6a5 b3c2 c7c5'],
  ['意大利慢变例', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1g1 e8g8 f1e1 a7a6'],
  ['意大利古典主变', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4 e5d4 c3d4 c5b4'],
  ['伊文斯弃兵', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4 c5b4 c2c3 b4c5 d2d4'],
  ['双马防御', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5'],
  ['苏格兰开局', 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 d4c6 b7c6 e4e5 d8e7 d1e2 f6d5 c2c4'],
  ['彼得罗夫防御', 'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5 f1d3'],
  ['维也纳弃兵', 'e2e4 e7e5 b1c3 g8f6 f2f4 e5f4 f1c4'],
  ['王翼弃兵', 'e2e4 e7e5 f2f4 e5f4 g1f3 g7g5 f1c4 g5g4'],
  ['柏林防御', 'e2e4 e7e5 g1f3 b8c6 f1b5 g8f6 e1g1 f6e4 d2d4 e4d6 b5c6 d7c6 d4e5 d6f5 d1d8 e8d8'],
  ['维也纳古典', 'e2e4 e7e5 b1c3 g8f6 g1f3 b8c6 f1c4 f8c5'],

  // ---- 西西里防御 ----
  ['西西里·纳多尔夫', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 f1e2 e7e5 d4b3 f8e7 e1g1 e8g8'],
  ['西西里·龙式变例', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6 c1e3 f8g7 f2f3 e8g8 d1d2 b8c6 e1c1'],
  ['西西里·古典变例', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e6 f1e2 f8e7 e1g1 e8g8'],
  ['西西里·斯维斯尼科夫', 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5 d4b5 d7d6 c1g5 a7a6 b5a3 b7b5'],
  ['西西里·罗索里莫', 'e2e4 c7c5 g1f3 b8c6 f1b5 g7g6 e1g1 f8g7 f1e1 g8f6 c2c3 e8g8'],
  ['西西里·阿拉平变例', 'e2e4 c7c5 c2c3 g8f6 e4e5 f6d5 d2d4 c5d4'],
  ['西西里·封闭变例', 'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 d2d3 d7d6 g1e2 g8f6 e1g1 e8g8'],

  // ---- 半开放防御 ----
  ['法兰西·古典变例', 'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7 g5e7 d8e7'],
  ['法兰西·维纳维尔', 'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4 e4e5 c7c5 a2a3 b4c3 b2c3 g8e7'],
  ['法兰西·推进变例', 'e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3 b8c6 g1f3 d8b6'],
  ['法兰西·塔拉什变例', 'e2e4 e7e6 d2d4 d7d5 b1d2 c7c5 e4d5 e6d5 g1f3 g8f6'],
  ['卡罗·坎·古典变例', 'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6 h2h4 h7h6 g1f3 b8d7'],
  ['卡罗·坎·推进变例', 'e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5'],
  ['卡罗·坎·帕诺夫进攻', 'e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 c2c4 g8f6 b1c3 e7e6 g1f3 f8e7 c4d5 f6d5'],
  ['斯堪的纳维亚防御', 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c7c6 f1c4 c8f5'],
  ['皮尔茨防御', 'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7 f1e2 e8g8 e1g1 b8c6'],
  ['现代防御', 'e2e4 g7g6 d2d4 f8g7 b1c3 d7d6 g1f3 g8f6 f1e2 e8g8 e1g1 c7c6'],
  ['阿廖欣防御', 'e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 g7g6 f1c4 d5b6 c4b3'],

  // ---- 后兵开局 ----
  ['后翼弃兵·正变', 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8 g1f3 b8d7'],
  ['后翼弃兵·兑换变例', 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c4d5 e6d5 c1g5 c7c6 e2e3 b8d7'],
  ['后翼弃兵接受', 'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4 c7c5 e1g1 a7a6'],
  ['斯拉夫防御主变', 'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5 e2e3 e7e6 f1c4 f8b4 e1g1 e8g8'],
  ['半斯拉夫防御', 'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 e2e3 b8d7 f1d3 d5c4 d3c4'],
  ['卡塔兰开局', 'd2d4 g8f6 c2c4 e7e6 g1f3 d7d5 g2g3 f8e7 f1g2 e8g8 e1g1 d5c4'],
  ['古印度防御·古典变例', 'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5 e1g1 b8c6 d4d5 c6e7'],
  ['尼姆佐维奇·鲁宾斯坦', 'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5 g1f3 c7c5'],
  ['格林菲尔德·兑换变例', 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3 b2c3 f8g7 f1c4 c7c6'],
  ['格林菲尔德·古典变例', 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 g1f3 f8g7 c1f4 e8g8 e2e3'],
  ['后翼印度防御', 'd2d4 g8f6 c2c4 e7e6 b1c3 b7b6 e2e4 c8b7'],
  ['伦敦体系(对后兵)', 'd2d4 d7d5 g1f3 g8f6 c1f4 c7c5 e2e3 b8c6 b1d2 e7e6'],
  ['伦敦体系(对古印度)', 'd2d4 g8f6 g1f3 g7g6 c1f4 f8g7 e2e3 d7d6 f1e2 e8g8 e1g1'],
  ['布达佩斯弃兵', 'd2d4 g8f6 c2c4 e7e5 d4e5 f6g4'],

  // ---- 侧翼开局 ----
  ['英国式·倒西西里', 'c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5 g1f3 b8c6'],
  ['英国式·四马变例', 'c2c4 g8f6 b1c3 e7e5 g1f3 b8c6 g2g3 d7d5'],
  ['列蒂开局', 'g1f3 d7d5 c2c4 e7e6 g2g3 g8f6 f1g2 f8e7 e1g1 e8g8'],
  ['荷兰防御', 'd2d4 f7f5 g2g3 g8f6 f1g2 e7e6 g1f3 f8e7 e1g1 e8g8 c2c4']
];

/* 构建前缀集合：任意主线的任意前缀都算谱着 */
var BOOK_SET = (function () {
  var set = {};
  for (var i = 0; i < BOOK_LINES.length; i++) {
    var moves = BOOK_LINES[i][1].split(' ');
    var prefix = '';
    for (var k = 0; k < moves.length; k++) {
      prefix = prefix ? prefix + ' ' + moves[k] : moves[k];
      set[prefix] = BOOK_LINES[i][0];
    }
  }
  return set;
})();

/* 判断 uci 序列（空格分隔）是否命中开局库；返回开局名或 null */
function bookLookup(uciSeq) {
  if (!uciSeq) return null;
  var name = BOOK_SET[uciSeq];
  if (name) return name;
  return null;
}

if (typeof window !== 'undefined') {
  window.BOOK_LINES = BOOK_LINES;
  window.BOOK_SET = BOOK_SET;
  window.bookLookup = bookLookup;
}
