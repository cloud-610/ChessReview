/* =========================================================================
 * 应用主逻辑 —— 视图切换 / 自由对弈+实时评价 / 复盘流程 / 人机对弈 / 设置
 * ========================================================================= */
'use strict';

var App = {
  view: 'board',            // board | review | settings
  pos: null,                // 当前局面（棋盘视图）
  game: null,               // { startFen, ucis[], sans[], headers, result, fenHistory[] }
  gameMeta: [],             // 棋盘视图实时评价结果 {uci,san,cls,...}
  navIdx: 0,                // 棋盘视图 = game.ucis.length；复盘视图独立
  review: null,             // 复盘结果
  reviewIdx: 0,
  reviewRunning: false,
  reviewCancel: false,
  enginePlay: null,         // { side:'w'|'b', level:1..8, busy }
  liveOn: true,
  lastNodeAnalysis: null,   // {fen, cpW/mateW...} 最近一次当前局面分析（用于实时徽章）
  settings: {},
  restored: false
};

/* ---------------- 设置 ---------------- */
var DEFAULT_SETTINGS = {
  threads: 0,          // 0=自动
  hash: 128,
  reviewDepth: 18,
  liveDepth: 13,
  liveOn: 1,
  onlineBook: 1,       // 在线开局库（lichess 开局浏览器）
  manifestUrl: 'https://example.com/chessreview/update.json'
};

function loadSettings() {
  try {
    var raw = window.Android ? window.Android.prefGet('settings') : (localStorage.getItem('settings') || '');
    App.settings = Object.assign({}, DEFAULT_SETTINGS, raw ? JSON.parse(raw) : {});
  } catch (e) { App.settings = Object.assign({}, DEFAULT_SETTINGS); }
  // v1.0.2 迁移：旧版本无 onlineBook；未自定义复盘深度时提升到 18
  var migrated = false;
  if (App.settings.onlineBook === undefined) { App.settings.onlineBook = 1; migrated = true; }
  if (migrated && (App.settings.reviewDepth === 16 || App.settings.reviewDepth === undefined)) {
    App.settings.reviewDepth = 18;
  }
  if (migrated) saveSettings();
}
function saveSettings() {
  var raw = JSON.stringify(App.settings);
  try {
    if (window.Android) window.Android.prefSet('settings', raw);
    else localStorage.setItem('settings', raw);
  } catch (e) {}
}

/* ---------------- 对局管理 ---------------- */
function newGame(fen) {
  App.pos = new Position(fen || START_FEN);
  App.game = {
    startFen: App.pos.fen(),
    ucis: [], sans: [], headers: {},
    result: '*',
    fenHistory: [App.pos.positionKey()]
  };
  App.gameMeta = [];
  App.lastNodeAnalysis = null;
  App.enginePlay = null;
  App.navIdx = 0;
  resetLiveState();
  if (App.review) { App.review = null; }
  refreshBoardView();
  autoSave();
}

function gameToStart() {
  App.pos = new Position(App.game.startFen);
  App.game.ucis = []; App.game.sans = []; App.game.fenHistory = [App.pos.positionKey()];
  App.gameMeta = [];
  App.navIdx = 0;
  App._badgeQueue = [];
  refreshBoardView();
  autoSave();
}

function replayTo(idx) {
  // 回到第 idx 手后局面（idx = 已走着法数）
  var pos = new Position(App.game.startFen);
  for (var i = 0; i < idx; i++) {
    var mv = uciToMove(pos, App.game.ucis[i]);
    if (!mv) break;
    pos.make(mv);
  }
  App.pos = pos;
  App.navIdx = idx;
}

function applyMove(mv) {
  var before = App.pos;
  // 从历史局面走子：截断其后着法，从当前局面分叉新变化（v1.0.3）
  if (App.navIdx != null && App.game && App.game.ucis.length > App.navIdx) {
    App.game.ucis = App.game.ucis.slice(0, App.navIdx);
    App.game.sans = App.game.sans.slice(0, App.navIdx);
    App.gameMeta = App.gameMeta.slice(0, App.navIdx);
    App.game.fenHistory = App.game.fenHistory.slice(0, App.navIdx + 1);
    App._badgeQueue = App._badgeQueue.filter(function (b) { return b.idx < App.navIdx; });
    try { UI.toast('已截断后续着法，从第 ' + (App.navIdx + 1) + ' 手分叉新变化'); } catch (e) {}
  }
  var fenBefore = before.fen();
  var uci = moveToUci(mv);
  var san = before.san(mv);
  var moveIdx = App.game.ucis.length;
  var moverWasEngine = App.enginePlay && (App.enginePlay.side === before.turn);
  before.make(mv);
  App.game.ucis.push(uci);
  App.game.sans.push(san);
  App.game.fenHistory.push(before.positionKey());
  var meta = { uci: uci, san: san, cls: null };
  App.gameMeta.push(meta);
  App.navIdx = App.game.ucis.length;

  // 终局检测
  var status = gameStatus(before, App.game.fenHistory);
  if (status) App.game.result = status.result;

  // 界面
  UI.renderBoard(before.fen(), { lastMove: { from: mv.from, to: mv.to } });
  renderBoardMoveList();
  updateTurnTag(status);
  autoSave();

  // 实时评价：入徽章队列，的后续由 livePump 补齐前后节点分析
  if (App.liveOn) {
    App._badgeQueue.push({ fenBefore: fenBefore, fenAfter: before.fen(), meta: meta, idx: moveIdx });
    livePump();
  }
  // 人机对弈：轮到引擎
  if (App.enginePlay && !status && App.enginePlay.side === before.turn) {
    engineMove();
  }
  if (status && !moverWasEngine) {
    var msg = {
      checkmate: (before.turn === 'w' ? '黑方' : '白方') + '将杀获胜！',
      stalemate: '逼和，和棋。',
      material: '子力不足，和棋。',
      threefold: '三次重复局面，和棋。',
      fifty: '五十步规则，和棋。'
    }[status.type];
    UI.toast(msg);
  }
}

function gameStatus(pos, fenHistory) {
  var legal = pos.genMoves(true);
  if (!legal.length) {
    if (pos.inCheck()) return { type: 'checkmate', result: pos.turn === 'w' ? '0-1' : '1-0' };
    return { type: 'stalemate', result: '1/2-1/2' };
  }
  if (pos.insufficientMaterial()) return { type: 'material', result: '1/2-1/2' };
  if (pos.half >= 100) return { type: 'fifty', result: '1/2-1/2' };
  if (pos.threefold(fenHistory || [])) return { type: 'threefold', result: '1/2-1/2' };
  return null;
}

function undoMove() {
  if (!App.game.ucis.length) return;
  var n = 1;
  // 人机对弈时撤两步（对方+自己）
  if (App.enginePlay && App.game.ucis.length >= 2) {
    var lastMover = (App.game.ucis.length % 2 === 1) ? 'w' : 'b';
    var starter = new Position(App.game.startFen).turn;
    // 简化：撤 2 步（若剩 ≥2）
    if (App.game.ucis.length >= 2) n = 2;
  }
  App.game.ucis = App.game.ucis.slice(0, App.game.ucis.length - n);
  App.game.sans = App.game.sans.slice(0, App.game.sans.length - n);
  App.gameMeta = App.gameMeta.slice(0, App.gameMeta.length - n);
  App._badgeQueue = App._badgeQueue.filter(function (b) { return b.idx < App.game.ucis.length; });
  replayTo(App.game.ucis.length);
  App.game.result = '*';
  refreshBoardView();
  autoSave();
  if (App.liveOn) scheduleLive();
}

/* ---------------- 实时评价（队列驱动） ----------------
 * 每个走过的局面进入节点缓存；徽章在其前后局面都分析完后即时结算。
 * 引擎命令严格串行，即使连续快速走子也不会丢失中间局面。 */
App._nodeCache = {};
App._badgeQueue = [];
var liveBusy = false;

function resetLiveState() {
  App._nodeCache = {};
  App._badgeQueue = [];
  liveBusy = false;
  App.lastNodeAnalysis = null;
}

function classifyPair(nb, na, meta, moveIdx) {
  try {
    var nodesArr = [nb, na];
    var prefix = App.game.ucis.slice(0, moveIdx + 1).join(' ');
    var c = REVIEW.classifyMove(nodesArr, 0, prefix, null);
    meta.cls = c.cls; meta.loss = c.loss; meta.winB = c.winB; meta.winA = c.winA;
    meta.spread = c.spread; meta.sac = c.sac || 0; meta.bookName = c.bookName;
    meta.bestUci = c.bestUci;
    if (c.bestUci) {
      try {
        var p2 = new Position(nb.fen);
        var bm = uciToMove(p2, c.bestUci);
        meta.bestSan = bm ? p2.san(bm) : null;
      } catch (e) { meta.bestSan = null; }
    }
    meta.comment = REVIEW.moveComment(meta, moveIdx);
    meta.evalAfter = REVIEW.evalStr(na);
  } catch (e) { /* 分类异常不影响主流程 */ }
}

function processBadges() {
  // 保留全部条目：在线开局库异步到达后可重新结算（谱着补判）
  for (var i = 0; i < App._badgeQueue.length; i++) {
    var b = App._badgeQueue[i];
    var nb = App._nodeCache[b.fenBefore];
    var na = App._nodeCache[b.fenAfter];
    if (nb && nb.analyzed && na && na.analyzed) {
      classifyPair(nb, na, b.meta, b.idx);
    }
  }
}

/* 在线开局库附加（实时对弈的谱着判定；复盘流程在 review.js 内并行查询） */
function attachOnlineBook(node, fen) {
  if (typeof BookOnline === 'undefined' || !BookOnline.enabled) return;
  if (!App.game || App.game.ucis.length > BookOnline.MAX_PLY) return;
  BookOnline.get(fen).then(function (bo) {
    if (bo && bo.moves && bo.moves.length) {
      node.bookOnline = bo;
      processBadges();
      renderBoardMoveList();
    }
  });
}

function renderLiveNode(node) {
  var pct = REVIEW.nodeWinPct(node);
  UI.renderEvalBar(pct, REVIEW.evalStr(node), false);
  UI.setEngineStatus(Engine.name + ' · 深度 ' + (node.depth1 || 0), false);
  UI.clearArrows();
  if (node.best1 && App.pos) {
    var m = uciToMove(App.pos, node.best1);
    if (m) UI.addArrow(m.from, m.to, 'rgba(106,168,79,0.85)');
  }
}

function livePump() {
  if (!App.liveOn || liveBusy || !App.pos || !Engine.ready) return;
  // 引擎执子期间不占用引擎算力（其看棋期间也不展示实时评价）
  if (App.enginePlay && App.pos.turn === App.enginePlay.side) return;
  var curFen = App.pos.fen();
  var target = null;
  var cn = App._nodeCache[curFen];
  if (!cn || !cn.analyzed) {
    target = curFen;
  } else {
    for (var i = 0; i < App._badgeQueue.length; i++) {
      var b = App._badgeQueue[i];
      var nb = App._nodeCache[b.fenBefore], na = App._nodeCache[b.fenAfter];
      if (nb && nb.analyzed && na && na.analyzed) continue;
      target = (nb && nb.analyzed) ? b.fenAfter : b.fenBefore;
      break;
    }
  }
  if (!target) {
    // 当前局面已分析且无缺口：直接渲染
    if (cn && cn.analyzed && cn.fen === curFen) renderLiveNode(cn);
    return;
  }
  liveBusy = true;
  if (target === curFen) UI.renderEvalBar(null, '', true);
  Engine.analyze(target, { depth: App.settings.liveDepth }).then(function (res) {
    liveBusy = false;
    if (res) {
      var node = REVIEW.makeNode(target, new Position(target).turn, 0);
      REVIEW.fillNode(node, res);
      App._nodeCache[target] = node;
      App.lastNodeAnalysis = node;
      if (App.pos && target === App.pos.fen()) renderLiveNode(node);
      processBadges();
      renderBoardMoveList();
      attachOnlineBook(node, target);
    }
    setTimeout(livePump, 30);
  }).catch(function () {
    liveBusy = false;
    setTimeout(livePump, 60);
  });
}

function scheduleLive() { livePump(); }

/* 渐进深度实时刷新（info 行到达时） */
Engine._onInfo = function (parsed, fen) {
  if (!App.pos || fen !== App.pos.fen()) return;
  if (App.view !== 'board' && App.view !== 'review') return;
  var white = App.pos.turn === 'w';
  var cpW = parsed.cp !== null ? (white ? parsed.cp : -parsed.cp) : null;
  var mateW = parsed.mate !== null ? (white ? parsed.mate : -parsed.mate) : null;
  var node = { cpW: cpW, mateW: mateW };
  var pct = REVIEW.nodeWinPct(node);
  if (pct !== null) UI.renderEvalBar(pct, REVIEW.evalStr(node), true);
  UI.setEngineStatus(Engine.name + ' · 深度 ' + parsed.depth, true);
};

/* ---------------- 人机对弈 ---------------- */
var ENGINE_LEVELS = [
  { skill: 0, mt: 200, name: '入门' },
  { skill: 3, mt: 250, name: '新手' },
  { skill: 6, mt: 350, name: '业余' },
  { skill: 9, mt: 500, name: ' club', name2: '俱乐部' },
  { skill: 12, mt: 700, name: '进阶' },
  { skill: 15, mt: 1000, name: '高手' },
  { skill: 18, mt: 1400, name: '大师' },
  { skill: 20, mt: 2000, name: '宗师' }
];

function engineMove() {
  if (!App.enginePlay || App.reviewRunning) return;
  var side = App.enginePlay.side;
  if (App.pos.turn !== side) return;
  App.enginePlay.busy = true;
  var lv = ENGINE_LEVELS[App.enginePlay.level - 1] || ENGINE_LEVELS[3];
  Engine.setOption('Skill Level', lv.skill);
  UI.setEngineStatus(Engine.name + ' · 思考中…', true);
  var fen = App.pos.fen();
  Engine.playMove(fen, { movetime: lv.mt }).then(function (res) {
    App.enginePlay.busy = false;
    Engine.setOption('Skill Level', 20);
    if (!res || !res.best || !App.pos || fen !== App.pos.fen()) return;
    var mv = uciToMove(App.pos, res.best);
    if (mv) {
      Engine._onInfo = App._origOnInfo || Engine._onInfo;
      applyMove(mv);
    }
  }).catch(function () { App.enginePlay.busy = false; });
}

/* ---------------- 棋盘视图渲染 ---------------- */
function refreshBoardView() {
  if (!App.pos) return;
  var last = null;
  var navN = (App.navIdx != null) ? App.navIdx : App.game.ucis.length;
  if (navN > 0 && App.game.ucis.length >= navN) {
    var lastUci = App.game.ucis[navN - 1];
    if (lastUci) last = { from: nameToSq(lastUci.slice(0, 2)), to: nameToSq(lastUci.slice(2, 4)) };
  }
  UI.renderBoard(App.pos.fen(), { lastMove: last });
  updateBoardBadge();
  renderBoardMoveList();
  updateTurnTag();
  if (App.lastNodeAnalysis && App.lastNodeAnalysis.fen === App.pos.fen()) {
    UI.renderEvalBar(REVIEW.nodeWinPct(App.lastNodeAnalysis), REVIEW.evalStr(App.lastNodeAnalysis), false);
  } else {
    scheduleLive();
  }
}

function renderBoardMoveList() {
  var container = document.getElementById('boardMoves');
  if (!container) return;
  var moves = App.gameMeta.map(function (m) {
    return { san: m.san, cls: m.cls };
  });
  var cur = (App.navIdx != null ? App.navIdx : moves.length) - 1;
  UI.renderMoveList(container, moves, cur, function (j) {
    // 棋盘视图点着法：跳回该局面
    replayTo(j + 1);
    refreshBoardView();
  });
  updateBoardBadge();
}

/* 棋盘小徽章：当前所看那一手的评价，显示在落子格右上角（原有着法列表徽章保持不变） */
function updateBoardBadge() {
  if (App.view !== 'board') return;
  var n = (App.navIdx != null) ? App.navIdx : (App.game ? App.game.ucis.length : 0);
  var meta = (App.gameMeta && n > 0) ? App.gameMeta[n - 1] : null;
  if (meta && meta.cls && meta.cls !== 'unknown' && meta.uci) {
    UI.setBoardBadge(nameToSq(meta.uci.slice(2, 4)), meta.cls);
  } else {
    UI.setBoardBadge(null);
  }
}

/* 棋盘视图步进导航（v1.0.3）：⏮ ◀ ▶ ⏭ 按钮与着法列表点击共用 */
function gotoBoardPly(n) {
  if (!App.game) return;
  var max = App.game.ucis.length;
  n = Math.max(0, Math.min(max, n));
  if (n === App.navIdx && App.pos) { refreshBoardView(); return; }
  replayTo(n);
  refreshBoardView();
}

function updateTurnTag(status) {
  var tag = document.getElementById('turnTag');
  if (!tag) return;
  status = status || gameStatus(App.pos, App.game.fenHistory);
  if (status) {
    var map = { checkmate: '将杀 · ' + App.game.result, stalemate: '逼和', material: '子和', threefold: '三次重复', fifty: '五十步和' };
    tag.textContent = map[status.type] || '对局结束';
  } else {
    var who = App.pos.turn === 'w' ? '白方行棋' : '黑方行棋';
    if (App.enginePlay) {
      if (App.pos.turn === App.enginePlay.side) who += '（引擎执子）';
    }
    tag.textContent = who;
  }
}

/* ---------------- 视图切换 ---------------- */
function switchView(v) {
  try {
    App.view = v;
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === v);
    });
    document.querySelectorAll('.view').forEach(function (s) {
      s.classList.toggle('active', s.id === 'view-' + v);
    });
    // 棋盘在棋盘视图与复盘视图间共享
    var area = document.getElementById('boardArea');
    if (v === 'review') {
      var slot = document.getElementById('reviewBoardSlot');
      if (slot && area.parentElement.id !== 'reviewBoardSlot') slot.appendChild(area);
      renderReviewView();
    } else {
      var slot2 = document.getElementById('boardSlot');
      if (slot2 && area.parentElement.id !== 'boardSlot') slot2.appendChild(area);
      refreshBoardView();
    }
    if (v === 'settings') renderSettingsView();
  } catch (e) {
    try { UI.toast('打开页面出错：' + (e && e.message), false); } catch (e2) {}
  }
}

/* ---------------- 复盘流程 ---------------- */
function startReview(gameData, depth) {
  if (App.reviewRunning) return;
  App.reviewRunning = true;
  App.reviewCancel = false;
  App.review = null;
  // 复盘期间挂起实时评价，避免与流水线争抢引擎
  App._liveSuspended = App.liveOn;
  App.liveOn = false;
  Engine.send('stop');
  var prog = document.getElementById('reviewProgress');
  var bar = document.getElementById('reviewProgressBar');
  var txt = document.getElementById('reviewProgressText');
  var runBox = document.getElementById('reviewRun');
  runBox.classList.remove('hidden');
  document.getElementById('reviewIntro').classList.add('hidden');
  document.getElementById('reviewDash').classList.add('hidden');
  bar.style.width = '0%';
  txt.textContent = '正在启动引擎分析…';

  var cache = {};
  if (typeof BookOnline !== 'undefined') BookOnline.enabled = App.settings.onlineBook !== 0;
  REVIEW.runReview(gameData, {
    depth: depth || App.settings.reviewDepth,
    cache: cache,
    onProgress: function (done, total) {
      bar.style.width = Math.round(done / total * 100) + '%';
      txt.textContent = '分析中 ' + done + ' / ' + total + ' 个局面（深度 ' + (depth || App.settings.reviewDepth) + '）';
      // 渐进更新着法列表
      if (App.review) renderReviewMoveList();
    },
    onMoveDone: function (idx, meta) {
      if (!App.review) App.review = { moves: [] };
      App.review.moves[idx] = meta;
      renderReviewMoveList();
    },
    cancel: function () { return App.reviewCancel; }
  }).then(function (review) {
    App.reviewRunning = false;
    App.review = review;
    App.reviewIdx = review.nodes.length - 1;
    App.liveOn = App._liveSuspended !== false;
    runBox.classList.add('hidden');
    // 载入复盘对局到棋盘
    App.game = {
      startFen: review.startFen,
      ucis: review.ucis.slice(), sans: review.sans.slice(),
      headers: review.headers || {}, result: review.result,
      fenHistory: []
    };
    replayTo(review.ucis.length);
    App.pos = new Position(review.nodes[review.nodes.length - 1].fen);
    App.gameMeta = review.moves.map(function (m) { return Object.assign({}, m); });
    renderReviewView();
    UI.toast(review.complete ? '复盘完成！' : '复盘已中止（部分结果）');
    autoSave();
  }).catch(function (e) {
    App.reviewRunning = false;
    App.liveOn = App._liveSuspended !== false;
    runBox.classList.add('hidden');
    UI.toast('复盘失败：' + ((e && e.error) || '未知错误'), false);
  });
}

function renderReviewView() {
  var intro = document.getElementById('reviewIntro');
  var runBox = document.getElementById('reviewRun');
  var dash = document.getElementById('reviewDash');
  var body = document.getElementById('reviewBody');
  if (App.reviewRunning) {
    intro.classList.add('hidden'); dash.classList.add('hidden'); body.classList.add('hidden');
    runBox.classList.remove('hidden');
    renderReviewMoveList();
    return;
  }
  runBox.classList.add('hidden');
  if (!App.review) {
    intro.classList.remove('hidden');
    dash.classList.add('hidden');
    body.classList.add('hidden');
    var cur = document.getElementById('btnReviewCurrent');
    if (cur && App.game && App.game.ucis.length) cur.classList.remove('hidden');
    else if (cur) cur.classList.add('hidden');
    return;
  }
  intro.classList.add('hidden');
  dash.classList.remove('hidden');
  body.classList.remove('hidden');
  UI.renderDashboard(App.review, document.getElementById('reviewDash'));
  renderReviewMoveList();
  drawReviewGraph();
  renderReviewPosition();
}

function renderReviewMoveList() {
  var list = document.getElementById('reviewMoves2');
  if (!list) return;
  if (!App.review || !App.review.moves || !App.review.moves.length) {
    list.innerHTML = '<div class="moves-empty">分析中…</div>';
    return;
  }
  var moves = App.review.moves;
  UI.renderMoveList(list, moves, App.reviewIdx - 1 < 0 ? -1 : App.reviewIdx - 1, function (j) {
    gotoReviewPly(j + 1);
  });
}

function drawReviewGraph() {
  if (!App.review) return;
  UI.drawGraph(document.getElementById('graph'), App.review.nodes, App.reviewIdx);
}

function gotoReviewPly(ply) {
  if (!App.review) return;
  App.reviewIdx = Math.max(0, Math.min(App.review.nodes.length - 1, ply));
  renderReviewPosition();
}

function renderReviewPosition() {
  var r = App.review;
  if (!r) return;
  var node = r.nodes[App.reviewIdx];
  if (!node) return;
  var last = null, badge = null;
  if (App.reviewIdx > 0) {
    var prevUci = r.ucis[App.reviewIdx - 1];
    last = { from: nameToSq(prevUci.slice(0, 2)), to: nameToSq(prevUci.slice(2, 4)) };
    var pm = r.moves[App.reviewIdx - 1];
    if (pm && pm.cls && pm.cls !== 'unknown') {
      badge = { sq: nameToSq(prevUci.slice(2, 4)), cls: pm.cls };
    }
  }
  UI.renderBoard(node.fen, { lastMove: last, badge: badge });
  // 评估条：该局面引擎评估
  var pct = REVIEW.nodeWinPct(node);
  UI.renderEvalBar(pct, node.analyzed ? REVIEW.evalStr(node) : '', false);
  // 箭头：本局面最佳着法；若上一步非最佳且有明显更优，红箭头标出实际着法
  UI.clearArrows();
  if (node.analyzed && node.best1) {
    try {
      var p = new Position(node.fen);
      var m = uciToMove(p, node.best1);
      if (m) UI.addArrow(m.from, m.to, 'rgba(106,168,79,0.85)');
    } catch (e) {}
  }
  if (App.reviewIdx > 0) {
    var mv = r.moves[App.reviewIdx - 1];
    if (mv && ['blunder', 'miss', 'mistake'].indexOf(mv.cls) >= 0 && mv.uci) {
      var f = nameToSq(mv.uci.slice(0, 2)), t = nameToSq(mv.uci.slice(2, 4));
      UI.addArrow(f, t, 'rgba(211,69,59,0.75)');
    }
  }
  renderReviewMoveList();
  drawReviewGraph();
  var cmt = document.getElementById('reviewComment');
  if (cmt) UI.renderComment(r, App.reviewIdx, cmt);
  var evalTag = document.getElementById('reviewEvalTag');
  if (evalTag) {
    var e = REVIEW.evalStr(node);
    evalTag.textContent = node.analyzed ? (e || '0.0') + '（深度' + (node.depth1 || 0) + '）' : '—';
  }
}

/* ---------------- PGN 导入导出 ---------------- */
function importPgnText(text) {
  var parsed = parsePgn(text);
  if (parsed.error) {
    UI.toast('导入失败：' + parsed.error, false);
    return null;
  }
  if (!parsed.ucis.length) {
    UI.toast('未解析到任何着法', false);
    return null;
  }
  return {
    startFen: parsed.startFen,
    ucis: parsed.ucis, sans: parsed.sans,
    headers: parsed.headers, result: parsed.result
  };
}

function exportCurrentPgn() {
  if (!App.game || !App.game.ucis.length) { UI.toast('当前没有对局', false); return; }
  var entries;
  var result = App.game.result || '*';
  if (App.review && App.review.moves && App.review.moves.length === App.game.ucis.length) {
    entries = App.review.moves.map(function (m) {
      return { san: m.san, nag: { brilliant: '$3', great: '$1', inaccuracy: '$6', mistake: '$2', blunder: '$4' }[m.cls] || null, comment: m.comment };
    });
    return REVIEW.exportPgn(App.review);
  }
  entries = App.game.sans.map(function (s) { return { san: s }; });
  return buildPgn(App.game.headers, entries, result);
}

/* ---------------- 自动保存 ---------------- */
function autoSave() {
  if (!App.game) return;
  try {
    var data = {
      startFen: App.game.startFen, ucis: App.game.ucis, sans: App.game.sans,
      headers: App.game.headers, result: App.game.result
    };
    var raw = JSON.stringify(data);
    if (window.Android) window.Android.prefSet('gamePgn', raw);
    else localStorage.setItem('gamePgn', raw);
  } catch (e) {}
}

function restoreGame() {
  try {
    var raw = window.Android ? window.Android.prefGet('gamePgn') : localStorage.getItem('gamePgn');
    if (!raw) return false;
    var data = JSON.parse(raw);
    if (!data || !data.ucis || !data.ucis.length) return false;
    var pos = new Position(data.startFen || START_FEN);
    for (var i = 0; i < data.ucis.length; i++) {
      var mv = uciToMove(pos, data.ucis[i]);
      if (!mv) return false;
      pos.make(mv);
    }
    App.game = {
      startFen: data.startFen || START_FEN,
      ucis: data.ucis, sans: data.sans || [], headers: data.headers || {},
      result: data.result || '*', fenHistory: []
    };
    App.pos = pos;
    App.navIdx = data.ucis.length;
    App.gameMeta = App.game.sans.map(function (s) { return { san: s, cls: null }; });
    return true;
  } catch (e) { return false; }
}

/* ---------------- 设置视图（v1.0.3：静态 HTML，见 index.html；此处只同步数值） ----------------
 * 根治「设置无法打开」：页面骨架不再由 JS 动态生成，任何一步同步失败都不影响设置页显示；
 * 事件在 boot 时一次性绑定（bindSettingsEvents），不再每次打开重建。 */
function renderSettingsView() {
  try { syncSettingsView(); } catch (e) {
    try { UI.toast('设置同步出错：' + (e && e.message), false); } catch (e2) {}
  }
}

function syncSettingsView() {
  var s = App.settings;
  function setVal(id, v) {
    try { var e = document.getElementById(id); if (e) e.value = String(v); } catch (e2) {}
  }
  setVal('setLive', s.liveOn ? '1' : '0');
  setVal('setOnlineBook', s.onlineBook === 0 ? '0' : '1');
  setVal('setLiveDepth', s.liveDepth);
  setVal('setReviewDepth', s.reviewDepth);
  setVal('setHash', s.hash);
  try { var mu = document.getElementById('manifestUrl'); if (mu) mu.value = s.manifestUrl || ''; } catch (e) {}
  try {
    var ver = document.getElementById('setVersion');
    if (ver) ver.textContent = window.Android ? ('v' + window.Android.appVersion()) : 'v1.0.3（浏览器测试）';
  } catch (e) {}
  renderModelsList();
  try { renderDiag(); } catch (e) {}
}

/* 诊断信息：WebView 版本 / 引擎状态 / 近期脚本错误（配合 boot 的错误记录） */
function renderDiag() {
  var el = document.getElementById('diagBody');
  if (!el) return;
  var lines = [];
  try { lines.push('WebView: ' + navigator.userAgent.slice(0, 72)); } catch (e) {}
  try {
    if (window.Android) lines.push('Android SDK: ' + window.Android.androidSdk() + ' · 架构: ' + window.Android.abiList());
  } catch (e) {}
  try { lines.push('引擎: ' + (Engine && Engine.name ? Engine.name : '未就绪')); } catch (e) {}
  var errs = window.__ERRS || [];
  lines.push('脚本错误: ' + errs.length + ' 次');
  for (var i = Math.max(0, errs.length - 5); i < errs.length; i++) {
    lines.push('· ' + String(errs[i]).slice(0, 110));
  }
  el.textContent = lines.join('\n');
  el.style.whiteSpace = 'pre-wrap';
  el.style.fontFamily = 'monospace';
  el.style.fontSize = '11px';
}

/* 设置事件：静态元素只绑定一次 */
function bindSettingsEvents() {
  if (App._settingsBound) return;
  App._settingsBound = true;
  var get = function (id) { return document.getElementById(id); };
  var live = get('setLive');
  if (live) live.addEventListener('change', function () {
    App.settings.liveOn = this.value === '1';
    App.liveOn = !!App.settings.liveOn;
    saveSettings();
    if (App.liveOn) scheduleLive(); else UI.renderEvalBar(null, '', false);
  });
  var ob = get('setOnlineBook');
  if (ob) ob.addEventListener('change', function () {
    App.settings.onlineBook = this.value === '1' ? 1 : 0;
    saveSettings();
    if (typeof BookOnline !== 'undefined') BookOnline.enabled = App.settings.onlineBook !== 0;
  });
  var ld = get('setLiveDepth');
  if (ld) ld.addEventListener('change', function () { App.settings.liveDepth = +this.value; saveSettings(); });
  var rd = get('setReviewDepth');
  if (rd) rd.addEventListener('change', function () { App.settings.reviewDepth = +this.value; saveSettings(); });
  var hs = get('setHash');
  if (hs) hs.addEventListener('change', function () {
    App.settings.hash = +this.value; saveSettings();
    Engine.setOption('Hash', this.value);
  });
  var md = get('btnModelDownload');
  if (md) md.addEventListener('click', function () {
    var iu = get('modelUrl');
    var u = (iu ? iu.value : '').trim();
    if (!/^https?:\/\//.test(u)) { UI.toast('请输入有效的模型 URL', false); return; }
    var name = u.split('/').pop().split('?')[0] || 'custom.nnue';
    if (!/\.nnue$/.test(name)) name += '.nnue';
    downloadModel(u, name, null);
  });
  var uc = get('btnUpdateCheck');
  if (uc) uc.addEventListener('click', function () {
    var mu = get('manifestUrl');
    var u = (mu ? mu.value : '').trim();
    if (!/^https?:\/\//.test(u)) { UI.toast('请输入有效的清单 URL', false); return; }
    App.settings.manifestUrl = u; saveSettings();
    var r = get('updateResult');
    if (r) r.textContent = '检查中…';
    if (window.Android) window.Android.checkUpdate(u);
    else if (r) r.textContent = '（浏览器测试模式：更新功能需要 Android 环境）';
  });
  var ui2 = get('btnUpdateInstall');
  if (ui2) ui2.addEventListener('click', function () {
    var au = get('apkUrl');
    var u = (au ? au.value : '').trim();
    if (!/^https?:\/\//.test(u)) { UI.toast('请输入有效的 APK URL', false); return; }
    if (window.Android) window.Android.installFromUrl(u);
    else UI.toast('浏览器测试模式不支持安装', false);
  });
  var gpl = get('btnGpl');
  if (gpl) gpl.addEventListener('click', function () {
    if (window.Android) window.Android.openUrl('https://stockfishchess.org/');
    else window.open('https://stockfishchess.org/');
  });
}

/* ---------------- 模型管理 ---------------- */
function renderModelsList() {
  var body = document.getElementById('modelsBody');
  if (!body) return;
  if (window.Android) {
    try {
      var list = JSON.parse(window.Android.modelsList());
      var html = list.map(function (m) {
        return '<div class="model-row' + (m.active ? ' active' : '') + '">' +
          '<span class="model-name">' + esc(m.name) + '</span>' +
          '<span class="model-size">' + (m.size / 1048576).toFixed(1) + ' MB</span>' +
          (m.active ? '<span class="model-tag">使用中</span>' : '') +
          '</div>';
      }).join('');
      body.innerHTML = html || '<div class="set-note">暂无本地模型</div>';
    } catch (e) { body.innerHTML = '<div class="set-note">读取失败</div>'; }
  } else {
    body.innerHTML = '<div class="set-note">浏览器测试模式：模型管理需要 Android 环境（内置 Mock 模型 nn-mock.nnue）</div>';
  }
}

var activeDownloads = {};
function downloadModel(url, name, sha256) {
  if (window.Android) {
    var id = window.Android.download(url, name, sha256 || null);
    activeDownloads[id] = { name: name };
    UI.toast('开始下载 ' + name);
    renderDownloadProgress();
  } else {
    UI.toast('浏览器测试模式：已模拟下载 ' + name);
  }
}

function renderDownloadProgress() {
  var body = document.getElementById('modelsBody');
  if (!body || !window.Android) return;
  var ids = Object.keys(activeDownloads);
  if (!ids.length) return;
  var html = ids.map(function (id) {
    var d = activeDownloads[id];
    return '<div class="dl-row" data-id="' + id + '"><span>' + esc(d.name) + '</span>' +
      '<div class="dl-bar"><div class="dl-fill" style="width:' + (d.pct || 0) + '%"></div></div>' +
      '<span class="dl-pct">' + (d.pct || 0) + '%</span></div>';
  }).join('');
  var ex = body.querySelector('.dl-wrap');
  if (ex) ex.remove();
  var wrap = document.createElement('div');
  wrap.className = 'dl-wrap';
  wrap.innerHTML = html;
  body.appendChild(wrap);
}

window.Bridge = window.Bridge || {};
window.Bridge.downloadProgress = function (id, done, total) {
  var d = activeDownloads[id];
  if (!d) return;
  d.pct = total > 0 ? Math.round(done / total * 100) : 0;
  renderDownloadProgress();
};
window.Bridge.downloadDone = function (id, ok, msg) {
  var d = activeDownloads[id];
  if (!d) return;
  delete activeDownloads[id];
  renderDownloadProgress();
  if (ok) {
    UI.toast('模型下载完成：' + d.name);
    if (window.Android && confirm2('是否立即切换到该模型？', function () {
      window.Android.modelActivate(d.name);
      UI.toast('已切换模型：' + d.name);
    })) {}
  } else {
    UI.toast('下载失败：' + msg, false);
  }
  renderModelsList();
};

function confirm2(msg, onYes) {
  // 简易确认框
  var dlg = document.getElementById('dlgConfirm');
  var text = document.getElementById('confirmText');
  var yes = document.getElementById('confirmYes'), no = document.getElementById('confirmNo');
  text.textContent = msg;
  UI.showDialog('dlgConfirm');
  var handler = function () { cleanup(); onYes(); };
  var cleanup = function () {
    yes.removeEventListener('click', handler);
    UI.hideDialog('dlgConfirm');
  };
  yes.addEventListener('click', handler);
  no.addEventListener('click', cleanup);
  return false;
}

window.Bridge.updateInfo = function (json) {
  var el = document.getElementById('updateResult');
  if (!el) return;
  try {
    var info = typeof json === 'string' ? JSON.parse(json) : json;
    if (!info.ok) { el.textContent = '检查失败：' + (info.error || '网络错误'); return; }
    if (!info.hasUpdate) {
      el.textContent = '已是最新版本 v' + info.currentVersion + '。';
    } else {
      el.innerHTML = '发现新版本 <b>v' + esc(info.versionName) + '</b>' +
        (info.notes ? '<div class="set-note">' + esc(info.notes) + '</div>' : '') +
        '<button class="btn small" id="btnDoUpdate">下载并安装</button>';
      var btn = el.querySelector('#btnDoUpdate');
      btn.addEventListener('click', function () {
        if (window.Android) window.Android.installFromUrl(info.apkUrl);
      });
    }
  } catch (e) { el.textContent = '解析更新信息失败'; }
};
window.Bridge.needInstallPermission = function () {
  confirm2('Android 8+ 需要允许“安装未知应用”权限才能安装更新。去设置？', function () {
    if (window.Android) window.Android.openInstallPermissionSettings();
  });
};
window.Bridge.pgnLoaded = function (text, err) {
  if (err) { UI.toast('读取文件失败：' + err, false); return; }
  if (!text) return;
  var ta = document.getElementById('pgnText');
  if (ta) ta.value = text;
  UI.toast('已载入 PGN 文件');
};
window.Bridge.pgnSaved = function (ok, name) {
  UI.toast(ok ? '已保存' + (name ? '：' + name : '') : '保存失败', ok);
};
window.Bridge.pgnShared = function (text) {
  var ta = document.getElementById('pgnText');
  if (ta && text) ta.value = text;
  UI.showDialog('dlgPgn');
};

/* ---------------- 启动 ---------------- */
function boot() {
  // 全局错误记录 + 提示（真机排查：设置页「诊断信息」可见最近错误）
  window.__ERRS = [];
  window.addEventListener('error', function (ev) {
    var msg = ev && ev.message ? String(ev.message) : '';
    if (!msg) return;
    window.__ERRS.push(msg);
    if (window.__ERRS.length > 20) window.__ERRS.shift();
    try { UI.toast('脚本错误：' + msg, false); } catch (e) {}
  });
  loadSettings();
  App.liveOn = !!App.settings.liveOn;
  if (typeof BookOnline !== 'undefined') BookOnline.enabled = App.settings.onlineBook !== 0;
  Engine.init();

  // 控制器
  var controller = {
    getPosition: function () { return App.pos; },
    canMoveFrom: function (sq) {
      if (!App.pos) return false;
      if (App.enginePlay && App.pos.turn === App.enginePlay.side) return false;
      var p = App.pos.board[sq];
      if (!p) return false;
      return ((p & 8) !== 0) === (App.pos.turn === 'b');
    },
    requestMove: function (from, to, promo) {
      if (!App.pos) return;
      var moves = App.pos.genMoves(true).filter(function (m) { return m.from === from && m.to === to; });
      if (!moves.length) return;
      var mv = moves[0];
      if (promo) {
        var pm = moves.filter(function (m) { return m.promo === promo; })[0];
        if (pm) mv = pm;
      }
      applyMove(mv);
    },
    onGraphTap: function (x) {
      if (!App.review || !App.review.nodes.length) return;
      var n = App.review.nodes.length;
      var ply = Math.round(x * (n - 1));
      gotoReviewPly(ply);
    },
    onMomentPick: function (idx) {
      gotoReviewPly(idx + 1);
    }
  };
  UI.init(controller);
  App._origOnInfo = Engine._onInfo;
  // 引擎就绪后启动实时分析
  var origReady = UI.onEngineReady.bind(UI);
  UI.onEngineReady = function () {
    origReady();
    setTimeout(livePump, 50);
  };

  // 恢复上次对局
  var restored = restoreGame();
  if (!restored) newGame();

  bindEvents();
  bindSettingsEvents();
  switchView('board');

  // 引擎启动
  setTimeout(function () {
    Engine.start();
    livePump();
  }, 200);

  // URL 参数：自测 / 演示（兼容无 URLSearchParams 的旧 WebView）
  var qs = null;
  try { qs = new URLSearchParams(location.search); } catch (e) {}
  if (qs && qs.get('test')) runSelfTests();
  if (qs && qs.get('demo')) loadDemo();
}

function bindEvents() {
  var $ = function (id) { return document.getElementById(id); };

  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.dataset.view); });
  });

  // 棋盘工具（v1.0.3：新增 ⏮◀▶⏭ 步进导航，恢复上一步/下一步功能）
  $('btnBFirst').addEventListener('click', function () { gotoBoardPly(0); });
  $('btnBPrev').addEventListener('click', function () { gotoBoardPly((App.navIdx || 0) - 1); });
  $('btnBNext').addEventListener('click', function () { gotoBoardPly((App.navIdx || 0) + 1); });
  $('btnBLast').addEventListener('click', function () { gotoBoardPly(App.game ? App.game.ucis.length : 0); });
  $('btnUndo').addEventListener('click', undoMove);
  $('btnFlip').addEventListener('click', function () { UI.flip(); updateBoardBadge(); });
  $('btnNew').addEventListener('click', function () {
    confirm2('开始新对局？当前对局记录将被清除。', function () { newGame(); });
  });
  $('btnEnginePlay').addEventListener('click', function () { UI.showDialog('dlgEngine'); });
  $('btnFen').addEventListener('click', function () {
    $('fenInput').value = App.pos ? App.pos.fen() : START_FEN;
    UI.showDialog('dlgFen');
  });
  var openPgn = function () { UI.showDialog('dlgPgn'); };
  $('btnImportPgn').addEventListener('click', openPgn);
  var btnPgn2 = $('btnImportPgn2');
  if (btnPgn2) btnPgn2.addEventListener('click', openPgn);
  $('btnReviewCurrent').addEventListener('click', function () {
    if (!App.game || !App.game.ucis.length) { UI.toast('当前没有对局可复盘', false); return; }
    switchView('review');
    startReview({
      startFen: App.game.startFen, ucis: App.game.ucis.slice(),
      sans: App.game.sans.slice(), headers: App.game.headers, result: App.game.result
    });
  });
  $('btnExport').addEventListener('click', function () {
    var pgn = exportCurrentPgn();
    if (!pgn) { UI.toast('没有可导出的对局', false); return; }
    if (window.Android) {
      window.Android.shareText('棋局评价 PGN', pgn);
    } else {
      var blob = new Blob([pgn], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'game-review.pgn';
      a.click();
    }
  });

  // 对话框通用关闭
  document.querySelectorAll('.dlg').forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) UI.hideDialog(d.id); });
  });
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { UI.hideDialog(b.dataset.close); });
  });

  // PGN 对话框
  $('btnPgnFromFile').addEventListener('click', function () {
    if (window.Android) window.Android.pgnPick();
    else UI.toast('浏览器测试模式：请直接粘贴 PGN', false);
  });
  $('btnPgnStart').addEventListener('click', function () {
    var text = $('pgnText').value;
    var game = importPgnText(text);
    if (!game) return;
    UI.hideDialog('dlgPgn');
    // 直接载入对局并开始复盘
    App.game = {
      startFen: game.startFen, ucis: game.ucis, sans: game.sans,
      headers: game.headers, result: game.result, fenHistory: []
    };
    replayTo(game.ucis.length);
    App.gameMeta = game.sans.map(function (s) { return { san: s, cls: null }; });
    switchView('review');
    startReview(game);
  });

  // FEN 对话框
  $('btnFenLoad').addEventListener('click', function () {
    var f = $('fenInput').value.trim();
    try {
      var pos = new Position(f);
      if (pos.kingSq(false) < 0 || pos.kingSq(true) < 0) throw new Error('缺少王');
      newGame(pos.fen());
      UI.hideDialog('dlgFen');
      UI.toast('局面已载入');
    } catch (e) {
      UI.toast('FEN 无效：' + e.message, false);
    }
  });

  // 人机对话框
  var lvSel = $('engineLevel');
  var updateDesc = function () {
    var lv = ENGINE_LEVELS[+lvSel.value - 1];
    $('engineLevelDesc').textContent = lv ? ('等级 ' + (+lvSel.value) + '：' + (lv.name2 || lv.name).trim() + ' · 思考约 ' + (lv.mt / 1000).toFixed(1) + ' 秒/步') : '';
  };
  lvSel.addEventListener('change', updateDesc);
  updateDesc();
  $('btnEngineStart').addEventListener('click', function () {
    var side = document.querySelector('input[name=engineSide]:checked').value;
    var level = +lvSel.value;
    App.enginePlay = { side: side, level: level, busy: false };
    UI.hideDialog('dlgEngine');
    UI.toast('人机对弈开始：引擎执' + (side === 'w' ? '白' : '黑'));
    if (App.pos.turn === side) engineMove();
  });
  $('btnEngineStop').addEventListener('click', function () {
    App.enginePlay = null;
    UI.hideDialog('dlgEngine');
    UI.toast('已退出人机对弈');
  });

  // 复盘中止
  $('btnReviewCancel').addEventListener('click', function () { App.reviewCancel = true; });

  // 复盘导航
  ['First', 'Prev', 'Next', 'Last'].forEach(function (n) {
    $('btnNav' + n).addEventListener('click', function () {
      if (!App.review) return;
      if (n === 'First') gotoReviewPly(0);
      else if (n === 'Prev') gotoReviewPly(App.reviewIdx - 1);
      else if (n === 'Next') gotoReviewPly(App.reviewIdx + 1);
      else gotoReviewPly(App.review.nodes.length - 1);
    });
  });

  // 演示按钮
  var demo = $('btnDemo');
  if (demo) demo.addEventListener('click', loadDemo);
}

/* ---------------- 演示对局（摩菲歌剧之战） ---------------- */
var DEMO_PGN = '[Event "Paris Opera House"]\n[Site "Paris FRA"]\n[Date "1858.??.??"]\n[White "Morphy, Paul"]\n[Black "Duke Karl / Count Isouard"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

function loadDemo() {
  var game = importPgnText(DEMO_PGN);
  if (!game) return;
  App.game = {
    startFen: game.startFen, ucis: game.ucis, sans: game.sans,
    headers: game.headers, result: game.result, fenHistory: []
  };
  replayTo(game.ucis.length);
  App.gameMeta = game.sans.map(function (s) { return { san: s, cls: null }; });
  switchView('review');
  startReview(game);
}

/* ---------------- 自测 ---------------- */
function runSelfTests() {
  var results = [];
  // 自测期间关闭实时评价，避免与 Mock 引擎分析竞争
  App.liveOn = false;
  App._liveSuspended = false;
  function T(name, fn) {
    try {
      var r = fn();
      results.push({ name: name, ok: r === true || r === undefined, detail: r });
    } catch (e) {
      results.push({ name: name, ok: false, detail: String(e && e.message || e) });
    }
  }

  // perft
  var p = new Position();
  T('perft start d1=20', function () { return perft(new Position(), 1) === 20; });
  T('perft start d2=400', function () { return perft(new Position(), 2) === 400; });
  T('perft start d3=8902', function () { return perft(new Position(), 3) === 8902; });
  T('perft start d4=197281', function () { return perft(new Position(), 4) === 197281; });
  T('perft kiwipete d1=48', function () { return perft(new Position('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 1) === 48; });
  T('perft kiwipete d2=2039', function () { return perft(new Position('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 2) === 2039; });
  T('perft kiwipete d3=97862', function () { return perft(new Position('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 3) === 97862; });
  T('perft pos3 d4=43238', function () { return perft(new Position('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), 4) === 43238; });
  T('perft pos4 d3=9467', function () { return perft(new Position('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'), 3) === 9467; });
  T('perft pos5 d3=62379', function () { return perft(new Position('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8'), 3) === 62379; });
  T('perft pos6 d3=89890', function () { return perft(new Position('r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10'), 3) === 89890; });

  // FEN 往返
  T('FEN roundtrip start', function () { return new Position().fen() === START_FEN; });
  T('FEN roundtrip kiwipete', function () {
    var f = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    return new Position(f).fen() === f;
  });

  // SAN
  T('SAN e4', function () {
    var pos = new Position();
    var mv = pos.sanToMove('e4');
    return mv && pos.san(mv) === 'e4' && moveToUci(mv) === 'e2e4';
  });
  T('SAN Nf3', function () {
    var pos = new Position();
    var mv = pos.sanToMove('Nf3');
    return mv && pos.san(mv) === 'Nf3';
  });
  T('SAN castling both', function () {
    var pos = new Position('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    var oo = pos.sanToMove('O-O'), ooo = pos.sanToMove('O-O-O');
    return oo && ooo && pos.san(oo) === 'O-O' && pos.san(ooo) === 'O-O-O';
  });
  T('SAN disambiguation', function () {
    var pos = new Position('4k3/8/8/8/8/8/R6R/4K3 w - - 0 1'); // 两个白车 a2 h2
    var mv = pos.sanToMove('Rad2');
    return mv && moveToUci(mv) === 'a2d2' && pos.san(mv) === 'Rad2';
  });
  T('SAN promotion', function () {
    var pos = new Position('8/P7/8/8/8/8/8/k1K5 w - - 0 1');
    var mv = pos.sanToMove('a8=Q');
    return mv && pos.san(mv).indexOf('a8=Q') === 0;
  });

  // PGN
  T('PGN parse opera game', function () {
    var g = parsePgn(DEMO_PGN);
    return !g.error && g.ucis.length === 33 && g.sans[0] === 'e4' && g.sans[32] === 'Rd8#';
  });
  T('PGN build roundtrip', function () {
    var g = parsePgn(DEMO_PGN);
    var pgn2 = buildPgn(g.headers, g.sans.map(function (s) { return { san: s }; }), g.result);
    var g2 = parsePgn(pgn2);
    return !g2.error && g2.ucis.length === g.ucis.length;
  });

  // Lichess 带评注 PGN（注释/嵌套变着/NAG/!?后缀/粘连步数/BOM/FEN起始）
  var LICHESS_PGN = '[Event "Rated Blitz game"]\n[Site "https://lichess.org/AbCdEfGh"]\n[Date "2026.10.30"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n' +
    '1. e4 { [%clk 0:03:00] } 1... c5 { [%clk 0:02:58] } 2. Nf3 { A good move (develops). } 2... Nc6 { (2... d5 3. exd5 Qxd5 { an alternative }) } ' +
    '3. d4!? { [%clk 0:02:40] } cxd4 4. Nxd4 Nf6 $2 5. Nc3 e5 6. Ndb5 { [%eval 0.25] [%clk 0:01:30] } d6 7. Bg5 a6 8. Nxd6+?? Bxd6 9. Bxf6 Qxf6 1-0';
  T('PGN lichess comments/variations/glyphs/NAG', function () {
    var g = parsePgn(LICHESS_PGN);
    return !g.error && g.ucis.length === 18 && g.sans[0] === 'e4' && g.sans[4] === 'd4' && g.sans[14] === 'Nxd6+' && g.result === '1-0';
  });
  T('PGN BOM + glued move numbers', function () {
    var g = parsePgn('\uFEFF[Event "T"]\n\n1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 1-0');
    return !g.error && g.ucis.length === 6 && g.sans[2] === 'Nf3';
  });
  T('PGN custom start FEN', function () {
    var g = parsePgn('[FEN "8/P7/8/8/8/8/8/k1K5 w - - 0 1"]\n[Result "*"]\n\n1. a8=Q *');
    return !g.error && g.ucis.length === 1 && g.ucis[0].slice(0, 4) === 'a7a8' && g.ucis[0].length === 5;
  });

  // 开局库合法性
  var bookBad = [];
  for (var i = 0; i < BOOK_LINES.length; i++) {
    try {
      var pos2 = new Position();
      var mvs = BOOK_LINES[i][1].split(' ');
      for (var k = 0; k < mvs.length; k++) {
        if (!uciToMove(pos2, mvs[k])) { bookBad.push(BOOK_LINES[i][0] + '#' + (k + 1)); break; }
        var m3 = uciToMove(pos2, mvs[k]);
        pos2.make(m3);
      }
    } catch (e) { bookBad.push(BOOK_LINES[i][0]); }
  }
  T('Book lines all legal (' + BOOK_LINES.length + ')', function () {
    return bookBad.length === 0 || '非法: ' + bookBad.join(',');
  });
  T('Book lookup hit', function () {
    return bookLookup('e2e4 e7e5 g1f3 b8c6') !== null;
  });
  T('Book lookup miss', function () {
    return bookLookup('a2a3 a7a6') === null;
  });

  // 胜率公式
  T('winPct 0cp=50', function () { return Math.abs(REVIEW.winPctFromCp(0) - 50) < 1e-9; });
  T('winPct 100cp≈59.1', function () { return Math.abs(REVIEW.winPctFromCp(100) - 59.1) < 0.5; });

  // 分类器（构造数据）
  function mkNode(winPctWhite, turn, legalCount, best1, best2, secondPctWhite) {
    // 反算 cp：W = 50+50*(2/(1+e^(-kcp))-1) → cp = ln(W/(100-W))/k
    function inv(w) {
      if (w >= 100) return 10000;
      if (w <= 0) return -10000;
      var cp = Math.log(w / (100 - w)) / 0.00368208;
      return isFinite(cp) ? Math.round(cp) : 0;
    }
    var n = REVIEW.makeNode('x', turn || 'w', legalCount == null ? 30 : legalCount);
    n.analyzed = true;
    n.cpW = inv(winPctWhite); n.mateW = null;
    n.best1 = best1 || null; n.best2 = best2 || null;
    if (secondPctWhite !== undefined && secondPctWhite !== null) {
      var cp2 = inv(secondPctWhite);
      n.cp2 = turn === 'w' ? cp2 : -cp2;
      n.mate2 = null;
    }
    return n;
  }
  function clsOf(winB, winA, opts) {
    opts = opts || {};
    var second = (opts.second == null) ? (winB - 3) : opts.second;
    var best2 = (opts.second == null && opts.best2 == null) ? 'e2e3' : (opts.best2 || 'e2e3');
    var a = mkNode(winB, 'w', opts.legal == null ? 30 : opts.legal, opts.best || 'e2e4', best2, second);
    a.fen = START_FEN;
    var b = mkNode(winA, 'b', 30, null, null);
    b.fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    b.playedUci = opts.played || 'd2d4';
    b.pv1 = [];
    var nodes = [a, b];
    var c = REVIEW.classifyMove(nodes, 0, opts.prefix || '', null);
    return c.cls;
  }
  T('classify blunder', function () { return clsOf(80, 40) === 'blunder'; });
  T('classify mistake', function () { return clsOf(80, 65) === 'mistake'; });
  T('classify inaccuracy', function () { return clsOf(80, 73) === 'inaccuracy'; });
  T('classify excellent', function () { return clsOf(80, 79) === 'excellent'; });
  T('classify good', function () { return clsOf(80, 76.5) === 'good'; });
  T('classify best', function () { return clsOf(80, 80, { played: 'e2e4' }) === 'best'; });
  T('classify great', function () { return clsOf(80, 80, { played: 'e2e4', second: 60 }) === 'great'; });
  T('classify forced single legal', function () { return clsOf(80, 80, { legal: 1 }) === 'forced'; });
  T('classify decisive equal NOT forced (only-legal rule)', function () { return ['good', 'excellent'].indexOf(clsOf(95, 93, { second: 94.2 })) >= 0; });
  T('classify brilliant = sacrifice + engine best', function () {
    var a = mkNode(50, 'w', 30, 'h1d5', 'd2d3', 30); // 次佳胜率 30 → spread 20（唯一好棋）
    a.fen = '3qk3/8/8/3p4/8/8/8/4K2R w - - 0 1';
    var b = mkNode(48, 'b', 30, null, null);
    b.fen = '3qk3/8/8/3R4/8/8/8/4K3 b - - 0 1';
    b.playedUci = 'h1d5';
    b.pv1 = ['d8d5']; // 对方最佳：Qxd5 吃回 → 弃车
    var c = REVIEW.classifyMove([a, b], 0, '', null);
    return c.cls === 'brilliant' && c.sac >= 4;
  });
  // 弃子口径（v1.0.3 双方子力差）：等价交换 / 以小换大不算弃子；以大换小才算
  T('sacrifice: equal trade is NOT a sac', function () {
    var a = REVIEW.makeNode('3nk3/1r6/8/8/8/8/8/1R1K4 w - - 0 1', 'w', 30);
    var b = REVIEW.makeNode('3nk3/1R6/8/8/8/8/8/3K4 b - - 0 1', 'b', 30);
    b.pv1 = ['d8b7']; // 马(d8)吃回车(b7)：车换车，等价交换
    return REVIEW.sacrificeValue(a, b, false) === 0;
  });
  T('sacrifice: small-for-big is NOT a sac', function () {
    var a = REVIEW.makeNode('3nk3/1r6/8/2N5/8/8/8/4K3 w - - 0 1', 'w', 30);
    var b = REVIEW.makeNode('3nk3/1N6/8/8/8/8/8/4K3 b - - 0 1', 'b', 30);
    b.pv1 = ['d8b7']; // 马吃回马：马换车，以小换大
    return REVIEW.sacrificeValue(a, b, false) === 0;
  });
  T('sacrifice: real bishop-for-pawn sac = 2', function () {
    var a = REVIEW.makeNode('7k/7p/8/8/8/8/8/1B1K4 w - - 0 1', 'w', 30);
    var b = REVIEW.makeNode('7k/7B/8/8/8/8/8/3K4 b - - 0 1', 'b', 30);
    b.pv1 = ['h8h7']; // 王吃回象：象换兵，真弃子
    return REVIEW.sacrificeValue(a, b, false) === 2;
  });
  T('settings & board nav static DOM', function () {
    return !!(document.getElementById('setLive') && document.getElementById('setOnlineBook') &&
      document.getElementById('setReviewDepth') && document.getElementById('diagBody') &&
      document.getElementById('btnBPrev') && document.getElementById('btnBNext'));
  });
  T('classify quiet not forced', function () { return clsOf(50, 50, { second: 49.2 }) === 'best'; });
  T('classify miss', function () { return clsOf(96, 60) === 'miss'; });
  T('classify book', function () { return clsOf(50, 50, { prefix: 'e2e4' }) === 'book'; });
  T('classify book online hit (priority over local)', function () {
    var a = mkNode(50, 'w', 30, 'e2e4', 'e2e3', 47);
    a.fen = START_FEN;
    a.bookOnline = { ok: true, name: "B00 King's Pawn", moves: [{ uci: 'e2e4', games: 100000 }] };
    var b = mkNode(50, 'b', 30, null, null);
    b.fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    b.playedUci = 'e2e4'; b.pv1 = [];
    var c = REVIEW.classifyMove([a, b], 0, '', null);
    return c.cls === 'book' && c.bookName === "B00 King's Pawn";
  });
  T('classify online says not book (no local fallback)', function () {
    var a = mkNode(50, 'w', 30, 'd2d4', 'e2e3', 47);
    a.fen = START_FEN;
    a.bookOnline = { ok: true, name: 'B00', moves: [{ uci: 'e2e4', games: 100000 }] };
    var b = mkNode(50, 'b', 30, null, null);
    b.fen = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPPP1PPP/RNBQKBNR b KQkq d1 0 1';
    b.playedUci = 'd2d4'; b.pv1 = [];
    var c = REVIEW.classifyMove([a, b], 0, 'd2d4', null);
    return c.cls === 'best';
  });

  // 准确率
  T('accuracy formula', function () {
    var moves = [{ cls: 'best', loss: 0 }, { cls: 'good', loss: 3 }];
    var acc = REVIEW.accuracyOf(moves, false);
    return acc !== null && acc > 80 && acc <= 100;
  });

  // 引擎 Mock 分析（异步）
  setTimeout(function () {
    Engine.analyze(START_FEN, { depth: 3 }).then(function (res) {
      results.push({ name: 'mock engine async analyze', ok: !!res.best, detail: res.best });
      finish();
    }).catch(function (e) {
      results.push({ name: 'mock engine async analyze', ok: false, detail: String(e) });
      finish();
    });
    function finish() {
      var pass = results.filter(function (r) { return r.ok; }).length;
      window.__TEST_RESULTS = { total: results.length, pass: pass, results: results };
      console.log('SELF TESTS: ' + pass + '/' + results.length);
      var box = document.createElement('div');
      box.id = 'testBox';
      box.style.cssText = 'position:fixed;left:0;top:0;right:0;max-height:50%;overflow:auto;z-index:999;background:#111;color:#9f9;font:11px monospace;padding:6px;';
      box.textContent = '自测 ' + pass + '/' + results.length + '\n' + results.map(function (r) {
        return (r.ok ? '✓' : '✗') + ' ' + r.name + (r.ok && r.detail !== true ? ' ' + r.detail : '');
      }).join('\n');
      document.body.appendChild(box);
    }
  }, 300);
}

/* ---------------- DOM ready ---------------- */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
