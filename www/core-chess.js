/* =========================================================================
 * 棋局评价 —— 棋类核心引擎（走法生成 / FEN / SAN / PGN）
 * 纯 JS 实现，无依赖。棋盘 64 格，index = rank*8 + file（a1=0, h8=63）。
 * 棋子编码：0 空；1-6 白 P N B R Q K；9-14 黑（颜色位 8）。
 * ========================================================================= */
'use strict';

var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

var PIECE_CHAR = { 1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };
var TYPE_OF = function (p) { return p & 7; };
var IS_BLACK = function (p) { return (p & 8) !== 0; };
var FILE_OF = function (s) { return s & 7; };
var RANK_OF = function (s) { return s >> 3; };
var SQ = function (f, r) { return (r << 3) | f; };
var FILES = 'abcdefgh';
function sqName(s) { return FILES[s & 7] + ((s >> 3) + 1); }
function nameToSq(n) { return ((n.charCodeAt(1) - 49) << 3) | (n.charCodeAt(0) - 97); }
var PROMO_LETTER = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };
var PROMO_TYPE = { n: 2, b: 3, r: 4, q: 5 };
var PIECE_VAL = [0, 1, 3, 3, 5, 9, 0]; // 用于局面物质量化（王不计）

var KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
var KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
var DIAG_D = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
var ORTH_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/* ---------------- Position ---------------- */

function Position(fen) {
  this.board = new Int8Array(64);
  this.turn = 'w';
  this.castling = 0; // 1=K 2=Q 4=k 8=q
  this.ep = -1;
  this.half = 0;
  this.full = 1;
  this.undoStack = [];
  this.load(fen || START_FEN);
}

Position.prototype.load = function (fen) {
  var parts = fen.trim().split(/\s+/);
  var rows = parts[0].split('/');
  for (var r = 0; r < 8; r++) {
    var row = rows[7 - r]; // FEN 从第8行开始
    var f = 0;
    for (var i = 0; i < row.length; i++) {
      var c = row[i];
      if (c >= '1' && c <= '8') { f += c.charCodeAt(0) - 48; }
      else {
        var lower = c.toLowerCase();
        var t = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 }[lower];
        this.board[SQ(f, r)] = t | (c === lower ? 8 : 0);
        f++;
      }
    }
  }
  this.turn = parts[1] || 'w';
  var cast = parts[2] || '-';
  this.castling = 0;
  if (cast.indexOf('K') >= 0) this.castling |= 1;
  if (cast.indexOf('Q') >= 0) this.castling |= 2;
  if (cast.indexOf('k') >= 0) this.castling |= 4;
  if (cast.indexOf('q') >= 0) this.castling |= 8;
  this.ep = (parts[3] && parts[3] !== '-') ? nameToSq(parts[3]) : -1;
  this.half = parseInt(parts[4] || '0', 10) || 0;
  this.full = parseInt(parts[5] || '1', 10) || 1;
  this.undoStack = [];
};

Position.prototype.fen = function () {
  var s = '';
  for (var r = 7; r >= 0; r--) {
    if (r < 7) s += '/';
    var empty = 0;
    for (var f = 0; f < 8; f++) {
      var p = this.board[SQ(f, r)];
      if (p === 0) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      var ch = PIECE_CHAR[p & 7];
      s += (p & 8) ? ch.toLowerCase() : ch;
    }
    if (empty) s += empty;
  }
  var cast = '';
  if (this.castling & 1) cast += 'K';
  if (this.castling & 2) cast += 'Q';
  if (this.castling & 4) cast += 'k';
  if (this.castling & 8) cast += 'q';
  return s + ' ' + this.turn + ' ' + (cast || '-') + ' ' +
    (this.ep >= 0 ? sqName(this.ep) : '-') + ' ' + this.half + ' ' + this.full;
};

Position.prototype.positionKey = function () {
  // 三次重复局面判定用的 key（不含步数计数）
  return this.fen().split(' ').slice(0, 4).join(' ');
};

Position.prototype.kingSq = function (black) {
  var k = 6 | (black ? 8 : 0);
  for (var i = 0; i < 64; i++) if (this.board[i] === k) return i;
  return -1;
};

/* sq 是否被 byBlack 一方攻击 */
Position.prototype.attacked = function (sq, byBlack) {
  var b = this.board, i, t, f, r;
  var f0 = FILE_OF(sq), r0 = RANK_OF(sq);
  // 兵
  if (byBlack) {
    if (f0 > 0 && sq + 7 < 64 && b[sq + 7] === 9) return true;   // 黑兵在(file-1,rank+1)
    if (f0 < 7 && sq + 9 < 64 && b[sq + 9] === 9) return true;   // 黑兵在(file+1,rank+1)
  } else {
    if (f0 > 0 && sq - 9 >= 0 && b[sq - 9] === 1) return true;   // 白兵在(file-1,rank-1)
    if (f0 < 7 && sq - 7 >= 0 && b[sq - 7] === 1) return true;   // 白兵在(file+1,rank-1)
  }
  // 马
  var kn = 2 | (byBlack ? 8 : 0);
  for (i = 0; i < 8; i++) {
    f = f0 + KNIGHT_D[i][0]; r = r0 + KNIGHT_D[i][1];
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[SQ(f, r)] === kn) return true;
  }
  // 王
  var kg = 6 | (byBlack ? 8 : 0);
  for (i = 0; i < 8; i++) {
    f = f0 + KING_D[i][0]; r = r0 + KING_D[i][1];
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[SQ(f, r)] === kg) return true;
  }
  // 斜线（象/后）
  var bi = 3 | (byBlack ? 8 : 0), qu = 5 | (byBlack ? 8 : 0);
  for (i = 0; i < 4; i++) {
    f = f0 + DIAG_D[i][0]; r = r0 + DIAG_D[i][1];
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      t = b[SQ(f, r)];
      if (t !== 0) { if (t === bi || t === qu) return true; break; }
      f += DIAG_D[i][0]; r += DIAG_D[i][1];
    }
  }
  // 直线（车/后）
  var ro = 4 | (byBlack ? 8 : 0);
  for (i = 0; i < 4; i++) {
    f = f0 + ORTH_D[i][0]; r = r0 + ORTH_D[i][1];
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      t = b[SQ(f, r)];
      if (t !== 0) { if (t === ro || t === qu) return true; break; }
      f += ORTH_D[i][0]; r += ORTH_D[i][1];
    }
  }
  return false;
};

Position.prototype.inCheckOf = function (black) {
  // 指定一方的王是否被将军
  return this.attacked(this.kingSq(!!black), !black);
};

Position.prototype.inCheck = function () {
  return this.inCheckOf(this.turn === 'b');
};

/* 生成伪合法走法；legalOnly=true 时过滤自将 */
Position.prototype.genMoves = function (legalOnly) {
  var moves = [];
  var b = this.board;
  var white = this.turn === 'w';
  var own = white ? 0 : 8;
  var i, f, r, t, df, dr, tf, tr;

  var addPawn = function (from, to, promo, ep) {
    if (promo) {
      moves.push({ from: from, to: to, promo: 5 });
      moves.push({ from: from, to: to, promo: 4 });
      moves.push({ from: from, to: to, promo: 3 });
      moves.push({ from: from, to: to, promo: 2 });
    } else {
      moves.push({ from: from, to: to, promo: 0, ep: !!ep });
    }
  };

  for (var sq = 0; sq < 64; sq++) {
    var p = b[sq];
    if (p === 0 || (p & 8) !== own) continue;
    var type = p & 7;
    f = FILE_OF(sq); r = RANK_OF(sq);

    if (type === 1) { // 兵
      var dir = white ? 1 : -1;
      var startRank = white ? 1 : 6;
      var lastRank = white ? 7 : 0;
      var one = sq + 8 * dir;
      if (one >= 0 && one < 64 && b[one] === 0) {
        addPawn(sq, one, RANK_OF(one) === lastRank, false);
        var two = sq + 16 * dir;
        if (r === startRank && b[two] === 0) moves.push({ from: sq, to: two, promo: 0, ep: false });
      }
      for (df = -1; df <= 1; df += 2) {
        tf = f + df; tr = r + dir;
        if (tf < 0 || tf > 7 || tr < 0 || tr > 7) continue;
        t = SQ(tf, tr);
        var tp = b[t];
        if (tp !== 0 && (tp & 8) !== own) addPawn(sq, t, tr === lastRank, false);
        else if (tp === 0 && t === this.ep) addPawn(sq, t, false, true);
      }
    } else if (type === 2 || type === 6) { // 马 / 王
      var deltas = (type === 2) ? KNIGHT_D : KING_D;
      for (i = 0; i < deltas.length; i++) {
        tf = f + deltas[i][0]; tr = r + deltas[i][1];
        if (tf < 0 || tf > 7 || tr < 0 || tr > 7) continue;
        t = SQ(tf, tr);
        if (b[t] === 0 || (b[t] & 8) !== own) moves.push({ from: sq, to: t, promo: 0, ep: false });
      }
    } else { // 象 / 车 / 后
      var dirs = (type === 3) ? DIAG_D : (type === 4) ? ORTH_D : ORTH_D.concat(DIAG_D);
      for (i = 0; i < dirs.length; i++) {
        tf = f + dirs[i][0]; tr = r + dirs[i][1];
        while (tf >= 0 && tf < 8 && tr >= 0 && tr < 8) {
          t = SQ(tf, tr);
          if (b[t] === 0) moves.push({ from: sq, to: t, promo: 0, ep: false });
          else {
            if ((b[t] & 8) !== own) moves.push({ from: sq, to: t, promo: 0, ep: false });
            break;
          }
          tf += dirs[i][0]; tr += dirs[i][1];
        }
      }
    }
  }

  // 王车易位
  if (white) {
    if ((this.castling & 1) && b[5] === 0 && b[6] === 0 && b[7] === 4 &&
      !this.attacked(4, true) && !this.attacked(5, true) && !this.attacked(6, true)) {
      moves.push({ from: 4, to: 6, promo: 0, ep: false, castle: 'K' });
    }
    if ((this.castling & 2) && b[3] === 0 && b[2] === 0 && b[1] === 0 && b[0] === 4 &&
      !this.attacked(4, true) && !this.attacked(3, true) && !this.attacked(2, true)) {
      moves.push({ from: 4, to: 2, promo: 0, ep: false, castle: 'Q' });
    }
  } else {
    if ((this.castling & 4) && b[61] === 0 && b[62] === 0 && b[63] === 12 &&
      !this.attacked(60, false) && !this.attacked(61, false) && !this.attacked(62, false)) {
      moves.push({ from: 60, to: 62, promo: 0, ep: false, castle: 'K' });
    }
    if ((this.castling & 8) && b[59] === 0 && b[58] === 0 && b[57] === 0 && b[56] === 12 &&
      !this.attacked(60, false) && !this.attacked(59, false) && !this.attacked(58, false)) {
      moves.push({ from: 60, to: 58, promo: 0, ep: false, castle: 'Q' });
    }
  }

  if (legalOnly === false) return moves;
  var legal = [];
  for (i = 0; i < moves.length; i++) {
    this.make(moves[i]);
    // make 后 turn 已翻转：若当前 turn 为白，说明行棋方是黑
    if (!this.inCheckOf(this.turn === 'w')) legal.push(moves[i]);
    this.unmake();
  }
  return legal;
};

Position.prototype.make = function (move) {
  var b = this.board;
  var p = b[move.from];
  var captured = b[move.to];
  var capSq = -1;
  var u = {
    castling: this.castling, ep: this.ep, half: this.half, full: this.full,
    captured: 0, capSq: -1, movedPiece: p
  };

  if (move.ep) {
    capSq = move.to + (this.turn === 'w' ? -8 : 8);
    captured = b[capSq];
    b[capSq] = 0;
  } else if (captured !== 0) {
    capSq = move.to;
  }
  u.captured = captured;
  u.capSq = capSq;

  b[move.from] = 0;
  b[move.to] = move.promo ? (move.promo | (p & 8)) : p;

  if (move.castle) {
    if (move.castle === 'K') { b[move.to + 1] = 0; b[move.to - 1] = (p & 8) | 4; }
    else { b[move.to - 2] = 0; b[move.to + 1] = (p & 8) | 4; }
  }

  this.ep = -1;
  if ((p & 7) === 1) {
    this.half = 0;
    if (Math.abs(move.to - move.from) === 16) this.ep = (move.from + move.to) / 2;
  } else if (captured !== 0) {
    this.half = 0;
  } else {
    this.half++;
  }

  var cr = this.castling;
  if (move.from === 4 || move.to === 4) cr &= ~3;
  if (move.from === 60 || move.to === 60) cr &= ~12;
  if (move.from === 7 || move.to === 7) cr &= ~1;
  if (move.from === 0 || move.to === 0) cr &= ~2;
  if (move.from === 63 || move.to === 63) cr &= ~4;
  if (move.from === 56 || move.to === 56) cr &= ~8;
  this.castling = cr;

  if (this.turn === 'b') this.full++;
  this.turn = (this.turn === 'w') ? 'b' : 'w';
  this.undoStack.push({ move: move, undo: u });
};

Position.prototype.unmake = function () {
  var entry = this.undoStack.pop();
  if (!entry) return;
  var move = entry.move, u = entry.undo;
  var b = this.board;
  b[move.from] = u.movedPiece;
  b[move.to] = 0;
  if (u.capSq >= 0 && u.captured !== 0) b[u.capSq] = u.captured;
  if (move.castle) {
    if (move.castle === 'K') { b[move.to + 1] = (u.movedPiece & 8) | 4; b[move.to - 1] = 0; }
    else { b[move.to - 2] = (u.movedPiece & 8) | 4; b[move.to + 1] = 0; }
  }
  this.castling = u.castling;
  this.ep = u.ep;
  this.half = u.half;
  this.full = u.full;
  this.turn = (this.turn === 'w') ? 'b' : 'w';
};

function moveToUci(m) {
  return sqName(m.from) + sqName(m.to) + (m.promo ? PROMO_LETTER[m.promo] : '');
}

function uciToMove(pos, uci) {
  var legal = pos.genMoves(true);
  for (var i = 0; i < legal.length; i++) {
    if (moveToUci(legal[i]) === uci) return legal[i];
  }
  return null;
}

/* ---------------- SAN ---------------- */

Position.prototype.san = function (move) {
  var b = this.board;
  var p = b[move.from];
  var type = p & 7;
  var s = '';
  if (move.castle) {
    s = (move.castle === 'K') ? 'O-O' : 'O-O-O';
  } else {
    var isCap = b[move.to] !== 0 || move.ep;
    if (type === 1) {
      if (isCap) s += FILES[move.from & 7] + 'x';
      s += sqName(move.to);
      if (move.promo) s += '=' + PIECE_CHAR[move.promo];
    } else {
      s += PIECE_CHAR[type];
      var others = [];
      var legal = this.genMoves(true);
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i];
        if (m.to === move.to && m.from !== move.from && b[m.from] === p) others.push(m);
      }
      if (others.length) {
        var sameFile = false, sameRank = false;
        for (i = 0; i < others.length; i++) {
          if ((others[i].from & 7) === (move.from & 7)) sameFile = true;
          if ((others[i].from >> 3) === (move.from >> 3)) sameRank = true;
        }
        if (!sameFile) s += FILES[move.from & 7];
        else if (!sameRank) s += ((move.from >> 3) + 1);
        else s += sqName(move.from);
      }
      if (isCap) s += 'x';
      s += sqName(move.to);
    }
  }
  this.make(move);
  if (this.inCheck()) s += this.genMoves(true).length > 0 ? '+' : '#';
  this.unmake();
  return s;
};

Position.prototype.sanToMove = function (sanStr) {
  var san = String(sanStr || '').trim()
    .replace(/[+#]+$/, '')
    .replace(/e\.p\.?$/i, '')
    .replace(/0/g, 'O');
  var legal = this.genMoves(true);
  var castle = san.match(/^(O-O-O|O-O)/);
  if (castle) {
    var wantLong = castle[1] === 'O-O-O';
    for (var i = 0; i < legal.length; i++) {
      if (legal[i].castle && ((legal[i].castle === 'Q') === wantLong)) return legal[i];
    }
    return null;
  }
  var m = san.match(/^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([QRBNqrbn]))?$/);
  if (!m) return null;
  var type = m[1] ? { K: 6, Q: 5, R: 4, B: 3, N: 2 }[m[1]] : 1;
  var fromFile = m[2] ? m[2].charCodeAt(0) - 97 : -1;
  var fromRank = m[3] ? m[3].charCodeAt(0) - 49 : -1;
  var target = nameToSq(m[4]);
  var promo = m[5] ? PROMO_TYPE[m[5].toLowerCase()] : 0;
  for (i = 0; i < legal.length; i++) {
    var mv = legal[i];
    if (mv.castle) continue;
    if (mv.to !== target) continue;
    if ((this.board[mv.from] & 7) !== type) continue;
    if (fromFile >= 0 && (mv.from & 7) !== fromFile) continue;
    if (fromRank >= 0 && (mv.from >> 3) !== fromRank) continue;
    if ((mv.promo || 0) !== promo) continue;
    return mv;
  }
  return null;
};

/* ---------------- 局面状态 ---------------- */

Position.prototype.insufficientMaterial = function () {
  var counts = {};
  var i, p, t;
  for (i = 0; i < 64; i++) {
    p = this.board[i];
    if (!p) continue;
    t = p & 7;
    if (t === 1 || t === 4 || t === 5) return false;
    counts[t] = (counts[t] || 0) + 1;
  }
  var minors = (counts[2] || 0) + (counts[3] || 0);
  if (minors <= 1) return true;
  if (minors === 2 && counts[3] === 2) {
    // 同色格双象
    var bishops = [];
    for (i = 0; i < 64; i++) {
      if ((this.board[i] & 7) === 3) bishops.push(((i >> 3) + (i & 7)) & 1);
    }
    if (bishops[0] === bishops[1]) return true;
  }
  return false;
};

Position.prototype.threefold = function (fenHistory) {
  // fenHistory: 对局中已出现过的局面 key 列表（含当前局面）
  var key = this.positionKey();
  var n = 0;
  for (var i = 0; i < fenHistory.length; i++) {
    if (fenHistory[i] === key) n++;
  }
  return n >= 3;
};

/* ---------------- PGN ---------------- */

function stripPgnNoise(s) {
  var out = '';
  var depth = 0, inBrace = false;
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (inBrace) { if (c === '}') inBrace = false; continue; }
    if (depth > 0) { if (c === '(') depth++; else if (c === ')') depth--; continue; }
    if (c === '{') { inBrace = true; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ';') { while (i < s.length && s[i] !== '\n') i++; continue; }
    out += c;
  }
  return out;
}

function parsePgn(text) {
  var headers = {};
  var lines = String(text || '').split(/\r?\n/);
  var i = 0;
  for (; i < lines.length; i++) {
    var hm = lines[i].match(/^\[(\w+)\s+"(.*)"\]\s*$/);
    if (hm) headers[hm[1]] = hm[2];
    else if (lines[i].trim() !== '') break;
  }
  var body = stripPgnNoise(lines.slice(i).join(' '));
  var tokens = body.split(/\s+/).filter(function (t) { return t.length > 0; });
  var startFen = headers['FEN'] || START_FEN;
  var pos;
  try { pos = new Position(startFen); }
  catch (e) { return { headers: headers, error: '初始 FEN 无效: ' + startFen }; }

  var sans = [], ucis = [], result = headers['Result'] || '*';
  for (var k = 0; k < tokens.length; k++) {
    var tk = tokens[k];
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tk)) { result = tk; continue; }
    if (/^\$\d+$/.test(tk)) continue;
    var glued = tk.match(/^\d+\.(\.\.)?(.*)$/);
    if (glued) { tk = glued[2]; if (!tk) continue; }
    if (/^\d+\.$/.test(tk)) continue;
    if (/^\(|\)$/.test(tk)) continue;
    var mv = pos.sanToMove(tk);
    if (!mv) {
      return {
        headers: headers, sans: sans, ucis: ucis, result: result,
        error: '第 ' + (sans.length + 1) + ' 手无法解析: "' + tk + '"（' + (sans.length + 1) + '... ' + tk + '）'
      };
    }
    sans.push(pos.san(mv));
    ucis.push(moveToUci(mv));
    pos.make(mv);
  }
  return { headers: headers, sans: sans, ucis: ucis, result: result, startFen: startFen, error: null };
}

function escapePgnComment(s) {
  return String(s || '').replace(/[{}\\]/g, ' ');
}

function buildPgn(headers, entries, result) {
  var out = '';
  var h = headers || {};
  var keys = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  for (var i = 0; i < keys.length; i++) {
    var v = h[keys[i]];
    if (v === undefined) {
      if (keys[i] === 'Result') v = result || '*';
      else if (keys[i] === 'Event') v = '棋局评价';
      else if (keys[i] === 'Site') v = '本地分析';
      else if (keys[i] === 'Date') v = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
      else if (keys[i] === 'Round') v = '-';
      else v = '?';
    }
    out += '[' + keys[i] + ' "' + String(v) + '"]\n';
  }
  var extraKeys = Object.keys(h).filter(function (k) { return keys.indexOf(k) < 0; });
  for (i = 0; i < extraKeys.length; i++) {
    out += '[' + extraKeys[i] + ' "' + String(h[extraKeys[i]]) + '"]\n';
  }
  out += '\n';
  var line = '';
  for (i = 0; i < entries.length; i++) {
    var e = entries[i];
    var isWhite = (i % 2 === 0);
    var token = '';
    if (isWhite) token = ((i >> 1) + 1) + '. ';
    token += e.san;
    if (e.nag) token += ' ' + e.nag;
    if (e.comment) token += ' {' + escapePgnComment(e.comment) + '}';
    if (line.length + token.length > 78) { out += line + '\n'; line = ''; }
    line += token + ' ';
  }
  out += line + (result || '*') + '\n';
  return out;
}

/* ---------------- perft（自测用） ---------------- */

function perft(pos, depth) {
  if (depth === 0) return 1;
  var moves = pos.genMoves(true);
  if (depth === 1) return moves.length;
  var n = 0;
  for (var i = 0; i < moves.length; i++) {
    pos.make(moves[i]);
    n += perft(pos, depth - 1);
    pos.unmake();
  }
  return n;
}

/* 某一方子力价值总和（用于妙手弃子判定） */
function materialOf(pos, black) {
  var s = 0;
  for (var i = 0; i < 64; i++) {
    var p = pos.board[i];
    if (!p) continue;
    if (IS_BLACK(p) === !!black) s += PIECE_VAL[p & 7];
  }
  return s;
}

/* 导出 */
if (typeof window !== 'undefined') {
  window.Position = Position;
  window.START_FEN = START_FEN;
  window.parsePgn = parsePgn;
  window.buildPgn = buildPgn;
  window.moveToUci = moveToUci;
  window.uciToMove = uciToMove;
  window.sqName = sqName;
  window.nameToSq = nameToSq;
  window.perft = perft;
  window.materialOf = materialOf;
  window.PIECE_VAL = PIECE_VAL;
  window.IS_BLACK = IS_BLACK;
  window.TYPE_OF = TYPE_OF;
  window.FILES = FILES;
  window.PROMO_TYPE = PROMO_TYPE;
}
