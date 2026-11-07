/* =========================================================================
 * 复盘引擎 —— 逐局面分析 + 11 类着法评价（对齐 chess.com 逻辑）
 *
 * 胜率换算（chess.com 同款公式）：
 *   W% = 50 + 50 × ( 2 / (1 + e^(−0.00368208×cp)) − 1 )
 *
 * 分类优先级：
 *   被强迫 > 谱着 > 失误(漏杀) > 败招 > 错招 > 软招 > 妙手 > 好棋 > 正招 > 不错 > 好
 * ========================================================================= */
'use strict';

var REVIEW = {};

(function () {

  var K = 0.00368208;

  /* ---- 胜率公式 ---- */
  function winPctFromCp(cp) {
    if (cp > 10000) cp = 10000;
    if (cp < -10000) cp = -10000;
    return 50 + 50 * (2 / (1 + Math.exp(-K * cp)) - 1);
  }

  /* 引擎结果 → 白方视角胜率（0-100）；null 表示无数据 */
  function nodeWinPct(node) {
    if (!node) return null;
    if (node.analyzed === false) return null;
    var mateW = node.mateW, cpW = node.cpW;
    if (mateW !== null && mateW !== undefined) return mateW > 0 ? 100 : 0;
    if (cpW === null || cpW === undefined) return null;
    return winPctFromCp(cpW);
  }

  function evalStr(node) {
    if (!node) return '';
    if (node.mateW !== null && node.mateW !== undefined) {
      return node.mateW > 0 ? '#' + node.mateW : '#-' + (-node.mateW);
    }
    if (node.cpW === null || node.cpW === undefined) return '';
    var v = node.cpW / 100;
    return (v > 0 ? '+' : '') + v.toFixed(1);
  }

  /* ---- 节点构建 ---- */
  function makeNode(fen, turn, legalCount) {
    return {
      fen: fen, turn: turn, legalCount: legalCount,
      analyzed: false,
      cp1: null, mate1: null, best1: null, pv1: [], depth1: 0,
      cp2: null, mate2: null, best2: null, pv2: [], depth2: 0,
      cpW: null, mateW: null
    };
  }

  /* 引擎结果（行棋方视角）写入节点并换算白方视角 */
  function fillNode(node, res) {
    node.analyzed = true;
    if (!res) return;
    node.cp1 = res.cp1; node.mate1 = res.mate1;
    node.best1 = res.best; node.pv1 = res.pv1 || []; node.depth1 = res.depth1 || 0;
    node.cp2 = res.cp2; node.mate2 = res.mate2;
    node.best2 = res.best2; node.pv2 = res.pv2 || []; node.depth2 = res.depth2 || 0;
    var white = node.turn === 'w';
    if (node.mate1 !== null && node.mate1 !== undefined) {
      node.mateW = white ? node.mate1 : -node.mate1;
      node.cpW = null;
    } else {
      node.cpW = white ? node.cp1 : (node.cp1 === null ? null : -node.cp1);
      node.mateW = null;
    }
  }

  /* ---- 弃子检测（妙手）：双方子力差口径（v1.0.3 重写） ----
   * 走子后沿引擎主线推演对方的最佳应手，比较前后「我方-对方」子力差：
   *   等价交换（车换车）：差值不变 → 不算弃子；
   *   以小换大（马换车）：差值上升 → 不算弃子；
   *   真弃子（象换兵 / 后换马等有目的地以大换小）：差值下降 → 弃子。 */
  function sacrificeValue(nodeBefore, nodeAfter, moverBlack) {
    try {
      var posB = new Position(nodeBefore.fen);
      var bal0 = materialOf(posB, moverBlack) - materialOf(posB, !moverBlack);
      var pos = new Position(nodeAfter.fen);
      var pv = nodeAfter.pv1 || [];
      if (pv.length) {
        var mv = uciToMove(pos, pv[0]);
        if (mv) pos.make(mv);
      }
      var bal1 = materialOf(pos, moverBlack) - materialOf(pos, !moverBlack);
      var sac = bal0 - bal1;
      return sac >= 1.5 ? sac : 0;
    } catch (e) {
      return 0;
    }
  }

  /* ---- 单步分类 ---- */
  function classifyMove(nodes, moveIdx, uciSeqPrefix, sans) {
    var before = nodes[moveIdx], after = nodes[moveIdx + 1];
    var moverBlack = before.turn === 'b';
    var playedUci = after.playedUci;

    var winB = nodeWinPct(before);
    var winA = nodeWinPct(after);
    if (winB === null || winA === null) return { cls: 'unknown', loss: 0, winB: null, winA: null };
    if (moverBlack) { winB = 100 - winB; winA = 100 - winA; }
    var loss = Math.max(0, winB - winA);

    // 次佳着法（同视角）
    var secondWin = null;
    if (before.analyzed && before.best2 &&
      (before.cp2 !== null && before.cp2 !== undefined || before.mate2 !== null && before.mate2 !== undefined)) {
      var secondWhite;
      if (before.mate2 !== null && before.mate2 !== undefined) {
        secondWhite = (before.turn === 'w') ? (before.mate2 > 0 ? 100 : 0) : (before.mate2 > 0 ? 0 : 100);
      } else {
        var cp2W = (before.turn === 'w') ? before.cp2 : -before.cp2;
        secondWhite = winPctFromCp(cp2W);
      }
      secondWin = moverBlack ? 100 - secondWhite : secondWhite;
    }
    var spread = (secondWin !== null) ? (winB - secondWin) : null;

    var isBest = (before.analyzed && before.best1 && playedUci === before.best1) ||
      (winA >= winB - 0.25);
    var legalCount = before.legalCount || 0;

    // 被强迫：唯一合法着法（只能这么走，其他走法都不合法）
    var forced = legalCount === 1;
    // 谱着：在线开局库优先（有数据时以其为准），离线/无数据时本地库兜底
    var bookName;
    var onlineName = (typeof BookOnline !== 'undefined' && before.bookOnline)
      ? BookOnline.lookup(before.bookOnline, playedUci) : null;
    if (onlineName) bookName = onlineName;
    else if (onlineName === '') bookName = null; // 在线库确认非谱着，不再回退本地
    else bookName = bookLookup(uciSeqPrefix) || null;
    // 失误（漏杀，v1.1.2）：曾有 forced mate 却没走出 → 失误（无论走后是否仍大优）；
    // 或原有大优局面被明显放走（旧规则保留）
    var hadMate = before.analyzed && before.mate1 !== null && before.mate1 !== undefined && before.mate1 > 0;
    // after 节点轮到对方走：mate1 < 0 表示对方将被杀 → 行棋方仍保有杀
    var keptMate = after.analyzed && after.mate1 !== null && after.mate1 !== undefined && after.mate1 < 0;
    var hadWin = false;
    if (before.analyzed) {
      var mateMover = before.mate1 !== null && before.mate1 !== undefined && before.mate1 > 0;
      var winBOk = winB >= 92;
      hadWin = mateMover || winBOk;
    }
    var missed = (hadMate && !keptMate && !isBest) || (hadWin && winA <= 85 && !isBest && loss >= 5);

    // 妙手：弃子 + 引擎最佳，且（唯一好棋 或 保持优势/存在杀棋）
    var brilliant = false, sacVal = 0;
    if (isBest) {
      sacVal = sacrificeValue(before, after, moverBlack);
      var onlyGood = spread !== null && spread >= 12;
      brilliant = sacVal >= 1.5 && (onlyGood || winA >= 55 || (before.mate1 !== null && before.mate1 > 0));
    }

    var cls;
    if (forced) cls = 'forced';
    else if (bookName) cls = 'book';
    else if (missed) cls = 'miss';
    else if (loss >= 20) cls = 'blunder';
    else if (loss >= 10) cls = 'mistake';
    else if (loss >= 5) cls = 'inaccuracy';
    else if (brilliant) cls = 'brilliant';
    else if (isBest && spread !== null && spread >= 12) cls = 'great';
    else if (isBest) cls = 'best';
    else if (loss < 2) cls = 'excellent';
    else cls = 'good';

    return {
      cls: cls, loss: loss, winB: winB, winA: winA, spread: spread,
      isBest: isBest, sac: sacVal, bookName: bookName,
      bestUci: before.best1 || null
    };
  }

  /* ---- 评注文案 ---- */
  var CLS_INFO = {
    brilliant: { label: '妙手', icon: '!!', color: '#26C2A3' },
    great: { label: '好棋', icon: '!', color: '#3F76B5' },
    best: { label: '正招', icon: 'star', color: '#7FA650' },
    excellent: { label: '不错', icon: 'thumb', color: '#7FA650' },
    good: { label: '好', icon: 'check', color: '#7FA650' },
    book: { label: '谱着', icon: 'book', color: '#9C6B3F' },
    inaccuracy: { label: '软招', icon: '?!', color: '#E6A923' },
    mistake: { label: '错招', icon: '?', color: '#E58A2A' },
    miss: { label: '失误', icon: 'miss', color: '#E069A8' },
    blunder: { label: '败招', icon: '??', color: '#D3453B' },
    forced: { label: '被强迫', icon: 'forced', color: '#7FA650' },
    unknown: { label: '—', icon: '', color: '#888' }
  };

  function fmtPct(v) { return (v === null || v === undefined) ? '?' : Math.round(v) + '%'; }

  function moveComment(m, moveIdx) {
    var who = moveIdx % 2 === 0 ? '白方' : '黑方';
    var bestSan = m.bestSan || '';
    var t = '';
    switch (m.cls) {
      case 'forced': t = '被强迫 —— 唯一合法着法。'; break;
      case 'book': t = '谱着 · ' + (m.bookName || '开局理论') + '。'; break;
      case 'brilliant': t = '妙手！弃掉约 ' + m.sac.toFixed(1) + ' 子换取攻势/优势，引擎确认这是最佳。'; break;
      case 'great': t = '好棋！几乎是唯一的好着（次佳着法胜率要低 ' + Math.round(m.spread || 0) + '%）。'; break;
      case 'best': t = '正招，与引擎首选完全一致。'; break;
      case 'excellent': t = '不错的着法，几乎不损胜率。'; break;
      case 'good': t = '合理的着法。'; break;
      case 'inaccuracy': t = '软招 ?! 胜率 ' + fmtPct(m.winB) + ' → ' + fmtPct(m.winA) + (bestSan ? '，更好的是 ' + bestSan : '') + '。'; break;
      case 'mistake': t = '错招 ? 胜率 ' + fmtPct(m.winB) + ' → ' + fmtPct(m.winA) + (bestSan ? '，更好的是 ' + bestSan : '') + '。'; break;
      case 'miss': t = '失误（漏杀）！错失了取胜机会' + (bestSan ? '，' + bestSan + ' 可锁定胜局' : '') + '。'; break;
      case 'blunder': t = '败招 ?? 胜率 ' + fmtPct(m.winB) + ' → ' + fmtPct(m.winA) + (bestSan ? '，更好的是 ' + bestSan : '') + '。'; break;
      default: t = '（未分析）';
    }
    return who + t;
  }

  /* ---- 准确率（chess.com 近似公式） ---- */
  function accuracyOf(moves, black) {
    var sum = 0, n = 0;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var isBlackMove = (i % 2 === 1);
      if (isBlackMove !== !!black) continue;
      if (m.cls === 'forced') continue; // 被强迫不计入
      sum += m.loss;
      n++;
    }
    if (!n) return null;
    var avg = sum / n;
    var acc = 103.1668 * Math.exp(-0.04354 * avg) - 3.1669;
    return Math.max(0, Math.min(100, acc));
  }

  /* ---- 复盘流水线 ---- */
  function runReview(game, opts) {
    opts = opts || {};
    var depth = opts.depth || 16;
    var cache = opts.cache || {};

    return new Promise(function (resolve, reject) {
      var startFen = game.startFen || START_FEN;
      var ucis = game.ucis || [];
      var pos = new Position(startFen);
      var nodes = [makeNode(startFen, pos.turn, pos.genMoves(true).length)];
      var sans = [];
      var prefix = '';
      var i;
      for (i = 0; i < ucis.length; i++) {
        var mv = uciToMove(pos, ucis[i]);
        if (!mv) { reject({ error: '非法着法序列 #' + (i + 1) + ': ' + ucis[i] }); return; }
        sans.push(pos.san(mv));
        prefix = prefix ? prefix + ' ' + ucis[i] : ucis[i];
        pos.make(mv);
        var node = makeNode(pos.fen(), pos.turn, pos.genMoves(true).length);
        node.playedUci = ucis[i];
        node.playedSan = sans[sans.length - 1];
        node.prefix = prefix;
        nodes.push(node);
      }

      var movesMeta = [];
      var idx = 0;
      var total = nodes.length;

      function step() {
        if (opts.cancel && opts.cancel()) {
          finish(false);
          return;
        }
        if (idx >= total) { finish(true); return; }
        var node = nodes[idx];
        var useCache = cache[node.fen];
        if (useCache && useCache.analyzed) {
          node.bookOnline = useCache.bookOnline || null;
          fillNode(node, {
            cp1: useCache.cp1, mate1: useCache.mate1, best: useCache.best1, pv1: useCache.pv1,
            depth1: useCache.depth1, cp2: useCache.cp2, mate2: useCache.mate2,
            best2: useCache.best2, pv2: useCache.pv2, depth2: useCache.depth2
          });
          afterNode();
          return;
        }
        // 在线开局库与引擎分析并行（仅开局阶段；失败/超时自动回退本地库）
        var bookPromise = (typeof BookOnline !== 'undefined' && BookOnline.enabled && idx < BookOnline.MAX_PLY)
          ? BookOnline.get(node.fen) : Promise.resolve(null);
        Engine.analyze(node.fen, { depth: depth }).then(function (res) {
          return bookPromise.then(function (bo) {
            if (opts.cancel && opts.cancel()) { finish(false); return; }
            fillNode(node, res);
            node.bookOnline = bo;
            cache[node.fen] = node;
            afterNode();
          });
        }).catch(function (e) {
          if (e && e.stale) {
            // 被其它搜索取代：稍后重试当前节点
            setTimeout(step, 60);
            return;
          }
          node.analyzed = false;
          afterNode();
        });
      }

      function afterNode() {
        // 节点 i 完成后即可分类第 i 手（若节点 i-1 与 i 均有数据）
        var k = idx;
        if (k >= 1 && nodes[k - 1].analyzed && nodes[k].analyzed) {
          var mvIdx = k - 1;
          var c = classifyMove(nodes, mvIdx, nodes[k].prefix, sans);
          var meta = {
            uci: nodes[k].playedUci, san: nodes[k].playedSan,
            cls: c.cls, loss: c.loss, winB: c.winB, winA: c.winA,
            spread: c.spread, sac: c.sac || 0, bookName: c.bookName,
            bestUci: c.bestUci, bestSan: null
          };
          // 最佳着法 SAN
          if (c.bestUci) {
            try {
              var p2 = new Position(nodes[mvIdx].fen);
              var bm = uciToMove(p2, c.bestUci);
              meta.bestSan = bm ? p2.san(bm) : null;
            } catch (e) { meta.bestSan = null; }
          }
          meta.comment = moveComment(meta, mvIdx);
          meta.evalAfter = evalStr(nodes[k]);
          meta.evalBefore = evalStr(nodes[mvIdx]);
          movesMeta[mvIdx] = meta;
          if (opts.onMoveDone) opts.onMoveDone(mvIdx, meta);
        }
        idx++;
        if (opts.onProgress) opts.onProgress(idx, total);
        setTimeout(step, 0);
      }

      function finish(complete) {
        // 补齐未能分类的着法
        for (var j = 0; j < ucis.length; j++) {
          if (!movesMeta[j]) {
            movesMeta[j] = {
              uci: nodes[j + 1].playedUci, san: nodes[j + 1].playedSan,
              cls: 'unknown', loss: 0, winB: null, winA: null,
              bestUci: null, bestSan: null, sac: 0,
              comment: '（未完成分析）', evalAfter: '', evalBefore: ''
            };
          }
        }
        var counts = {};
        var order = ['brilliant', 'great', 'best', 'excellent', 'good', 'book',
          'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];
        for (var q = 0; q < order.length; q++) counts[order[q]] = 0;
        for (j = 0; j < movesMeta.length; j++) {
          if (counts[movesMeta[j].cls] !== undefined) counts[movesMeta[j].cls]++;
        }
        // 关键时刻（按胜率损失排序）
        var moments = movesMeta.map(function (m, jj) {
          return { idx: jj, san: m.san, cls: m.cls, loss: m.loss, winB: m.winB, winA: m.winA };
        }).filter(function (m) {
          return ['blunder', 'miss', 'mistake', 'brilliant', 'great'].indexOf(m.cls) >= 0;
        }).sort(function (a, b) { return (b.loss + (b.cls === 'brilliant' || b.cls === 'great' ? 12 : 0)) - (a.loss + (a.cls === 'brilliant' || a.cls === 'great' ? 12 : 0)); })
          .slice(0, 6);

        var review = {
          startFen: startFen,
          ucis: ucis.slice(),
          sans: sans.slice(),
          headers: game.headers || {},
          result: game.result || '*',
          nodes: nodes,
          moves: movesMeta,
          counts: counts,
          accuracyW: accuracyOf(movesMeta, false),
          accuracyB: accuracyOf(movesMeta, true),
          moments: moments,
          depth: depth,
          complete: complete
        };
        resolve(review);
      }

      step();
    });
  }

  /* ---- 导出带评注的 PGN ---- */
  var NAG_OF = { brilliant: '$3', great: '$1', inaccuracy: '$6', mistake: '$2', blunder: '$4' };

  function exportPgn(review) {
    var entries = review.moves.map(function (m) {
      return { san: m.san, nag: NAG_OF[m.cls] || null, comment: m.comment };
    });
    var headers = Object.assign({}, review.headers || {});
    headers['Event'] = headers['Event'] || '棋局评价';
    if (review.accuracyW !== null) headers['WhiteAccuracy'] = review.accuracyW.toFixed(1);
    if (review.accuracyB !== null) headers['BlackAccuracy'] = review.accuracyB.toFixed(1);
    headers['Annotator'] = 'Stockfish 棋局评价';
    return buildPgn(headers, entries, review.result);
  }

  REVIEW.winPctFromCp = winPctFromCp;
  REVIEW.nodeWinPct = nodeWinPct;
  REVIEW.evalStr = evalStr;
  REVIEW.makeNode = makeNode;
  REVIEW.fillNode = fillNode;
  REVIEW.classifyMove = classifyMove;
  REVIEW.sacrificeValue = sacrificeValue;
  REVIEW.runReview = runReview;
  REVIEW.accuracyOf = accuracyOf;
  REVIEW.moveComment = moveComment;
  REVIEW.exportPgn = exportPgn;
  REVIEW.CLS_INFO = CLS_INFO;
})();

if (typeof window !== 'undefined') window.REVIEW = REVIEW;
