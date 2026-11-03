/* =========================================================================
 * UI 渲染层 —— chess.com 风格界面
 *  - 棋盘（SVG 棋子、走子动画、高亮、合法着法提示、箭头）
 *  - 评价徽章（11 类，按用户指定样式）
 *  - 着法列表 / 胜率柱状图 / 复盘看板 / 评注框
 * ========================================================================= */
'use strict';

var UI = {
  orientation: 'w',
  controller: null,       // { getPosition(), canMoveFrom(sq), requestMove(from,to,promo) }
  _pieceEls: {},          // sq -> element
  _selected: -1,
  _legalTargets: [],
  _lastMove: null,        // {from,to}
  _arrows: [],
  _demoMode: false,

  /* ---------------- 棋子 SVG（扁平 neo 风格） ---------------- */
  PIECE_SVG: (function () {
    function svg(inner, fill, stroke, sw) {
      return '<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg">' +
        '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + (sw || 1.7) +
        '" stroke-linejoin="round" stroke-linecap="round">' + inner + '</g></svg>';
    }
    var P = {
      pawn: '<circle cx="22.5" cy="14" r="5.6"/>' +
        '<path d="M16.8 20.5 C16.8 25.5 19.5 27.5 19.5 31.5 L25.5 31.5 C25.5 27.5 28.2 25.5 28.2 20.5 C26.4 18.6 24.5 17.8 22.5 17.8 C20.5 17.8 18.6 18.6 16.8 20.5 Z"/>' +
        '<rect x="12" y="32.5" width="21" height="5" rx="2"/>',
      rook: '<path d="M11.5 13 V7.5 h4.2 v2.8 h4.3 V7.5 h5 v2.8 h4.3 V7.5 h4.2 V13 Z"/>' +
        '<path d="M13.5 13 h18 l1.3 16.5 h-20.6 Z"/>' +
        '<rect x="10" y="29.5" width="25" height="4.4" rx="1.4"/>' +
        '<rect x="8.5" y="33.9" width="28" height="4.6" rx="1.8"/>',
      knight: '<path d="M15 38.5 h17 v-3.2 c0 -4.2 -1.6 -6.4 -3.7 -8.9 c3.1 -1.4 4.2 -5.6 2.6 -9.2 c-1.6 -3.6 -5.1 -5.6 -8.2 -4.6 c-0.5 -1.6 -1.4 -2.7 -2.1 -3.7 l-1.6 4.1 c-4.1 2.5 -6.6 7.1 -5.6 11.2 l4.1 -1.5 c0.1 -3.6 2.1 -6.2 4.6 -7.2 c-1.6 4.1 -5.1 6.7 -5.6 11.3 c-0.4 3.6 -0.5 7.4 -0.5 11.7 z"/>' +
        '<circle cx="18.6" cy="15.8" r="1" fill="STROKE" stroke="none"/>' +
        '<path d="M20.5 11.2 c2.4 0.2 4.2 1.4 5.3 3.1" fill="none" stroke-width="1.1"/>',
      bishop: '<circle cx="22.5" cy="7.8" r="2.3"/>' +
        '<path d="M22.5 10.2 C27 13 28.6 17 27.1 20.6 C26 23 24.3 24.2 22.5 24.2 C20.7 24.2 19 23 17.9 20.6 C16.4 17 18 13 22.5 10.2 Z"/>' +
        '<path d="M19.6 16.2 L25.4 11.4" fill="none" stroke-width="1.2"/>' +
        '<path d="M17.7 24.5 h9.6 l1.3 4.5 h-12.2 Z"/>' +
        '<rect x="12" y="29" width="21" height="4.6" rx="1.6"/>' +
        '<rect x="10.5" y="33.6" width="24" height="4.4" rx="1.8"/>',
      queen: '<circle cx="8.8" cy="15.8" r="2.1"/><circle cx="16.6" cy="11.6" r="2.1"/><circle cx="22.5" cy="10" r="2.2"/><circle cx="28.4" cy="11.6" r="2.1"/><circle cx="36.2" cy="15.8" r="2.1"/>' +
        '<path d="M9.5 17.5 L12.6 28.5 L32.4 28.5 L35.5 17.5 L30.6 24.6 L27.9 13.8 L25.1 24 L22.5 12.4 L19.9 24 L17.1 13.8 L14.4 24.6 Z"/>' +
        '<path d="M13 28.5 L12 33 L33 33 L32 28.5 Z"/>' +
        '<rect x="10" y="33.4" width="25" height="4.6" rx="1.8"/>',
      king: '<path d="M21.2 4.5 h2.6 v3.8 h3.8 v2.6 h-3.8 v3.8 h-2.6 v-3.8 h-3.8 v-2.6 h3.8 Z"/>' +
        '<path d="M22.5 14.6 C27.4 14.6 31 18 31 22.4 C31 25.8 28.6 27.8 27.6 30.5 L17.4 30.5 C16.4 27.8 14 25.8 14 22.4 C14 18 17.6 14.6 22.5 14.6 Z"/>' +
        '<path d="M17.4 30.5 L16 35 L29 35 L27.6 30.5 Z"/>' +
        '<rect x="11" y="35" width="23" height="4.6" rx="1.8"/>'
    };
    var out = {};
    var white = { f: '#FFFFFF', s: '#1F1D1A' };
    var black = { f: '#262421', s: '#B7B2A8' };
    ['pawn', 'rook', 'knight', 'bishop', 'queen', 'king'].forEach(function (k) {
      out['w' + k] = svg(P[k], white.f, white.s, 1.6);
      out['b' + k] = svg(P[k].replace(/STROKE/g, black.s), black.f, black.s, 1.6);
    });
    return out;
  })(),

  /* ---------------- 徽章图标 ---------------- */
  BADGE_ICON: (function () {
    function s(vb, inner) {
      return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>';
    }
    return {
      star: s(0, '<path d="M12 2.6 L14.9 8.9 L21.8 9.7 L16.7 14.4 L18.1 21.2 L12 17.8 L5.9 21.2 L7.3 14.4 L2.2 9.7 L9.1 8.9 Z" fill="#fff"/>'),
      thumb: s(0, '<path d="M3 10.5 h4.2 V21 H3 Z M9.2 10.5 L13.6 3.2 c2.4 0 3.4 1.4 2.8 3.6 L15.4 9.6 h5 c1.5 0 2.6 1.2 2.3 2.7 l-1.6 6.6 c-0.3 1.3-1.4 2.1-2.7 2.1 H9.2 Z" fill="#fff"/>'),
      check: s(0, '<path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>'),
      miss: s(0, '<path d="M5.5 5.5 L18.5 18.5 M18.5 5.5 L5.5 18.5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>'),
      forced: s(0, '<path d="M3 12 H17 M13 6.5 L19.5 12 L13 17.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
      book: s(0, '<path d="M4 4.5 C6.5 3.5 9.5 3.6 12 5 C14.5 3.6 17.5 3.5 20 4.5 V19 C17.5 18 14.5 18.1 12 19.5 C9.5 18.1 6.5 18 4 19 Z M12 5 V19.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>')
    };
  })(),

  badgeHtml: function (cls) {
    var info = REVIEW.CLS_INFO[cls] || REVIEW.CLS_INFO.unknown;
    var icon;
    if (['!!', '!', '?!', '?', '??'].indexOf(info.icon) >= 0) {
      icon = info.icon;
    } else if (UI.BADGE_ICON[info.icon]) {
      icon = UI.BADGE_ICON[info.icon];
    } else icon = '';
    return '<span class="badge b-' + cls + '" title="' + info.label + '">' + icon + '</span>';
  },

  /* ---------------- 初始化 ---------------- */
  init: function (controller) {
    var self = this;
    this.controller = controller;
    var $ = function (id) { return document.getElementById(id); };
    this.els = {
      board: $('board'), pieceLayer: $('pieceLayer'), arrowSvg: $('arrowSvg'),
      evalBar: $('evalBar'), evalFill: $('evalBarFill'), evalNum: $('evalNum'),
      engineChip: $('engineChip'), engineStatus: $('engineStatus'), turnTag: $('turnTag'),
      graph: $('graph'),
      promoLayer: $('promoLayer')
    };
    this._buildSquares();
    // 指针交互（只绑定一次）
    var board = this.els.board;
    board.addEventListener('pointerdown', function (e) {
      var sqEl = e.target.closest('.sq');
      if (!sqEl) return;
      var sq = +sqEl.dataset.sq;
      self._onTap(sq, e);
      e.preventDefault();
    }, { passive: false });
    // 胜率图点击
    if (this.els.graph) {
      this.els.graph.addEventListener('click', function (e) {
        var r = self.els.graph.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width;
        if (self.controller.onGraphTap) self.controller.onGraphTap(x);
      });
    }
  },

  _buildSquares: function () {
    var board = this.els.board;
    board.innerHTML = '';
    this._pieceEls = {};
    this.els.pieceLayer.innerHTML = '';
    for (var v = 0; v < 8; v++) {
      for (var u = 0; u < 8; u++) {
        var sq = this._viewToSq(u, v);
        var div = document.createElement('div');
        div.className = 'sq ' + ((((sq & 7) + (sq >> 3)) % 2 === 0) ? 'light' : 'dark');
        div.dataset.sq = sq;
        if (v === 7) div.innerHTML += '<span class="coord coord-file">' + 'abcdefgh'[sq & 7] + '</span>';
        if (u === 0) div.innerHTML += '<span class="coord coord-rank">' + ((sq >> 3) + 1) + '</span>';
        board.appendChild(div);
      }
    }
  },

  /* 视图坐标(0..7, v=0 在顶部) ↔ 棋盘格 */
  _viewToSq: function (u, v) {
    if (this.orientation === 'w') return ((7 - v) << 3) | u;
    return (v << 3) | (7 - u);
  },
  _sqToView: function (sq) {
    if (this.orientation === 'w') return [sq & 7, 7 - (sq >> 3)];
    return [7 - (sq & 7), sq >> 3];
  },

  _onTap: function (sq, ev) {
    var c = this.controller;
    if (!c) return;
    var pos = c.getPosition();
    if (!pos) return;
    var board = pos.board;

    // 已选中 → 尝试走子/换选
    if (this._selected >= 0) {
      var target = this._legalTargets.filter(function (t) { return t.to === sq; })[0];
      if (target) {
        this._clearSelection();
        if (target.promoNeeded) {
          this._showPromo(this._selected, sq);
        } else {
          c.requestMove(this._selected, sq, 0);
        }
        return;
      }
      if (sq === this._selected) { this._clearSelection(); return; }
    }
    // 选中己方棋子
    if (c.canMoveFrom(sq)) {
      this._select(sq);
      // 拖拽支持
      if (ev && ev.type === 'pointerdown') this._startDrag(sq, ev);
    } else {
      this._clearSelection();
    }
  },

  _select: function (sq) {
    this._clearSelection();
    this._selected = sq;
    var pos = this.controller.getPosition();
    var moves = pos.genMoves(true).filter(function (m) { return m.from === sq; });
    this._legalTargets = moves.map(function (m) {
      var isPawn = (pos.board[m.from] & 7) === 1;
      var lastRank = pos.turn === 'w' ? 7 : 0;
      return { to: m.to, capture: pos.board[m.to] !== 0 || m.ep, promoNeeded: isPawn && (m.to >> 3) === lastRank };
    });
    var sqEl = this._sqEl(sq);
    if (sqEl) sqEl.classList.add('sel');
    var self = this;
    this._legalTargets.forEach(function (t) {
      var sEl = self._sqEl(t.to);
      if (sEl) sEl.classList.add(t.capture ? 'cap-hint' : 'move-hint');
    });
  },

  _clearSelection: function () {
    this._selected = -1;
    this._legalTargets = [];
    document.querySelectorAll('.sq.sel, .sq.move-hint, .sq.cap-hint').forEach(function (el) {
      el.classList.remove('sel', 'move-hint', 'cap-hint');
    });
  },

  _sqEl: function (sq) {
    return this.els.board.querySelector('.sq[data-sq="' + sq + '"]');
  },

  _startDrag: function (sq, ev) {
    var self = this;
    var el = this._pieceEls[sq];
    if (!el) return;
    var boardRect = this.els.board.getBoundingClientRect();
    var cell = boardRect.width / 8;
    el.classList.add('dragging');
    el.style.zIndex = 20;
    function onMove(e) {
      var u = (e.clientX - boardRect.left) / cell - 0.5;
      var v = (e.clientY - boardRect.top) / cell - 0.5;
      el.style.transform = 'translate(' + (u * 100) + '%,' + (v * 100) + '%)';
    }
    function onUp(e) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      var u = Math.floor((e.clientX - boardRect.left) / cell);
      var v = Math.floor((e.clientY - boardRect.top) / cell);
      el.classList.remove('dragging');
      el.style.zIndex = '';
      if (u >= 0 && u < 8 && v >= 0 && v < 8) {
        var to = self._viewToSq(u, v);
        if (to !== sq) {
          var target = self._legalTargets.filter(function (t) { return t.to === to; })[0];
          self._clearSelection();
          if (target) {
            if (target.promoNeeded) self._showPromo(sq, to);
            else self.controller.requestMove(sq, to, 0);
            return;
          }
        }
      }
      self.renderBoard(self.controller.getPosition().fen());
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    onMove(ev);
  },

  _showPromo: function (from, to) {
    var self = this;
    var layer = this.els.promoLayer;
    var isWhite = this.controller.getPosition().turn === 'w';
    var types = [
      { t: 5, name: 'queen' }, { t: 4, name: 'rook' }, { t: 3, name: 'bishop' }, { t: 2, name: 'knight' }
    ];
    layer.innerHTML = types.map(function (x) {
      return '<button data-promo="' + x.t + '">' + self.PIECE_SVG[(isWhite ? 'w' : 'b') + x.name] + '</button>';
    }).join('');
    layer.classList.remove('hidden');
    layer.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        layer.classList.add('hidden');
        self.controller.requestMove(from, to, +btn.dataset.promo);
      });
    });
    var cancel = function () { layer.classList.add('hidden'); self.renderBoard(self.controller.getPosition().fen()); };
    layer.addEventListener('click', function (e) { if (e.target === layer) cancel(); });
  },

  /* ---------------- 棋盘渲染 ---------------- */
  renderBoard: function (fen, opts) {
    opts = opts || {};
    var pos;
    try { pos = new Position(fen); } catch (e) { return; }
    var board = pos.board;
    var layer = this.els.pieceLayer;
    var self = this;
    var seen = {};

    for (var sq = 0; sq < 64; sq++) {
      var p = board[sq];
      if (!p) continue;
      seen[sq] = true;
      var key = (p & 8 ? 'b' : 'w') + ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'][p & 7];
      var el = this._pieceEls[sq];
      if (el && el.dataset.key === key) continue; // 未变化
      if (el) { el.remove(); delete this._pieceEls[sq]; }
      el = document.createElement('div');
      el.className = 'piece';
      el.dataset.key = key;
      el.dataset.sq = sq;
      el.innerHTML = this.PIECE_SVG[key];
      layer.appendChild(el);
      this._pieceEls[sq] = el;
      var uv = this._sqToView(sq);
      el.style.transform = 'translate(' + (uv[0] * 100) + '%,' + (uv[1] * 100) + '%)';
    }
    // 清除消失的棋子
    Object.keys(this._pieceEls).forEach(function (k) {
      if (!seen[k]) { self._pieceEls[k].remove(); delete self._pieceEls[k]; }
    });
    // 位置修正（翻盘等）
    for (sq = 0; sq < 64; sq++) {
      var e2 = this._pieceEls[sq];
      if (e2) {
        var uv2 = this._sqToView(sq);
        e2.style.transform = 'translate(' + (uv2[0] * 100) + '%,' + (uv2[1] * 100) + '%)';
      }
    }
    // 最后一步高亮
    document.querySelectorAll('.sq.last-from, .sq.last-to').forEach(function (el) {
      el.classList.remove('last-from', 'last-to');
    });
    if (opts.lastMove) {
      var f = this._sqEl(opts.lastMove.from), t = this._sqEl(opts.lastMove.to);
      if (f) f.classList.add('last-from');
      if (t) t.classList.add('last-to');
    }
    this._lastMove = opts.lastMove || null;
    // 落子格右上角小徽章（当前步评价；原有着法列表/评注框徽章保持不变）
    this.setBoardBadge(opts.badge ? opts.badge.sq : null, opts.badge ? opts.badge.cls : null);
    // 检查指示
    document.querySelectorAll('.sq.check-hint').forEach(function (el) { el.classList.remove('check-hint'); });
    if (pos.inCheck()) {
      var k = pos.kingSq(pos.turn === 'b');
      var kEl = this._sqEl(k);
      if (kEl) kEl.classList.add('check-hint');
    }
  },

  flip: function () {
    this.orientation = this.orientation === 'w' ? 'b' : 'w';
    this._buildSquares();
    this.renderBoard(this.controller.getPosition().fen(), { lastMove: this._lastMove });
  },

  /* ---------------- 棋盘落子格右上角小徽章 ---------------- */
  boardBadgeHtml: function (cls) {
    var info = REVIEW.CLS_INFO[cls] || REVIEW.CLS_INFO.unknown;
    var icon;
    if (['!!', '!', '?!', '?', '??'].indexOf(info.icon) >= 0) icon = info.icon;
    else if (UI.BADGE_ICON[info.icon]) icon = UI.BADGE_ICON[info.icon];
    else icon = '';
    return '<span class="badge sq-badge b-' + cls + '">' + icon + '</span>';
  },

  setBoardBadge: function (sq, cls) {
    var board = this.els && this.els.board;
    if (!board) return;
    var old = board.querySelectorAll('.sq-badge');
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (sq == null || sq < 0 || !cls || cls === 'unknown') return;
    var sqEl = this._sqEl(sq);
    if (sqEl) sqEl.insertAdjacentHTML('beforeend', this.boardBadgeHtml(cls));
  },

  /* ---------------- 箭头 ---------------- */
  clearArrows: function () {
    this.els.arrowSvg.innerHTML = '';
    this._arrows = [];
  },

  addArrow: function (from, to, color, opacity) {
    if (from === to || from == null || to == null) return;
    var a = this._viewCenter(from), b = this._viewCenter(to);
    var svgNS = 'http://www.w3.org/2000/svg';
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.05) return;
    var ux = dx / len, uy = dy / len;
    var head = 0.32, bodyEnd = len - head * 1.1;
    var strokeW = 0.19;
    // 缩短线段避免箭头头部超出目标中心
    var sx = a[0] + ux * 0.12, sy = a[1] + uy * 0.12;
    var ex = a[0] + ux * bodyEnd, ey = a[1] + uy * bodyEnd;
    var line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', sx); line.setAttribute('y1', sy);
    line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', strokeW);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', opacity || 0.9);
    var poly = document.createElementNS(svgNS, 'polygon');
    var px = b[0] - ux * 0.06, py = b[1] - uy * 0.06;
    var hw = 0.17;
    var pts = [
      px + ',' + py,
      (a[0] + ux * bodyEnd - uy * hw) + ',' + (a[1] + uy * bodyEnd + ux * hw),
      (a[0] + ux * bodyEnd + uy * hw) + ',' + (a[1] + uy * bodyEnd - ux * hw)
    ].join(' ');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', color);
    poly.setAttribute('opacity', opacity || 0.9);
    this.els.arrowSvg.appendChild(line);
    this.els.arrowSvg.appendChild(poly);
  },

  _viewCenter: function (sq) {
    var uv = this._sqToView(sq);
    return [uv[0] + 0.5, uv[1] + 0.5];
  },

  /* ---------------- 评估条 ---------------- */
  renderEvalBar: function (pctWhite, str, thinking) {
    var fill = this.els.evalFill;
    if (!fill) return;
    var pct = (pctWhite === null || pctWhite === undefined) ? 50 : Math.max(0, Math.min(100, pctWhite));
    // orientation w: 白在下；b: 翻转
    if (this.orientation === 'w') {
      fill.style.bottom = '0';
      fill.style.top = 'auto';
      fill.style.height = pct + '%';
    } else {
      fill.style.top = '0';
      fill.style.bottom = 'auto';
      fill.style.height = (100 - pct) + '%';
    }
    this.els.evalNum.textContent = thinking ? '…' : (str || '0.0');
    this.els.evalNum.classList.toggle('thinking', !!thinking);
  },

  setEngineStatus: function (text, thinking) {
    if (this.els.engineStatus) {
      this.els.engineStatus.textContent = text;
      this.els.engineStatus.classList.toggle('thinking', !!thinking);
    }
  },

  setEngineChip: function (text, ok) {
    if (this.els.engineChip) {
      this.els.engineChip.textContent = text;
      this.els.engineChip.classList.toggle('ok', !!ok);
    }
  },

  /* ---------------- 着法列表 ---------------- */
  renderMoveList: function (container, moves, currentIdx, onPick) {
    container.innerHTML = '';
    var self = this;
    if (!moves || !moves.length) {
      container.innerHTML = '<div class="moves-empty">尚未走子</div>';
      return;
    }
    var table = document.createElement('div');
    table.className = 'mrow-wrap';
    for (var i = 0; i < moves.length; i += 2) {
      var row = document.createElement('div');
      row.className = 'mrow';
      var num = document.createElement('span');
      num.className = 'mnum';
      num.textContent = ((i >> 1) + 1) + '.';
      row.appendChild(num);
      [i, i + 1].forEach(function (j) {
        if (j >= moves.length) { row.appendChild(document.createElement('span')); return; }
        var cell = document.createElement('button');
        cell.className = 'mv' + (j === currentIdx ? ' cur' : '');
        var badge = moves[j].cls && moves[j].cls !== 'unknown' ? self.badgeHtml(moves[j].cls) : '';
        cell.innerHTML = moves[j].san + badge;
        cell.addEventListener('click', function () { onPick(j); });
        row.appendChild(cell);
      });
      table.appendChild(row);
    }
    container.appendChild(table);
    // 只滚动着法列表自身容器，不带动整页滚动（修复跳步时屏幕强制移动/跳底）
    var cur = container.querySelector('.mv.cur');
    var wrap = container.querySelector('.mrow-wrap');
    if (cur && wrap) {
      var top = cur.offsetTop, h = cur.offsetHeight;
      if (top < wrap.scrollTop || top + h > wrap.scrollTop + wrap.clientHeight) {
        wrap.scrollTop = top + h / 2 - wrap.clientHeight / 2;
      }
    }
  },

  /* ---------------- 胜率图 ---------------- */
  drawGraph: function (canvas, nodes, currentIdx) {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 320, h = canvas.clientHeight || 88;
    canvas.width = w * dpr; canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 背景
    ctx.fillStyle = '#262421';
    ctx.fillRect(0, 0, w, h);
    var n = nodes.length;
    if (!n) return;
    var mid = h / 2;
    ctx.strokeStyle = '#4B4744';
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    var bw = Math.max(2, w / n - 1);
    var gap = 1;
    for (var i = 0; i < n; i++) {
      var pct = REVIEW.nodeWinPct(nodes[i]);
      if (pct === null) pct = 50;
      var x = i * (w / n) + (w / n - bw) / 2;
      var up = (pct - 50) / 50 * (h / 2 - 2); // 白方优势向上
      if (up >= 0) {
        ctx.fillStyle = '#E8E8E2';
        ctx.fillRect(x, mid - up, bw, up);
      } else {
        ctx.fillStyle = '#151412';
        ctx.fillRect(x, mid, bw, -up);
        ctx.strokeStyle = '#4B4744';
        ctx.strokeRect(x, mid, bw, -up);
      }
    }
    // 当前位置标记
    if (currentIdx !== null && currentIdx !== undefined && currentIdx >= 0 && currentIdx < n) {
      var cx = currentIdx * (w / n) + (w / n) / 2;
      ctx.strokeStyle = '#81B64C';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
      ctx.lineWidth = 1;
    }
  },

  /* ---------------- 复盘看板 ---------------- */
  renderDashboard: function (review, container) {
    var self = this;
    var counts = review.counts;
    var order = ['brilliant', 'great', 'best', 'excellent', 'good', 'book',
      'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];
    var html = '';
    html += '<div class="acc-cards">';
    html += '<div class="acc-card"><div class="acc-name">白方 ' + esc(review.headers.White || '白方') + '</div><div class="acc-val">' +
      (review.accuracyW === null ? '—' : review.accuracyW.toFixed(1)) + '<small>%</small></div></div>';
    html += '<div class="acc-card"><div class="acc-name">黑方 ' + esc(review.headers.Black || '黑方') + '</div><div class="acc-val">' +
      (review.accuracyB === null ? '—' : review.accuracyB.toFixed(1)) + '<small>%</small></div></div>';
    html += '</div>';
    html += '<div class="chip-grid">';
    order.forEach(function (k) {
      var info = REVIEW.CLS_INFO[k];
      html += '<div class="chip"><span class="badge b-' + k + '">' +
        (self.BADGE_ICON[info.icon] ? self.BADGE_ICON[info.icon] : info.icon) +
        '</span><span class="chip-num">' + (counts[k] || 0) + '</span><span class="chip-label">' + info.label + '</span></div>';
    });
    html += '</div>';
    // 关键时刻
    if (review.moments && review.moments.length) {
      html += '<div class="moments"><div class="sec-title">关键局面</div>';
      review.moments.forEach(function (mo) {
        html += '<button class="moment" data-idx="' + mo.idx + '">' +
          self.badgeHtml(mo.cls) +
          '<span class="mo-move">第' + Math.floor(mo.idx / 2 + 1) + '手 ' + (mo.idx % 2 === 0 ? '白' : '黑') + ' ' + mo.san + '</span>' +
          '<span class="mo-loss">' + (mo.cls === 'brilliant' || mo.cls === 'great' ? '★' :
            (mo.winB !== null && mo.winA !== null ? Math.round(mo.winB) + '%→' + Math.round(mo.winA) + '%' : '')) + '</span></button>';
      });
      html += '</div>';
    }
    container.innerHTML = html;
    container.querySelectorAll('.moment').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (self.controller.onMomentPick) self.controller.onMomentPick(+btn.dataset.idx);
      });
    });
  },

  /* ---------------- 评注框 ---------------- */
  renderComment: function (review, idx, container) {
    // idx: 当前所在节点（0=初始局面）；评注展示“到达该局面的着法”
    if (!review || idx <= 0 || !review.moves[idx - 1]) {
      var initTxt = '初始局面。';
      if (review && review.nodes && review.nodes[0]) {
        var e0 = REVIEW.evalStr(review.nodes[0]);
        if (e0) initTxt += ' 引擎评估：' + e0 + '（白方视角）';
      }
      container.innerHTML = '<div class="comment init">' + initTxt + '</div>';
      return;
    }
    var m = review.moves[idx - 1];
    var info = REVIEW.CLS_INFO[m.cls] || REVIEW.CLS_INFO.unknown;
    var bestLine = '';
    if (m.bestUci && review.nodes[idx - 1]) {
      try {
        var p = new Position(review.nodes[idx - 1].fen);
        var pv = (review.nodes[idx - 1].pv1 || []).slice(0, 5);
        var sans = [];
        for (var i = 0; i < pv.length; i++) {
          var mv = uciToMove(p, pv[i]);
          if (!mv) break;
          sans.push(p.san(mv));
          p.make(mv);
        }
        if (sans.length) bestLine = '引擎主线：' + sans.join(' ');
      } catch (e) {}
    }
    container.innerHTML =
      '<div class="comment"><div class="c-head">' + this.badgeHtml(m.cls) +
      '<span class="c-label" style="color:' + info.color + '">' + info.label + '</span>' +
      '<span class="c-eval">' + (m.evalAfter || '') + '</span></div>' +
      '<div class="c-text">' + esc(m.comment) + '</div>' +
      (bestLine ? '<div class="c-pv">' + esc(bestLine) + '</div>' : '') +
      (m.winB !== null && m.winA !== null && m.cls !== 'book' && m.cls !== 'forced' ?
        '<div class="c-pct"><span>白方胜率</span><div class="pct-track"><div class="pct-fill" style="width:' + m.winA + '%"></div></div><span>' + Math.round(m.winA) + '%</span></div>' : '') +
      '</div>';
  },

  /* ---------------- 对话框 ---------------- */
  showDialog: function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('open');
  },
  hideDialog: function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  },
  hideAllDialogs: function () {
    document.querySelectorAll('.dlg').forEach(function (el) { el.classList.remove('open'); });
  },

  toast: function (msg, ok) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (ok === false ? ' err' : '');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  },

  /* ---------------- 引擎状态钩子 ---------------- */
  onEngineReady: function () {
    this.setEngineChip(Engine.name.split(' ')[0] || '引擎', true);
    this.setEngineStatus(Engine.name + ' · 就绪', false);
  },
  onEngineFailed: function (msg) {
    this.setEngineChip('引擎不可用', false);
    this.setEngineStatus(msg || '引擎不可用', false);
    this.toast(msg || '引擎不可用', false);
  },
  onEngineDied: function () {
    this.setEngineChip('引擎已退出', false);
    this.setEngineStatus('引擎进程已退出', false);
  }
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

if (typeof window !== 'undefined') window.UI = UI;
