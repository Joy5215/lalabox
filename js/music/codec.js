/* ============================================================
 * music/codec.js — Song 与紧凑 base36 字符串互转
 * 用途：URL 分享（?s=）与云存储 value（≤1024 字节）
 * v3 起把三层乐器各自的「情绪 + 生成种子」写进去；
 * v4 再把乐器清单（类别 + 音色 + 音量）写进去，分享出去听到的就是同一支乐队；
 * v5 让每件乐器带自己的「曲调 + 种子」——曲调是单件的事，不再是全队一份。
 * v7 每件再带「起点 / 终点」（片段区间，半拍对齐），v6 及更早一律按整段播。
 * v8 每件再加一位「律动倍率」（0 = 标准、1 = 慢一半、2 = 快一倍）。
 * v9 把单段区间换成「段表」：每件在 v8 的 11 位之后再带段数（0 = 整段）+ 每段两位起止，
 *    一件可以出现在好几个位置；段数逐件变长，读的时候按位走，不能再用固定步长跳。
 * v1–v8 的老链接仍能解，老乐器的曲调/种子缺省，由 arrange 回落到 song.mood / song.seeds。
 * 暴露：LALA.CODEC
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var U = L.util, C = L.C;

  var SEED_MAX = 1679615;   /* 36^4 - 1 */
  /* 只能往末尾加：分享串里的类别是按下标写的，插在中间会让老链接错位。
     末位 'lead' = 主旋律轨，音色就是当初选的主音，和其它乐器一样带片段 / 音量 */
  var KINDS = ['drums', 'bass', 'chord', 'voice', 'amb', 'lead'];
  var MAX_BAND = 12;

  function enc2(n) {
    n = U.clamp(n | 0, 0, 1295);
    return U.pad2(U.b36(Math.floor(n / 36)) + U.b36(n % 36));
  }
  function dec2(s) { return U.unb36(s.charAt(0)) * 36 + U.unb36(s.charAt(1)); }

  /* 种子固定 4 位，够放 167 万种，也方便按位截断 */
  function enc4(n) {
    n = U.clamp(n | 0, 0, SEED_MAX);
    var s = '';
    for (var i = 0; i < 4; i++) {
      s = U.b36(n % 36) + s;
      n = Math.floor(n / 36);
    }
    return s;
  }
  function dec4(s) {
    var n = 0;
    for (var i = 0; i < 4; i++) {
      var v = U.unb36(s.charAt(i));
      if (v < 0) return -1;
      n = n * 36 + v;
    }
    return n;
  }

  function moodIdx(name) {
    var ms = L.TIMBRE.moods;
    for (var i = 0; i < ms.length; i++) if (ms[i].name === name) return i;
    return 0;
  }
  function moodAt(i) {
    var ms = L.TIMBRE.moods;
    return (i >= 0 && i < ms.length) ? ms[i].name : ms[0].name;
  }

  /* 只收干净的乐器：类别合法、音色在这类的目录里，最多 12 件 */
  function cleanBand(song) {
    return (song.band || []).filter(function (it) {
      return it && KINDS.indexOf(it.k) >= 0 && !!L.TIMBRE.nameOf(it.k, it.id);
    }).slice(0, MAX_BAND);
  }

  /* v9 每件 = 11 位基础字段（与 v8 同形）+ 段数（1 位，0 = 整段）+ 每段 2 位起止。
     基础字段里的「起点 / 终点」从 v9 起只写占位 0 / 32，真区间在段表里，
     这样同一套前缀解析还能给 v7 / v8 用。
     曲调与种子缺省时写回落值，保证读回来和本机听到的一致 */
  function encodeBand(song, withNotes) {
    var band = cleanBand(song);
    var s = enc2(band.length);
    var moods = song.mood || song.feel || L.GROOVE.feelDefaults();
    var seeds = song.seeds || L.GROOVE.seedDefaults();
    /* 段数预算：每件最多 U.MAX_CLIPS 段，整串最多 32 段。
       先到先得，但要给后面还没写的件各留 1 段，否则会生成一段都写不下的串 */
    var budget = 32;
    band.forEach(function (it, bi) {
      var ids = L.TIMBRE.list(it.k).map(function (x) { return x.id; });
      var id = Math.max(0, ids.indexOf(it.id));
      var vol = U.clamp(Math.round((it.vol === undefined ? 0.8 : it.vol) * 9), 1, 9);
      /* 氛围与主旋律没有曲调与种子，写固定值占位，保证字段宽度不变 */
      var isAmb = it.k === 'amb' || it.k === 'lead';
      var mood = isAmb ? '晴天'
        : ((it.mood && L.TIMBRE.mood(it.mood)) ? it.mood : (moods[it.k] || '晴天'));
      var seed = isAmb ? 101 : U.clamp(it.seed || seeds[it.k] || 101, 1, SEED_MAX);
      var rate = U.bandRate(it);
      s += U.b36(KINDS.indexOf(it.k)) + U.b36(id) + U.b36(vol)
        + U.b36(moodIdx(mood)) + enc4(seed)
        + '0' + U.b36(32)
        + U.b36(rate === 0.5 ? 1 : rate === 2 ? 2 : 0);

      var clips = U.bandClips(it);
      var singleFull = clips.length === 1 && U.isFullWindow(clips[0]) === true;
      /* 整段但带音符（lead 物化后整段）不能折成 0，否则旋律会丢 */
      var fullHasNotes = singleFull && clips[0].notes && clips[0].notes.length;
      if (singleFull && !fullHasNotes) {
        s += '0';
        return;
      }
      var left = band.length - bi - 1;
      var room = Math.max(1, budget - left);
      var take = Math.min(clips.length, U.MAX_CLIPS, room);
      var use = clips.slice(0, take);
      /* 段数被截断时用首末包住：宁可多响一点，也不要悄悄丢掉后面的段 */
      if (take < clips.length && take === 1) {
        use = [{ from: clips[0].from, to: clips[clips.length - 1].to }];
      }
      budget -= use.length;
      s += U.b36(use.length);
      use.forEach(function (c) {
        s += U.b36(Math.round(c.from * 2)) + U.b36(Math.round(c.to * 2));
        /* v10：lead 片段把自己的音符也写进去（相对 from、半拍量化） */
        if (withNotes && it.k === 'lead') {
          var ns = c.notes || [];
          s += U.b36(ns.length);
          var prevOn = 0;
          ns.forEach(function (n) {
            var on = Math.round(n.b * 2);
            var d = U.clamp(Math.round(n.d * 2), 1, 35);
            var m = U.clamp(n.m, 36, 99) - 36;
            s += U.b36(U.clamp(on - prevOn, 0, 35));
            s += U.b36(d);
            s += enc2(m);
            prevOn = on;
          });
        }
      });
    });
    return s;
  }

  function encode(song) {
    var mood = song.mood || song.feel || L.GROOVE.feelDefaults();
    var seeds = song.seeds || L.GROOVE.seedDefaults();

    /* v9 起每件带自己的段表；v10（'a'）在 lead 片段里再带音符，让旋律跟着片段走 */
    var withNotes = U.leadHasNotes(song);
    var s = withNotes ? 'a' : '9';
    s += U.b36(moodIdx(mood.drums));
    s += U.b36(moodIdx(mood.bass));
    s += U.b36(moodIdx(mood.chord));
    s += enc4(seeds.drums);
    s += enc4(seeds.bass);
    s += enc4(seeds.chord);
    s += encodeBand(song, withNotes);
    s += U.b36(song.tonic);
    s += song.mode === 'major' ? '0' : '1';
    /* v6 起带上速度：随机旋律有 68~138 BPM，不写进去分享出去就全变 96 */
    s += enc2(U.clamp(song.bpm || C.BPM, 30, 260));

    /* 主旋律统一写扁平视图：没编辑过就是 8 拍乐句，编辑过是 16 拍完整旋律 */
    var mel = U.leadNotes(song);
    var n = Math.min(mel.length, 64);
    s += U.pad2(U.b36(Math.floor(n / 36)) + U.b36(n % 36));
    for (var i = 0; i < 4; i++) s += U.b36(song.bars[i] % 12);

    var prev = 0;
    for (var k = 0; k < n; k++) {
      var nt = mel[k];
      var on = Math.round(nt.b * 2);
      var d = U.clamp(Math.round(nt.d * 2), 1, 35);
      var m = U.clamp(nt.m, 36, 99) - 36;
      s += U.b36(U.clamp(on - prev, 0, 35));
      s += U.b36(d);
      s += enc2(m);
      prev = on;
    }
    return s;
  }

  /* v1 头部是一位「风格」，v2 是三位「模板索引」，都已经没有意义，
     读进来统一换成默认情绪 + 默认种子；老链接没有乐器清单，乐队是空的 */
  function readV1(str, p) {
    var si = U.unb36(str.charAt(p));
    if (si < 0 || si > 3) return null;
    return {
      mood: L.GROOVE.feelDefaults(), seeds: L.GROOVE.seedDefaults(),
      band: [], next: p + 1
    };
  }

  function readV2(str, p) {
    for (var i = 0; i < 3; i++) if (U.unb36(str.charAt(p + i)) < 0) return null;
    return {
      mood: L.GROOVE.feelDefaults(), seeds: L.GROOVE.seedDefaults(),
      band: [], next: p + 3
    };
  }

  function readV3(str, p) {
    var mood = {
      drums: moodAt(U.unb36(str.charAt(p))),
      bass: moodAt(U.unb36(str.charAt(p + 1))),
      chord: moodAt(U.unb36(str.charAt(p + 2)))
    };
    var sd = dec4(str.substr(p + 3, 4));
    var sb = dec4(str.substr(p + 7, 4));
    var sc = dec4(str.substr(p + 11, 4));
    if (sd < 0 || sb < 0 || sc < 0) return null;
    return {
      mood: mood,
      seeds: { drums: sd, bass: sb, chord: sc },
      band: [],
      next: p + 15
    };
  }

  /* v4 = v3 头部 + 乐器清单（件数 + 每件 3 位：类别/音色/音量） */
  function readV4(str, p) {
    var head = readV3(str, p);
    if (!head) return null;
    var q = head.next;
    var n = dec2(str.substr(q, 2));
    if (!(n >= 0 && n <= MAX_BAND)) return null;
    q += 2;

    var band = [];
    for (var i = 0; i < n; i++) {
      var k = U.unb36(str.charAt(q));
      var id = U.unb36(str.charAt(q + 1));
      var vol = U.unb36(str.charAt(q + 2));
      q += 3;
      if (k < 0 || k >= KINDS.length || id < 0 || vol < 0) return null;
      var kind = KINDS[k];
      var list = L.TIMBRE.list(kind);
      if (!list.length) return null;
      band.push({
        k: kind,
        id: (list[id] || list[0]).id,
        vol: U.clamp(vol / 9, 0.1, 1)
      });
    }
    head.band = band;
    head.next = q;
    return head;
  }

  /* v5 / v6 = v3 头部 + 乐器清单（件数 + 每件 8 位：类别/音色/音量/曲调/种子）
     v7 在同一份清单上每件再追加起点 / 终点（各 1 位，半拍）
     v8 再加律动倍率；v9 换成变长段表（withClips），每件读过 11 位再读段数 */
  function readBand(str, p, size, withClips, withNotes) {
    var head = readV3(str, p);
    if (!head) return null;
    var q = head.next;
    var n = dec2(str.substr(q, 2));
    if (!(n >= 0 && n <= MAX_BAND)) return null;
    q += 2;

    var band = [];
    var totalClips = 0;
    for (var i = 0; i < n; i++) {
      var base = q;
      var k = U.unb36(str.charAt(base));
      var id = U.unb36(str.charAt(base + 1));
      var vol = U.unb36(str.charAt(base + 2));
      var mi = U.unb36(str.charAt(base + 3));
      var seed = dec4(str.substr(base + 4, 4));
      q = base + size;
      if (k < 0 || k >= KINDS.length || id < 0 || vol < 0) return null;
      if (mi < 0 || mi >= L.TIMBRE.moods.length || seed <= 0) return null;
      var kind = KINDS[k];
      var list = L.TIMBRE.list(kind);
      if (!list.length) return null;
      var item = {
        k: kind,
        id: (list[id] || list[0]).id,
        vol: U.clamp(vol / 9, 0.1, 1)
      };
      /* 氛围 / 主旋律没有曲调与种子：编码时写固定值占位，读回来别带这两个字段，
         免得脏数据进 arrange 的缓存 key */
      if (kind !== 'amb' && kind !== 'lead') {
        item.mood = moodAt(mi);
        item.seed = seed;
      }
      if (size >= 10) {
        var bf = U.unb36(str.charAt(base + 8));
        var bt = U.unb36(str.charAt(base + 9));
        if (bf < 0 || bt < 0 || bt > 32 || bt <= bf) return null;
        /* v9 的这两位只是占位，真区间在段表里；整段不落字段，老数据的形状保持一致 */
        if (!withClips && (bf > 0 || bt < 32)) {
          item.from = bf / 2;
          item.to = bt / 2;
        }
      }
      if (size >= 11) {
        var rate = U.unb36(str.charAt(base + 10));
        if (rate < 0 || rate > 2) return null;
        if (rate === 1) item.rate = 0.5;
        else if (rate === 2) item.rate = 2;
      }
      if (withClips) {
        var cnt = U.unb36(str.charAt(q));
        q += 1;
        if (cnt < 0 || cnt > U.MAX_CLIPS) return null;
        totalClips += cnt;
        if (totalClips > 32) return null;
        if (cnt > 0) {
          var clips = [];
          for (var ci = 0; ci < cnt; ci++) {
            var cf = U.unb36(str.charAt(q));
            var ct = U.unb36(str.charAt(q + 1));
            q += 2;
            if (cf < 0 || ct < 0 || ct > 32 || ct <= cf) return null;
            /* 段表必须按起点排好且互不重叠，脏串直接拒掉 */
            if (ci && cf < clips[ci - 1].to) return null;
            var clip = { from: cf / 2, to: ct / 2 };
            /* v10：lead 片段读回自己的音符 */
            if (withNotes && kind === 'lead') {
              var nn = U.unb36(str.charAt(q));
              q += 1;
              if (nn < 0 || nn > 64) return null;
              var prevOn = 0;
              var nlist = [];
              for (var ni = 0; ni < nn; ni++) {
                var dOn = U.unb36(str.charAt(q)); q += 1;
                var dDur = U.unb36(str.charAt(q)); q += 1;
                var m = dec2(str.substr(q, 2)); q += 2;
                if (dOn < 0 || dDur < 1) return null;
                var midi = m + 36;
                if (midi < 36 || midi > 99) return null;
                var on = prevOn + dOn;
                nlist.push({ b: on / 2, d: dDur / 2, m: midi });
                prevOn = on;
              }
              if (nlist.length) clip.notes = nlist;
            }
            clips.push(clip);
          }
          item.clips = clips;
        }
      }
      band.push(item);
    }
    head.band = band;
    head.next = q;
    return head;
  }

  function readV5(str, p) { return readBand(str, p, 8); }

  function decode(str) {
    if (!str || typeof str !== 'string') return null;
    /* 段表是变长的：满编 12 件、每件 8 段时约 400 字符，上限留到 768 */
    if (str.length < 10 || str.length > 768) return null;
    if (!/^[0-9a-z]+$/.test(str)) return null;

    try {
      var p = 0;
      var ver = str.charAt(p++);
      var head;
      if (ver === '1') head = readV1(str, p);
      else if (ver === '2') head = readV2(str, p);
      else if (ver === '3') head = readV3(str, p);
      else if (ver === '4') head = readV4(str, p);
      /* v6 的乐器清单与 v5 同构，差别只在 mode 之后多两拍速度；
         v7 每件再多两位「起点 / 终点」，v8 再加律动，v9 换变长段表，
         v10（'a'）在 lead 片段里再带音符 */
      else if (ver === '5' || ver === '6') head = readV5(str, p);
      else if (ver === '7') head = readBand(str, p, 10);
      else if (ver === '8') head = readBand(str, p, 11);
      else if (ver === '9') head = readBand(str, p, 11, true);
      else if (ver === 'a') head = readBand(str, p, 11, true, true);
      else return null;
      if (!head) return null;
      p = head.next;

      var tonic = U.unb36(str.charAt(p++));
      if (tonic < 0 || tonic > 11) return null;

      var modeChar = str.charAt(p++);
      if (modeChar !== '0' && modeChar !== '1') return null;

      var bpm = C.BPM;
      if (ver !== '1' && ver !== '2' && ver !== '3' && ver !== '4' && ver !== '5') {
        bpm = dec2(str.substr(p, 2));
        p += 2;
        if (!(bpm >= 30 && bpm <= 260)) return null;
      }

      var n = dec2(str.substr(p, 2));
      p += 2;
      if (!(n >= 0 && n <= 64)) return null;

      var bars = [];
      for (var i = 0; i < 4; i++) {
        var pc = U.unb36(str.charAt(p++));
        if (pc < 0 || pc > 11) return null;
        bars.push(pc);
      }

      var notes = [], prev = 0;
      for (var k = 0; k < n; k++) {
        var dOn = U.unb36(str.charAt(p++));
        if (dOn < 0) return null;
        var dDur = U.unb36(str.charAt(p++));
        if (dDur < 1) return null;
        var m = dec2(str.substr(p, 2));
        p += 2;
        var midi = m + 36;
        if (midi < 36 || midi > 99) return null;
        var on = prev + dOn;
        notes.push({ b: on / 2, d: dDur / 2, m: midi });
        prev = on;
      }

      return {
        v: ver === 'a' ? 10
          : (ver === '9' ? 9
            : (ver === '8' ? 8
              : (ver === '7' ? 7 : (ver === '6' ? 6 : (ver === '5' ? 5 : (ver === '4' ? 4 : 3)))))),
        bpm: bpm, tonic: tonic,
        mode: modeChar === '0' ? 'major' : 'minor',
        mood: head.mood, seeds: head.seeds, band: head.band,
        bars: bars, notes: notes
      };
    } catch (e) {
      return null;
    }
  }

  L.CODEC = { encode: encode, decode: decode };
})();
