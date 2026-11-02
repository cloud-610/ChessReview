/* =========================================================================
 * 引擎桥接层 —— UCI 协议驱动（搜索队列模型）
 *
 * 关键设计：UCI 的 info/bestmove 输出无法自带标识，必须按命令顺序匹配——
 * 每次 'go' 入队一个 pending，info 行归属队头搜索，bestmove 结算队头搜索。
 * 被新搜索取代的旧搜索仍会正常返回各自结果（不丢弃，填充节点缓存）。
 *
 * - analyze(fen, {depth}) : Promise，MultiPV=2 收集双路评估
 * - onInfo 回调用于实时评价（渐进深度刷新评估条）
 * - 无 Android 桥时自动启用内置 Mock 引擎（浏览器自测用）
 * ========================================================================= */
'use strict';

var Engine = {
  ready: false,
  name: '',
  info: { cores: 4, abi: '', appVersion: '', model: '' },
  _queue: [],             // 搜索队列（与 'go' 命令一一对应，FIFO）
  _multiPv: 0,
  _onInfo: null,          // function(parsedLine, fen) 实时评价钩子
  _mock: null,
  _mockMode: false,

  init: function () {
    var self = this;
    window.Bridge = window.Bridge || {};
    window.Bridge.engineLines = function (arr) { self._onLines(arr); };
    window.Bridge.engineReady = function (info) {
      self.ready = true;
      try { self.info = JSON.parse(info); } catch (e) { self.info = { cores: 4 }; }
      self.name = self.info.name || 'Stockfish';
      if (typeof UI !== 'undefined' && UI.onEngineReady) UI.onEngineReady();
    };
    window.Bridge.engineFailed = function (msg) {
      self.ready = false;
      if (typeof UI !== 'undefined' && UI.onEngineFailed) UI.onEngineFailed(msg);
    };
    window.Bridge.engineDied = function (code) {
      self.ready = false;
      if (typeof UI !== 'undefined' && UI.onEngineDied) UI.onEngineDied(code);
    };
    this._mockMode = !window.Android;
    if (this._mockMode) this._initMock();
  },

  start: function () {
    if (this._mockMode) {
      this.ready = true;
      this.name = 'Mockfish (测试引擎)';
      this.info = { cores: 4, abi: 'x86_64', appVersion: '1.0.0', model: 'nn-mock.nnue' };
      if (typeof UI !== 'undefined' && UI.onEngineReady) UI.onEngineReady();
      return true;
    }
    try { return !!window.Android.engineStart(); }
    catch (e) { return false; }
  },

  send: function (cmd) {
    if (this._mockMode) { this._mockSend(cmd); return; }
    try { window.Android.engineSend(cmd); } catch (e) {}
  },

  setOption: function (name, value) {
    if (this._mockMode) return;
    try { window.Android.engineSet(name, String(value)); } catch (e) {}
  },

  setMultiPv: function (n) {
    if (this._multiPv === n) return;
    this._multiPv = n;
    this.send('setoption name MultiPV value ' + n);
  },

  /* ---------------- 分析 API ---------------- */

  _makePending: function (fen) {
    return { fen: fen, resolve: null, reject: null, info: {}, timer: null, done: false, bestmove: null };
  },

  analyze: function (fen, opts) {
    var self = this;
    opts = opts || {};
    var depth = opts.depth || 14;
    var pending = this._makePending(fen);
    this._queue.push(pending);
    if (!this._mockMode) {
      this.setMultiPv(2);
      this.send('position fen ' + fen);
      this.send('go depth ' + depth);
    } else {
      this._mockSend('position fen ' + fen);
      this._mockSend('go depth ' + depth);
    }
    // 超时兜底：发 stop，引擎回 bestmove 后自然结算
    pending.timer = setTimeout(function () {
      if (!pending.done) self.send('stop');
    }, opts.timeoutMs || 60000);
    return new Promise(function (resolve, reject) {
      pending.resolve = resolve;
      pending.reject = reject;
    });
  },

  /* 引擎执子（人机对弈）：返回 uci */
  playMove: function (fen, opts) {
    opts = opts || {};
    var self = this;
    var pending = this._makePending(fen);
    this._queue.push(pending);
    if (!this._mockMode) {
      this.setMultiPv(1);
      this.send('position fen ' + fen);
      if (opts.movetime) this.send('go movetime ' + opts.movetime);
      else this.send('go depth ' + (opts.depth || 10));
    } else {
      this._mockSend('position fen ' + fen);
      this._mockSend('go movetime ' + (opts.movetime || 300));
    }
    pending.timer = setTimeout(function () {
      if (!pending.done) self.send('stop');
    }, (opts.movetime || 0) + 30000);
    return new Promise(function (resolve, reject) {
      pending.resolve = resolve;
      pending.reject = reject;
    });
  },

  /* ---------------- UCI 输出解析 ---------------- */

  _parseInfoLine: function (line) {
    if (line.indexOf('info ') !== 0) return null;
    if (line.indexOf(' pv ') < 0) return null;
    var out = { depth: 0, multipv: 1, cp: null, mate: null, pv: [] };
    var m = line.match(/\bdepth (\d+)/); if (m) out.depth = +m[1];
    m = line.match(/\bmultipv (\d+)/); if (m) out.multipv = +m[1];
    m = line.match(/\bscore cp (-?\d+)/); if (m) out.cp = +m[1];
    m = line.match(/\bscore mate (-?\d+)/); if (m) out.mate = +m[1];
    m = line.match(/\bpv (.+)$/); if (m) out.pv = m[1].trim().split(/\s+/);
    return out;
  },

  _onLines: function (arr) {
    for (var i = 0; i < arr.length; i++) {
      var line = arr[i];
      if (line.indexOf('bestmove') === 0) {
        var p = this._queue.shift();
        if (p && !p.done) {
          var tok = line.split(/\s+/);
          p.bestmove = (tok[1] && tok[1] !== '(none)') ? tok[1] : null;
          this._settle(p);
        }
        continue;
      }
      var parsed = this._parseInfoLine(line);
      if (!parsed) continue;
      var head = this._queue.length ? this._queue[0] : null;
      if (head && !head.done) {
        var slot = head.info[parsed.multipv];
        if (!slot || parsed.depth >= slot.depth) head.info[parsed.multipv] = parsed;
        if (this._onInfo) {
          try { this._onInfo(parsed, head.fen); } catch (e) {}
        }
      }
    }
  },

  _settle: function (p) {
    if (p.done) return;
    p.done = true;
    if (p.timer) clearTimeout(p.timer);
    var i1 = p.info[1] || null;
    var i2 = p.info[2] || null;
    var result = {
      fen: p.fen,
      reason: 'bestmove',
      best: p.bestmove || (i1 && i1.pv.length ? i1.pv[0] : null),
      bestmove: p.bestmove || null,
      cp1: i1 ? i1.cp : null, mate1: i1 ? i1.mate : null,
      pv1: i1 ? i1.pv.slice(0, 12) : [],
      depth1: i1 ? i1.depth : 0,
      cp2: i2 ? i2.cp : null, mate2: i2 ? i2.mate : null,
      best2: i2 && i2.pv.length ? i2.pv[0] : null,
      pv2: i2 ? i2.pv.slice(0, 8) : [],
      depth2: i2 ? i2.depth : 0
    };
    if (p.resolve) {
      try { p.resolve(result); } catch (e) {}
    }
  },

  /* ---------------- Mock 引擎（浏览器自测） ---------------- */

  _initMock: function () {
    var self = this;
    this._mock = { pos: new Position(START_FEN) };
    this._mockEval = function (pos) {
      var v = 0;
      var b = pos.board;
      var square = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };
      var pst = [0, 2, 4, 1, 3, 2, 3, 1, 8, 6, 4, 2, 8, 6, 4, 2,
        -6, -4, 4, 2, -6, -4, 4, 2, 6, 4, -2, -4, 6, 4, -2, -4,
        4, 2, -4, -6, 4, 2, -4, -6, 2, 0, -6, -8, 2, 0, -6, -8,
        0, -2, -8, -10, 0, -2, -8, -10, -4, -6, -10, -12, -4, -6, -10, -12];
      for (var i = 0; i < 64; i++) {
        var p = b[i];
        if (!p) continue;
        var t = p & 7;
        var val = square[t] + (t === 1 ? pst[i] / 8 : 0);
        v += (p & 8) ? -val : val;
      }
      return pos.turn === 'w' ? v : -v;
    };
    this._mockSearch = function (pos, depth) {
      var moves = pos.genMoves(true);
      if (!moves.length) {
        if (pos.inCheck()) return { score: -30000 + (10 - depth) };
        return { score: 0 };
      }
      if (depth <= 0) return { score: self._mockEval(pos) };
      var best = null, bestScore = -Infinity;
      var list = [];
      for (var i = 0; i < moves.length; i++) {
        pos.make(moves[i]);
        var r = self._mockSearch(pos, depth - 1);
        pos.unmake();
        var sc = -r.score;
        list.push({ move: moves[i], score: sc });
        if (sc > bestScore) { bestScore = sc; best = moves[i]; }
      }
      list.sort(function (a, b) { return b.score - a.score; });
      return { score: bestScore, best: best, list: list };
    };
  },

  _mockSend: function (cmd) {
    var self = this;
    var mock = this._mock;
    if (cmd.indexOf('position fen ') === 0) {
      mock.pos = new Position(cmd.slice(13));
      return;
    }
    if (cmd.indexOf('go ') === 0) {
      var m = cmd.match(/depth (\d+)/);
      var depth = m ? Math.min(+m[1], 2) : 2;
      var lines = [];
      for (var d = 1; d <= depth; d++) {
        var r = self._mockSearch(new Position(mock.pos.fen()), d);
        var sorted = r.list || [];
        for (var pv = 1; pv <= 2 && pv <= sorted.length; pv++) {
          var mv = sorted[pv - 1].move;
          var cpv = Math.round(sorted[pv - 1].score);
          var mate = null;
          if (Math.abs(cpv) > 29000) { mate = cpv > 0 ? 1 : -1; cpv = null; }
          lines.push('info depth ' + d + ' multipv ' + pv +
            (cpv !== null ? ' score cp ' + cpv : ' score mate ' + mate) +
            ' pv ' + moveToUci(mv));
        }
      }
      var rr = self._mockSearch(new Position(mock.pos.fen()), depth);
      lines.push('bestmove ' + (rr.best ? moveToUci(rr.best) : '0000'));
      // 原子输出且严格按命令顺序（模拟真实引擎串行输出）
      var now = Date.now();
      var at = Math.max(now + 40, (mock.emitAt || 0) + 60);
      mock.emitAt = at;
      setTimeout(function () {
        for (var i = 0; i < lines.length; i++) self._onLines([lines[i]]);
      }, at - now);
      return;
    }
    // stop / quit / setoption / isready / uci 忽略
  }
};

if (typeof window !== 'undefined') window.Engine = Engine;
