/* 纯逻辑模块冒烟测试：node tools/smoke-test.js
 * 只加载不依赖 DOM 的模块，验证成曲 / 生成 / 编解码 / 音色的契约。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = {
  window: {},
  console: console,
  performance: { now: () => Date.now() },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

['js/core/utils.js', 'js/music/groove.js', 'js/music/arrange.js',
  'js/music/codec.js', 'js/music/timbres.js', 'js/music/styles.js',
  'js/music/compose.js', 'js/audio/ambience.js']
  .forEach(function (file) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  });

const L = sandbox.window.LALA;
const KINDS = ['drums', 'bass', 'chord'];
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}
const json = (x) => JSON.stringify(x);

const raw = [
  { b: 0, d: 1, m: 69 }, { b: 1, d: 0.5, m: 72 }, { b: 1.5, d: 0.5, m: 74 },
  { b: 2, d: 1, m: 72 }, { b: 3, d: 1, m: 69 }, { b: 4, d: 1, m: 67 }
];

console.log('[compose]');
const song = L.COMPOSE.buildSong(raw);
check('notes 数量保持', song.notes.length === raw.length, song.notes.length);
check('4 小节和弦', song.bars.length === 4);
check('调性在范围内', song.tonic >= 0 && song.tonic <= 11, song.tonic);
check('音高落在 48~96', song.notes.every(function (n) { return n.m >= 48 && n.m <= 96; }));
check('带三层情绪', KINDS.every(function (k) { return !!song.mood[k]; }));
check('带三层种子', KINDS.every(function (k) { return song.seeds[k] > 0; }));
check('新歌乐队是空的', Array.isArray(song.band) && song.band.length === 0);
check('两次成曲种子不同', (function () {
  const s2 = L.COMPOSE.buildSong(raw);
  return KINDS.some(function (k) { return s2.seeds[k] !== song.seeds[k]; });
})());

console.log('[no-mic]');
const deg = L.COMPOSE.parseDegrees('1 2 3 5 3 2 1');
check('简谱解析出 7 个音', deg.notes.length === 7 && deg.bad === '');
check('简谱 0 是停顿', (function () {
  const p = L.COMPOSE.parseDegrees('1 0 3');
  return p.notes.length === 2 && p.notes[1].b === 2 && p.notes[1].m === 64;
})());
check('简谱连写也认', L.COMPOSE.parseDegrees('1235321').notes.length === 7);
check('非法字符被记下', L.COMPOSE.parseDegrees('1 a 2').bad === 'a');
check('最多 16 拍', (function () {
  const p = L.COMPOSE.parseDegrees('1'.repeat(20));
  return p.notes.length === 16 && p.truncated;
})());
check('简谱能直接成曲', (function () {
  const s = L.COMPOSE.buildSong(deg.notes);
  return s.notes.length === 7 && s.bars.length === 4;
})());

const batch1 = L.COMPOSE.randomBatch(4242);
check('随机给三段', batch1.length === 3);
check('三段感觉各不相同', (function () {
  const names = batch1.map(function (c) { return c.mood; });
  return names.every(function (n) { return !!n; }) && new Set(names).size === 3;
})(), batch1.map(function (c) { return c.mood; }).join(' / '));
check('每个候选都带感觉和简谱', batch1.every(function (c) {
  return c.mood && c.degrees.length === c.notes.length;
}));
check('三段节奏不雷同', new Set(batch1.map(function (c) {
  return c.notes.map(function (n) { return n.d; }).join(',');
})).size >= 2);
/* 允许中间留白，所以音符时值加起来可能略少于 8 拍，但必须收在 8 拍内 */
check('每段都收在 8 拍内', batch1.every(function (c) {
  const last = c.notes[c.notes.length - 1];
  const end = last.b + last.d;
  return end <= 8 + 1e-9 && end >= 6;
}));
check('随机旋律同种子可复现', json(batch1) === json(L.COMPOSE.randomBatch(4242)));
check('换种子换一批', json(batch1) !== json(L.COMPOSE.randomBatch(4243)));
check('随机旋律都在 C 大调音阶内', batch1.every(function (c) {
  return c.notes.every(function (n) {
    return n.m >= 55 && n.m <= 78 && [0, 2, 4, 5, 7, 9, 11].indexOf(((n.m % 12) + 12) % 12) >= 0;
  });
}));
/* 随机旋律自带调性，成曲时不能被识别器改写音高（否则试听和结果不一样） */
check('三段都能直接成曲且不改音', batch1.every(function (c) {
  const s = L.COMPOSE.buildSong(c.notes, { tonic: c.tonic, mode: c.mode });
  return s.notes.length === c.notes.length && s.bars.length === 4
    && s.tonic === c.tonic && s.mode === c.mode
    && json(s.notes.map(function (n) { return n.m; }))
      === json(c.notes.map(function (n) { return n.m; }));
}));

console.log('[style]');
const S = L.STYLE;
check('有四个氛围', S.vibes.length === 4, S.vibes.length);
check('有八种风格', S.styles.length === 8, S.styles.length);
check('氛围与风格 id 唯一', (function () {
  const v = S.vibes.map(function (x) { return x.id; });
  const s = S.styles.map(function (x) { return x.id; });
  return new Set(v).size === v.length && new Set(s).size === s.length;
})());
check('每种风格都有大调与小调走向', S.styles.every(function (s) {
  return s.pools && s.pools.major && s.pools.major.length && s.pools.minor && s.pools.minor.length;
}));
check('走向只引用 0-6 级', S.styles.every(function (s) {
  return ['major', 'minor'].every(function (m) {
    return s.pools[m].every(function (p) {
      return p.length === 4 && p.every(function (d) { return d >= 0 && d <= 6; });
    });
  });
}));
check('风格都指向已有曲调', S.styles.every(function (s) { return !!L.GROOVE.feels[s.mood]; }),
  S.styles.filter(function (s) { return !L.GROOVE.feels[s.mood]; }).map(function (s) { return s.name; }).join(','));
check('风格的速度区间合理', S.styles.every(function (s) {
  return s.bpm[0] >= 60 && s.bpm[1] <= 160 && s.bpm[0] < s.bpm[1];
}));
check('planFor 缺省不掉参数', (function () {
  const p = S.planFor('none', 'none');
  return !!p.scale && !!p.contour && p.bpm > 0 && p.mode && p.pools;
})());
check('planFor 手感都在 0~1', S.vibes.every(function (v) {
  return S.styles.every(function (s) {
    const f = S.planFor(v.id, s.id).feels;
    return ['energy', 'density', 'sync', 'space'].every(function (k) {
      return f[k] > 0 && f[k] <= 1;
    });
  });
}));
check('氛围决定明暗', (function () {
  const heal = S.planFor('heal', 'folk');
  const blue = S.planFor('blue', 'folk');
  return heal.scale !== blue.scale && heal.mode !== blue.mode;
})());
check('躁动比忧郁密', (function () {
  const a = S.planFor('wild', 'rock').feels;
  const b = S.planFor('blue', 'lofi').feels;
  return a.density > b.density && a.space < b.space;
})());
check('每个氛围都能掷出曲调', S.vibes.every(function (v) {
  const list = S.moodsOfVibe(v.id);
  return list.length > 0 && list.every(function (m) { return !!L.GROOVE.feels[m]; });
}), S.vibes.map(function (v) { return v.name + ':' + S.moodsOfVibe(v.id).join('/'); }).join(' '));
check('掷出的曲调一定在氛围集合内', S.vibes.every(function (v) {
  const list = S.moodsOfVibe(v.id);
  for (let i = 0; i < 40; i++) {
    if (list.indexOf(S.rollMood(v.id, '晴天')) < 0) return false;
  }
  return true;
}));
check('未知氛围回落到兜底曲调', (function () {
  return S.rollMood('nope', '深夜') === '深夜'
    && S.rollMood('', '晴天') === '晴天'
    && S.moodsOfVibe('nope').length === 0;
})());

console.log('[melody]');
const mBatch = L.COMPOSE.melodyBatch(5678, { vibe: 'heal', style: 'folk' });
check('氛围+风格给三段', mBatch.length === 3);
check('每段都带风格与氛围', mBatch.every(function (c) {
  return c.style === '民谣' && c.vibe === '治愈' && c.bpm > 0;
}), json(mBatch.map(function (c) { return [c.style, c.vibe, c.bpm]; })));
check('同组合下速度拉开', new Set(mBatch.map(function (c) { return c.bpm; })).size >= 2,
  mBatch.map(function (c) { return c.bpm; }).join(','));
check('同组合下轮廓拉开', new Set(mBatch.map(function (c) { return c.contour; })).size >= 2,
  mBatch.map(function (c) { return c.contour; }).join(','));
check('旋律段不雷同', (function () {
  const sig = mBatch.map(function (c) {
    return c.notes.map(function (n) { return n.m; }).join(',');
  });
  return new Set(sig).size === 3;
})());
check('随机风格时三段风格不同', (function () {
  const b = L.COMPOSE.melodyBatch(777, { vibe: '', style: '' });
  return new Set(b.map(function (c) { return c.styleId; })).size === 3;
})(), L.COMPOSE.melodyBatch(777, {}).map(function (c) { return c.style; }).join(' / '));
check('随机氛围时三段氛围不同', (function () {
  const b = L.COMPOSE.melodyBatch(778, { vibe: '', style: 'rock' });
  return new Set(b.map(function (c) { return c.vibeId; })).size === 3;
})());
check('同种子可复现', json(L.COMPOSE.melodyBatch(5678, { vibe: 'heal', style: 'folk' })) === json(mBatch));
check('换种子换一批', json(L.COMPOSE.melodyBatch(5679, { vibe: 'heal', style: 'folk' })) !== json(mBatch));
check('每段收在 8 拍内', mBatch.every(function (c) {
  const last = c.notes[c.notes.length - 1];
  return last.b + last.d <= 8 + 1e-9;
}));
/* 音符必须落在自己声明的调内，否则试听和结果页会听到两种音 */
check('音符落在声明的调内', mBatch.concat(L.COMPOSE.melodyBatch(999, {}))
  .every(function (c) {
    const sc = c.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
    return c.notes.every(function (n) {
      return sc.indexOf((((n.m - c.tonic) % 12) + 12) % 12) >= 0;
    });
  }));

/* 候选带上速度与走向后，成曲要原样接住 */
const melodySong = L.COMPOSE.buildSong(mBatch[0].notes, {
  tonic: mBatch[0].tonic, mode: mBatch[0].mode, bpm: mBatch[0].bpm,
  pools: mBatch[0].pools, moodName: mBatch[0].mood
});
check('成曲接住速度', melodySong.bpm === mBatch[0].bpm, melodySong.bpm + ' vs ' + mBatch[0].bpm);
check('成曲接住风格曲调', melodySong.mood.drums === mBatch[0].mood
  && melodySong.mood.chord === mBatch[0].mood, json(melodySong.mood));
check('成曲走向取自风格池', mBatch[0].pools.some(function (p) {
  const pcs = p.map(function (d) {
    const sc = mBatch[0].mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
    return (mBatch[0].tonic + sc[d % 7]) % 12;
  });
  return pcs.join() === melodySong.bars.join();
}), melodySong.bars.join(','));
check('成曲不改候选音高', json(melodySong.notes.map(function (n) { return n.m; }))
  === json(mBatch[0].notes.map(function (n) { return n.m; })));

console.log('[typed-variation]');
const typedSrc = L.COMPOSE.parseDegrees('1 2 3 5 3 2 1').notes;
const tBatch = L.COMPOSE.typedBatch(typedSrc, 1234);
check('简谱变奏给三段', tBatch.length === 3);
check('每段保留音数', tBatch.every(function (c) { return c.notes.length === typedSrc.length; }),
  tBatch.map(function (c) { return c.notes.length; }).join(','));
check('每段都收在 16 拍内', tBatch.every(function (c) {
  const last = c.notes[c.notes.length - 1];
  return last.b + last.d <= 16 + 1e-9;
}));
check('每段都有简谱标注', tBatch.every(function (c) {
  return c.degrees.length === c.notes.length && c.degrees.every(function (d) { return d >= 1 && d <= 7; });
}));
check('三段节奏不雷同', new Set(tBatch.map(function (c) {
  return c.notes.map(function (n) { return n.d; }).join(',');
})).size >= 2);
check('三段音调不雷同', new Set(tBatch.map(function (c) {
  return c.tonic + c.mode;
})).size >= 2);
check('简谱变奏同种子可复现', json(L.COMPOSE.typedBatch(typedSrc, 1234)) === json(tBatch));
check('半拍档确实更短', (function () {
  const half = L.COMPOSE.typedBatch(typedSrc, 55, { view: 'half' })[0];
  const long = L.COMPOSE.typedBatch(typedSrc, 55, { view: 'long' })[0];
  const avg = function (c) {
    return c.notes.reduce(function (s, n) { return s + n.d; }, 0) / c.notes.length;
  };
  return avg(half) < avg(long);
})());
check('节奏档名可读', ['auto', 'straight', 'half', 'long'].every(function (k) {
  return !!L.COMPOSE.views[k];
}));
check('换一版保留节奏档与速度', (function () {
  const one = tBatch[0];
  const rolled = L.COMPOSE.typedRoll(typedSrc, 4321, { view: one.view, bpm: one.bpm, mode: one.mode });
  return rolled.view === one.view && rolled.bpm === one.bpm && rolled.mode === one.mode
    && rolled.notes.length > 1;
})());
/* 音级走向不变：音程形状一致，才叫「还是他写的那条调子」 */
check('变奏保留音程走向', (function () {
  /* 允许大小调改写带来的半音差，只比对「上行/下行」的方向 */
  const dir = function (c) {
    return c.notes.slice(1).map(function (n, i) {
      return n.m > c.notes[i].m ? 1 : (n.m < c.notes[i].m ? -1 : 0);
    }).join(',');
  };
  const want = (function () {
    const semis = typedSrc.map(function (n) {
      return [0, 2, 4, 5, 7, 9, 11].indexOf(((n.m % 12) + 12) % 12);
    });
    return semis.slice(1).map(function (d, i) {
      return d > semis[i] ? 1 : (d < semis[i] ? -1 : 0);
    }).join(',');
  })();
  return tBatch.every(function (c) { return dir(c) === want; });
})(), tBatch.map(function (c) { return c.notes.map(function (n) { return n.m; }).join(','); }).join(' | '));

console.log('[groove]');
KINDS.forEach(function (kind) {
  const gen = L.GROOVE[kind];
  const a = gen(4242, '晴天');
  check(kind + ' 有事件', a.length > 0, a.length);
  check(kind + ' 同种子可复现', json(a) === json(gen(4242, '晴天')));
  check(kind + ' 拍位落在 0~16',
    a.every(function (e) { return e.b >= 0 && e.b < 16; }));
  check(kind + ' 力度在 0~1',
    a.every(function (e) { return e.v > 0 && e.v <= 1; }));

  let changed = 0;
  for (let s = 1; s <= 12; s++) {
    if (json(gen(s, '晴天')) !== json(a)) changed++;
  }
  check(kind + ' 换种子基本都会变', changed >= 10, changed + '/12');
});

/* 同一种子下，情绪确实会改手感 */
function avgLen(kind, mood, n) {
  let sum = 0;
  for (let s = 1; s <= n; s++) sum += L.GROOVE[kind](s, mood).length;
  return sum / n;
}
check('热血比深夜密（鼓）', avgLen('drums', '热血', 10) > avgLen('drums', '深夜', 10) * 1.2,
  avgLen('drums', '热血', 10).toFixed(1) + ' vs ' + avgLen('drums', '深夜', 10).toFixed(1));
check('热血比深夜密（和音）', avgLen('chord', '热血', 10) >= avgLen('chord', '深夜', 10),
  avgLen('chord', '热血', 10).toFixed(1) + ' vs ' + avgLen('chord', '深夜', 10).toFixed(1));
check('未知情绪不报错', L.GROOVE.drums(7, '不存在').length > 0);

console.log('[arrange]');
/* 伴奏只从 song.band 来：每件乐器一条事件，bi 指回自己在清单里的下标 */
const bandSong = Object.assign({}, song, {
  _arr: null,
  band: [
    { k: 'drums', id: 'acoustic', vol: 0.8 },
    { k: 'bass', id: 'finger', vol: 0.8 },
    { k: 'chord', id: 'piano', vol: 0.8 }
  ]
});
const evs = L.ARRANGE.arrange(bandSong);
check('有事件产出', evs.length > 20, evs.length);
check('含主旋律', evs.some(function (e) { return e.t === 'lead'; }));
check('含鼓组', evs.some(function (e) { return e.t === 'kick'; }));
check('贝斯有音高', evs.some(function (e) { return e.t === 'bass' && e.m > 0; }));
check('和音有和弦音组',
  evs.some(function (e) { return e.t === 'chord' && e.ms && e.ms.length >= 1; }));
check('事件按拍排序', evs.every(function (e, i) { return i === 0 || evs[i - 1].b <= e.b; }));
check('伴奏事件都能指回乐器', evs.every(function (e) {
  return e.t === 'lead' || (bandSong.band[e.bi] && bandSong.band[e.bi].k);
}));
check('空乐队只出主旋律', L.ARRANGE.arrange(Object.assign({}, song, { band: [], _arr: null }))
  .every(function (e) { return e.t === 'lead'; }));
/* 主旋律已经和别的乐器同构：事件带 bi，静音 / 片段都走同一套口径 */
check('lead 轨的事件指回自己', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{ k: 'lead', id: 'piano', vol: 0.8 }]
  });
  const list = L.ARRANGE.arrange(s).filter(function (e) { return e.t === 'lead'; });
  return list.length > 0 && list.every(function (e) { return e.bi === 0; });
})());
check('lead 轨静音后不出事件', (function () {
  const it = { k: 'lead', id: 'piano', vol: 0.8 };
  const on = L.ARRANGE.arrange(Object.assign({}, song, { _arr: null, band: [it] }))
    .filter(function (e) { return e.t === 'lead'; }).length;
  const off = L.ARRANGE.arrange(Object.assign({}, song, {
    _arr: null, band: [Object.assign({}, it, { mute: true })]
  })).filter(function (e) { return e.t === 'lead'; }).length;
  return on > 0 && off === 0;
})());
check('lead 轨片段只出段内事件', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{ k: 'lead', id: 'guitar', vol: 0.8, clips: [{ from: 8, to: 12 }] }]
  });
  const list = L.ARRANGE.arrange(s).filter(function (e) { return e.t === 'lead'; });
  return list.length > 0 && list.every(function (e) { return e.b >= 8 - 1e-6 && e.b < 12; });
})());
/* 同一层两件：曲调与种子各管各的，事件不共享 */
check('同层两件各自成律动', (function () {
  const two = Object.assign({}, song, {
    _arr: null,
    band: [
      { k: 'chord', id: 'piano', vol: 0.8, mood: '温柔', seed: 1234 },
      { k: 'chord', id: 'piano', vol: 0.8, mood: '热血', seed: 98765 }
    ]
  });
  const list = L.ARRANGE.arrange(two);
  const a = json(list.filter(function (e) { return e.bi === 0; }));
  const b = json(list.filter(function (e) { return e.bi === 1; }));
  return a.length > 2 && b.length > 2 && a !== b;
})());
check('同种子编曲可复现',
  json(L.ARRANGE.arrange(Object.assign({}, bandSong, { _arr: null }))) === json(evs));
check('换种子编曲会变', (function () {
  const other = Object.assign({}, bandSong, {
    _arr: null,
    seeds: { drums: song.seeds.drums + 1, bass: song.seeds.bass, chord: song.seeds.chord }
  });
  return json(L.ARRANGE.arrange(other)) !== json(evs);
})());
/* 换种子不能只挪拍位：和弦的转位 / 音区也要跟着变 */
check('和弦音区与转位随种子变', (function () {
  const ms = [100, 101, 102].map(function (s) {
    return json(L.ARRANGE.chordMidis(0, song, L.GROOVE.variant(s)));
  });
  return ms[0] !== ms[1] && ms[1] !== ms[2] && ms[0] !== ms[2];
})());

/* 「换一个」不能又是同一个开头：连续 20 次开头和弦都必须和上一版不同 */
check('换一个开头和弦必变', (function () {
  let prev = L.COMPOSE.chooseChords(raw, 9, 'minor');
  for (let i = 0; i < 20; i++) {
    const next = L.COMPOSE.rollChords(raw, 9, 'minor', prev);
    if (!next || next.length !== 4) return false;
    if (next[0] === prev[0]) return false;
    if (next.join() === prev.join()) return false;
    prev = next;
  }
  return true;
})());

console.log('[clips]');
const U = L.util;
check('缺省是整段', (function () {
  const c = U.bandClips({ k: 'drums', id: 'acoustic' });
  return c.length === 1 && c[0].from === 0 && c[0].to === 16;
})());
check('老 from/to 折成一段', (function () {
  const c = U.bandClips({ from: 4, to: 12 });
  return c.length === 1 && c[0].from === 4 && c[0].to === 12;
})());
check('clips 优先于 from/to', (function () {
  const c = U.bandClips({ from: 0, to: 8, clips: [{ from: 8, to: 16 }] });
  return c.length === 1 && c[0].from === 8 && c[0].to === 16;
})());
check('多段按起点排序', (function () {
  const c = U.bandClips({ clips: [{ from: 8, to: 12 }, { from: 0, to: 4 }] });
  return c.length === 2 && c[0].from === 0 && c[1].from === 8;
})());
check('重叠被压平、对齐半拍', (function () {
  const c = U.bandClips({ clips: [{ from: 0, to: 6.3 }, { from: 5, to: 10 }] });
  return c.length === 2 && c[0].to === 6.5 && c[1].from === 6.5 && c[1].to === 10;
})());
check('整段吞掉的小段被丢掉', (function () {
  const c = U.bandClips({ clips: [{ from: 0, to: 8 }, { from: 2, to: 6 }] });
  return c.length === 1 && c[0].from === 0 && c[0].to === 8;
})());
check('短于半拍的段被丢掉', (function () {
  const c = U.bandClips({ clips: [{ from: 4, to: 4.2 }, { from: 8, to: 9 }] });
  return c.length === 1 && c[0].from === 8;
})());
check('writeClips 存多段', (function () {
  const it = {};
  U.writeClips(it, [{ from: 0, to: 4 }, { from: 12, to: 16 }]);
  return it.clips && it.clips.length === 2
    && it.clips[0].from === 0 && it.clips[1].to === 16;
})());
check('writeClips 整段时清字段', (function () {
  const it = { clips: [{ from: 4, to: 8 }], from: 4, to: 8 };
  U.writeClips(it, [{ from: 0, to: 16 }]);
  return it.clips === undefined && it.from === undefined && it.to === undefined;
})());
check('bandWindow 取第一段', (function () {
  const w = U.bandWindow({ clips: [{ from: 2, to: 4 }, { from: 8, to: 12 }] });
  return w.from === 2 && w.to === 4;
})());
/* 片段静音是本地开关：标记要活着穿过归一化与写回，整段也不能被折叠掉 */
check('静音标记不丢', (function () {
  const c = U.normClips([{ from: 0, to: 4, mute: 1 }, { from: 8, to: 12 }]);
  const it = {};
  U.writeClips(it, c);
  const whole = {};
  U.writeClips(whole, [{ from: 0, to: 16, mute: 1 }]);
  return c[0].mute === 1 && c[1].mute === undefined
    && !!it.clips && it.clips[0].mute === 1
    && !!whole.clips && whole.clips[0].mute === 1;
})());
check('静音片段不出事件', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{
      k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234,
      clips: [{ from: 0, to: 8, mute: 1 }, { from: 8, to: 12 }]
    }]
  });
  const e = L.ARRANGE.arrange(s).filter(function (x) { return x.t !== 'lead'; });
  return e.length > 0 && e.every(function (x) { return x.b >= 8 - 1e-6 && x.b < 12; });
})());

console.log('[lead-clips]');
/* 主旋律片段携带自己的音符（b 相对 from），移动/切割时旋律跟着走 */
function leadSong(notes) {
  return {
    bpm: 96, tonic: 0, mode: 'major',
    mood: L.GROOVE.feelDefaults(),
    seeds: L.GROOVE.seedDefaults(),
    band: [{ k: 'lead', id: 'piano', vol: 1 }],
    bars: [0, 0, 0, 0],
    notes: notes
  };
}
const MEL = [{ b: 0, d: 4, m: 60 }, { b: 4, d: 4, m: 72 }];
check('sliceNotes 切区间并重新相对化', (function () {
  const ns = U.sliceNotes([{ b: 2, d: 2, m: 60 }, { b: 5, d: 2, m: 64 }], 4, 8);
  return ns.length === 1 && ns[0].b === 1 && ns[0].m === 64;
})());
check('leadNotes 未物化时回落 song.notes', (function () {
  const ln = U.leadNotes(leadSong(MEL));
  return ln.length === 2 && ln[0].m === 60 && ln[1].m === 72;
})());
check('materializeLead 物化 16 拍', (function () {
  const s = leadSong(MEL);
  U.materializeLead(s);
  const ln = U.leadNotes(s);
  return U.leadHasNotes(s) && ln.length === 4
    && ln[0].b === 0 && ln[0].m === 60
    && ln[2].b === 8 && ln[2].m === 60
    && ln[3].b === 12 && ln[3].m === 72;
})());
check('normClips 保留并裁剪 notes', (function () {
  const c = U.normClips([{ from: 0, to: 8, notes: [{ b: 1, d: 2, m: 60 }, { b: 6, d: 4, m: 64 }] }]);
  return c.length === 1 && c[0].notes && c[0].notes.length === 2
    && c[0].notes[0].b === 1 && c[0].notes[1].m === 64 && c[0].notes[1].d === 2;
})());
check('writeClips 整段带 notes 不折叠', (function () {
  const it = {};
  U.writeClips(it, [{ from: 0, to: 16, notes: [{ b: 0, d: 1, m: 60 }] }]);
  return !!it.clips && it.clips.length === 1 && it.clips[0].notes
    && it.clips[0].notes.length === 1;
})());
check('mapLeadNotes 改片段音符', (function () {
  const s = leadSong(MEL);
  U.materializeLead(s);
  U.mapLeadNotes(s, function (n) { n.m += 12; });
  return U.leadNotes(s).every(function (n) { return n.m === 72 || n.m === 84; });
})());
/* 核心 bug：切割→删后段→前段挪到后段位置，听到的应是前段旋律（m=60），不是后段（m=72） */
check('切割删后段再前移，旋律跟着走', (function () {
  const s = leadSong(MEL);
  U.materializeLead(s);
  /* 分割在 4：前段 [0,4] 内容 = 第一个音；删掉后段；把前段搬到 [4,8] */
  const seg0_4 = U.sliceNotes(U.leadNotes(s), 0, 4);
  const lead = U.leadItems(s)[0];
  U.writeClips(lead, [{ from: 4, to: 8, notes: seg0_4 }]);
  s._arr = null;
  const evs = L.ARRANGE.arrange(s).filter(function (e) { return e.t === 'lead'; });
  return evs.length === 1 && evs[0].b === 4 && evs[0].m === 60 && Math.abs(evs[0].d - 4) < 1e-6;
})());

console.log('[codec]');
const code = L.CODEC.encode(song);
check('编码长度 < 256', code.length < 256, code.length);
check('字符集合合法', /^[0-9a-z]+$/.test(code));
const back = L.CODEC.decode(code);
check('可解码', !!back);
check('往返一致', back && back.notes.length === song.notes.length
  && back.bars.join() === song.bars.join()
  && back.tonic === song.tonic
  && back.mode === song.mode
  && KINDS.every(function (k) {
    return back.seeds[k] === song.seeds[k] && back.mood[k] === song.mood[k];
  })
  && back.notes.every(function (n, i) {
    return n.m === song.notes[i].m && Math.abs(n.b - song.notes[i].b) < 1e-6;
  }));

const odd = Object.assign({}, song, {
  mood: { drums: '热血', bass: '复古', chord: '派对' },
  seeds: { drums: 99999, bass: 123456, chord: 1679615 },
  band: [
    { k: 'chord', id: 'guzheng', vol: 0.8, mood: '温柔', seed: 34567 },
    { k: 'drums', id: 'hand', vol: 0.55, mood: '热血', seed: 8899 },
    { k: 'bass', id: 'upright', vol: 1, mood: '深夜', seed: 1679615 }
  ]
});
const oddBack = L.CODEC.decode(L.CODEC.encode(odd));
check('非默认情绪与种子也能往返', oddBack
  && oddBack.mood.drums === '热血'
  && oddBack.mood.chord === '派对'
  && oddBack.seeds.drums === 99999
  && oddBack.seeds.chord === 1679615);
check('乐器清单能往返', oddBack && oddBack.band.length === 3
  && oddBack.band[0].k === 'chord' && oddBack.band[0].id === 'guzheng'
  && Math.abs(oddBack.band[0].vol - 0.8) < 0.06
  && oddBack.band[1].k === 'drums' && oddBack.band[1].id === 'hand'
  && oddBack.band[2].id === 'upright');
/* 曲调与种子跟着每一件走，不再借宿在 song.mood / song.seeds 上 */
check('每件曲调与种子能往返', oddBack && oddBack.band.every(function (it, i) {
  return it.mood === odd.band[i].mood && it.seed === odd.band[i].seed;
}), oddBack && json(oddBack.band.map(function (it) { return [it.mood, it.seed]; })));

/* 满编 12 件也不能超过 URL / 云存储的长度上限 */
check('满编 12 件仍放得下', (function () {
  const big = Object.assign({}, odd, { band: [] });
  for (let i = 0; i < 12; i++) {
    const k = KINDS[i % 3];
    big.band.push({
      k: k, id: L.TIMBRE.list(k)[0].id, vol: 0.8,
      mood: L.TIMBRE.moods[i % L.TIMBRE.moods.length].name,
      seed: 1679615 - i
    });
  }
  const c = L.CODEC.encode(big);
  const d = L.CODEC.decode(c);
  return c.length < 768 && !!d && d.band.length === 12
    && d.band[11].seed === 1679615 - 11;
})());

/* 速度跟着分享走：v6 才有的字段，往返必须一致 */
check('速度能往返', (function () {
  const fast = Object.assign({}, odd, { bpm: 132 });
  const d = L.CODEC.decode(L.CODEC.encode(fast));
  return !!d && d.bpm === 132 && d.v === 9;
})());

/* v9 的每件是变长的：11 位基础字段 + 段数（1 位）+ 每段 2 位。
   这里按位拆出「每件的基础 11 位」和尾巴，用来拼 v8 及更早的串 */
function codecParts(code, n) {
  const items = [];
  let p = 18;
  for (let i = 0; i < n; i++) {
    items.push(code.substr(p, 11));
    const cnt = L.util.unb36(code.charAt(p + 11));
    p += 12 + cnt * 2;
  }
  return { head: code.slice(1, 18), items: items, tail: code.slice(p) };
}

/* 片段区间能往返（老数据只有一段也照样编码） */
check('片段区间能往返', (function () {
  const s = Object.assign({}, song, {
    band: [
      { k: 'chord', id: 'piano', vol: 0.8, mood: '温柔', seed: 3456, from: 4, to: 12 },
      { k: 'amb', id: 'rain', vol: 0.6, from: 5, to: 11 }
    ]
  });
  const d = L.CODEC.decode(L.CODEC.encode(s));
  const a = d && U.bandClips(d.band[0]);
  const b = d && U.bandClips(d.band[1]);
  return !!d && d.v === 9 && d.band.length === 2
    && a.length === 1 && a[0].from === 4 && a[0].to === 12
    && b.length === 1 && b[0].from === 5 && b[0].to === 11;
})());

/* v9 的多段：一件占好几个位置，段表顺序与起止都要原样回来 */
check('多段片段能往返', (function () {
  const s = Object.assign({}, song, {
    band: [
      {
        k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234,
        clips: [{ from: 0, to: 2 }, { from: 4.5, to: 8 }, { from: 12, to: 15.5 }]
      },
      { k: 'amb', id: 'rain', vol: 0.6, clips: [{ from: 2, to: 6 }, { from: 10, to: 14 }] }
    ]
  });
  const d = L.CODEC.decode(L.CODEC.encode(s));
  if (!d || d.band.length !== 2) return false;
  const a = U.bandClips(d.band[0]);
  const b = U.bandClips(d.band[1]);
  return json(a) === json([{ from: 0, to: 2 }, { from: 4.5, to: 8 }, { from: 12, to: 15.5 }])
    && json(b) === json([{ from: 2, to: 6 }, { from: 10, to: 14 }]);
})());

/* lead 轨和其它乐器一样进分享串：音色 / 音量 / 段表都要回来，且不脏带 mood/seed */
check('lead 轨能随分享往返', (function () {
  const s = Object.assign({}, song, {
    band: [
      { k: 'lead', id: 'guzheng', vol: 0.9, clips: [{ from: 0, to: 4 }, { from: 8, to: 12 }] },
      { k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234 }
    ]
  });
  const d = L.CODEC.decode(L.CODEC.encode(s));
  if (!d || d.band.length !== 2) return false;
  const lead = d.band[0];
  return lead.k === 'lead' && lead.id === 'guzheng'
    && Math.abs(lead.vol - 0.9) < 0.12
    && json(U.bandClips(lead)) === json([{ from: 0, to: 4 }, { from: 8, to: 12 }])
    && lead.mood === undefined && lead.seed === undefined;
})());

/* v10（'a'）：lead 片段带音符，旋律重排能随分享往返 */
check('v10 带音符 lead 能往返', (function () {
  const s = leadSong(MEL);
  U.materializeLead(s);
  const code = L.CODEC.encode(s);
  const d = L.CODEC.decode(code);
  if (!d || d.v !== 10) return false;
  const lead = U.leadItems(d)[0];
  if (!lead || !lead.clips || !lead.clips[0].notes) return false;
  const n0 = lead.clips[0].notes;
  const ln = U.leadNotes(d);
  return n0.length === 4
    && n0[0].b === 0 && n0[0].m === 60
    && n0[2].b === 8 && n0[2].m === 60
    && ln.length === 4 && ln[2].b === 8 && ln[2].m === 60;
})());

/* 每件最多 8 段：编码侧截断，但不能生成解不开的串 */
check('段数超上限仍可解', (function () {
  const many = [];
  for (let i = 0; i < 12; i++) many.push({ from: i + 0.5, to: i + 1 });
  const s = Object.assign({}, song, {
    band: [{ k: 'chord', id: 'piano', vol: 0.8, mood: '晴天', seed: 1234, clips: many }]
  });
  const d = L.CODEC.decode(L.CODEC.encode(s));
  return !!d && d.band.length === 1 && U.bandClips(d.band[0]).length <= 8;
})());

/* 满编 12 件 × 8 段：分享串还在 768 以内 */
check('12 件 8 段仍放得下', (function () {
  const big = Object.assign({}, song, { band: [] });
  for (let i = 0; i < 12; i++) {
    const k = KINDS[i % 3];
    const clips = [];
    for (let c = 0; c < 8; c++) clips.push({ from: c, to: c + 0.5 });
    big.band.push({
      k: k, id: L.TIMBRE.list(k)[0].id, vol: 0.8,
      mood: L.TIMBRE.moods[i % L.TIMBRE.moods.length].name,
      seed: 1000 + i, clips: clips
    });
  }
  const c = L.CODEC.encode(big);
  const d = L.CODEC.decode(c);
  return c.length < 768 && !!d && d.band.length === 12
    && U.bandClips(d.band[0]).length >= 1;
})());

/* 这一层的律动倍率也要随分享往返 */
check('律动倍率能往返', (function () {
  const s = Object.assign({}, song, {
    band: [
      { k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234, rate: 2 },
      { k: 'bass', id: 'finger', vol: 0.8, mood: '晴天', seed: 2345, rate: 0.5 }
    ]
  });
  const d = L.CODEC.decode(L.CODEC.encode(s));
  return !!d && d.v === 9
    && d.band[0].rate === 2 && d.band[1].rate === 0.5;
})());

/* 倍率只作用在这一层：快一倍压到前 8 拍、慢一半前几拍更空 */
check('律动倍率改变事件疏密', (function () {
  function evs(extra) {
    const it = Object.assign({ k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234 }, extra);
    const s = Object.assign({}, song, { _arr: null, band: [it] });
    return L.ARRANGE.arrange(s).filter(function (x) { return x.t !== 'lead'; });
  }
  function first4(list) { return list.filter(function (x) { return x.b < 4; }).length; }
  function distinct(list) {
    const set = {};
    list.forEach(function (x) { if (x.b < 8) set[x.b] = 1; });
    return Object.keys(set).length;
  }
  const one = evs({});
  const fast = evs({ rate: 2 });
  const slow = evs({ rate: 0.5 });
  return one.length > 0
    && fast.length > 0 && fast.every(function (x) { return x.b < 8; })
    && first4(fast) > first4(one)
    && slow.length > 0 && distinct(slow) < distinct(one);
})());
check('整段区间不落 clips / from / to', (function () {
  const d = L.CODEC.decode(L.CODEC.encode(odd));
  return !!d && d.band.every(function (it) {
    return it.from === undefined && it.to === undefined && it.clips === undefined;
  });
})());

/* 只保留落在区间内的事件，跨过终点的时值被截短 */
check('片段区间只出区间内事件', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{ k: 'chord', id: 'piano', vol: 0.8, mood: '晴天', seed: 1234, from: 4, to: 8 }]
  });
  const e = L.ARRANGE.arrange(s).filter(function (x) { return x.t !== 'lead'; });
  return e.length > 0 && e.every(function (x) {
    return x.b >= 4 - 1e-6 && x.b < 8 && x.b + x.d <= 8 + 1e-6;
  });
})());

/* 多段：每段各自开门，段与段之间的空档不出事件 */
check('多段只出段内事件', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{
      k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234,
      clips: [{ from: 0, to: 3 }, { from: 10, to: 14 }]
    }]
  });
  const e = L.ARRANGE.arrange(s).filter(function (x) { return x.t !== 'lead'; });
  return e.length > 0 && e.every(function (x) {
    const inA = x.b >= -1e-6 && x.b + x.d <= 3 + 1e-6;
    const inB = x.b >= 10 - 1e-6 && x.b + x.d <= 14 + 1e-6;
    return inA || inB;
  });
})());

/* 两段之间的事件一对都不能漏进来 */
check('段之间没有事件', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{
      k: 'bass', id: 'finger', vol: 0.8, mood: '晴天', seed: 4321,
      clips: [{ from: 0, to: 4 }, { from: 12, to: 16 }]
    }]
  });
  const e = L.ARRANGE.arrange(s).filter(function (x) { return x.t !== 'lead'; });
  return e.length > 0 && e.every(function (x) { return x.b < 4 || x.b >= 12; });
})());

/* 静音只影响本机：整条轨不出事件，也不进分享码 */
check('静音轨不出事件', (function () {
  const it = { k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234 };
  const on = L.ARRANGE.arrange(Object.assign({}, song, { _arr: null, band: [it] }));
  const off = L.ARRANGE.arrange(Object.assign({}, song, {
    _arr: null, band: [Object.assign({}, it, { mute: true })]
  }));
  return on.some(function (x) { return x.t !== 'lead'; })
    && off.length > 0 && off.every(function (x) { return x.t === 'lead'; });
})());

/* 静音要进缓存 key，否则点了静音还听到上一版 */
check('静音会换掉编曲缓存', (function () {
  const it = { k: 'drums', id: 'acoustic', vol: 0.8, mood: '晴天', seed: 1234 };
  const s = Object.assign({}, song, { _arr: null, band: [it] });
  const a = L.ARRANGE.arrange(s).length;
  it.mute = true;
  const b = L.ARRANGE.arrange(s).length;
  return b < a;
})());

/* 老链接（v3 没有乐器清单）仍要能解，乐队为空 */
check('v3 老链接仍可解且乐队为空', (function () {
  const v7 = L.CODEC.encode(odd);
  const n = odd.band.length;
  const p = codecParts(v7, n);
  /* v3 没有 bpm：把 tail 里那两拍摘掉 */
  const v3 = '3' + v7.slice(1, 16) + p.tail.slice(0, 2) + p.tail.slice(4);
  const old = L.CODEC.decode(v3);
  return !!old && old.band.length === 0 && old.notes.length === odd.notes.length
    && old.bpm === 96;
})());

/* v6 老链接：每件 8 位，没有区间，按整段播 */
check('v6 老链接仍可解，乐器按整段', (function () {
  const v7 = L.CODEC.encode(odd);
  const n = odd.band.length;
  const p = codecParts(v7, n);
  let s = '6' + p.head;
  p.items.forEach(function (e) { s += e.slice(0, 8); });
  const old = L.CODEC.decode(s + p.tail);
  return !!old && old.v === 6 && old.band.length === n
    && old.band.every(function (it) {
      return it.from === undefined && it.to === undefined;
    })
    && L.ARRANGE.arrange(Object.assign({}, old, { _arr: null })).length > 10;
})());

/* v7 老链接：有片段区间、没有律动倍率 */
check('v7 老链接仍可解，律动缺省', (function () {
  const v8 = L.CODEC.encode(odd);
  const n = odd.band.length;
  const p = codecParts(v8, n);
  let s = '7' + p.head;
  p.items.forEach(function (e) { s += e.slice(0, 10); });
  const old = L.CODEC.decode(s + p.tail);
  return !!old && old.v === 7 && old.band.length === n
    && old.band.every(function (it) { return it.rate === undefined; });
})());

/* v8 老链接：每件 11 位、单段区间写在第 8/9 位，读回来还是一段 */
check('v8 老链接仍可解，单段区间', (function () {
  const v9 = L.CODEC.encode(odd);
  const n = odd.band.length;
  const p = codecParts(v9, n);
  let s = '8' + p.head;
  p.items.forEach(function (e, i) {
    /* v9 里第 8/9 位是占位 0 / 32，这里换成真区间（半拍：8 = 4 拍、24 = 12 拍） */
    const win = (i === 0) ? (U.b36(8) + U.b36(24)) : e.slice(8, 10);
    s += e.slice(0, 8) + win + e.slice(10);
  });
  const old = L.CODEC.decode(s + p.tail);
  if (!old || old.v !== 8 || old.band.length !== n) return false;
  const c = U.bandClips(old.band[0]);
  return c.length === 1 && c[0].from === 4 && c[0].to === 12;
})());

/* v5 老链接：没有 bpm，回落 96，其余照旧 */
check('v5 老链接仍可解且速度回落 96', (function () {
  const v7 = L.CODEC.encode(odd);
  const n = odd.band.length;
  const p = codecParts(v7, n);
  let s = '5' + p.head;
  p.items.forEach(function (e) { s += e.slice(0, 8); });
  const tail = p.tail.slice(0, 2) + p.tail.slice(4);
  const old = L.CODEC.decode(s + tail);
  return !!old && old.v === 5 && old.bpm === 96 && old.band.length === n
    && old.notes.length === odd.notes.length;
})());

/* v4 老链接：每件只有 类别/音色/音量，曲调与种子缺省，靠 arrange 回落 */
check('v4 老链接仍可解，乐器没有曲调/种子', (function () {
  const v7 = L.CODEC.encode(odd);
  const n = odd.band.length;
  const p = codecParts(v7, n);
  let s = '4' + p.head;
  p.items.forEach(function (e) { s += e.slice(0, 3); });
  const tail = p.tail.slice(0, 2) + p.tail.slice(4);

  const old = L.CODEC.decode(s + tail);
  if (!old || old.band.length !== n) return false;
  if (!old.band.every(function (it) {
    return it.mood === undefined && it.seed === undefined;
  })) return false;
  return L.ARRANGE.arrange(Object.assign({}, old, { _arr: null })).length > 10;
})());

check('拒绝空串', L.CODEC.decode('') === null);
check('拒绝大写/非法字符', L.CODEC.decode('AAAAAAAAAAAAAAAA') === null);
check('拒绝超长', L.CODEC.decode('1'.repeat(800)) === null);
check('拒绝乱码', L.CODEC.decode('zzzzzzzzzzzz') === null);

console.log('[timbre]');
const moodNames = L.TIMBRE.moods.map(function (m) { return m.name; });
KINDS.forEach(function (kind) {
  const list = L.TIMBRE.list(kind);
  const ids = list.map(function (x) { return x.id; });
  check(kind + ' 有音色', list.length > 0, list.length);
  check(kind + ' 默认音色在表里', ids.indexOf(L.TIMBRE.def(kind)) >= 0, L.TIMBRE.def(kind));
  check(kind + ' 每个音色都有中文名',
    list.every(function (x) { return !!L.TIMBRE.nameOf(kind, x.id); }));
  check(kind + ' 情绪池只引用已有音色', L.TIMBRE.moods.every(function (m) {
    return (m[kind] || []).every(function (id) { return ids.indexOf(id) >= 0; });
  }));
  check(kind + ' 每个情绪都能抽出音色', L.TIMBRE.moods.every(function (m) {
    return ids.indexOf(L.TIMBRE.pick(kind, m.name)) >= 0;
  }));
});
check('情绪表与生成器的情绪表一致',
  moodNames.every(function (n) { return !!L.GROOVE.feels[n]; }),
  moodNames.filter(function (n) { return !L.GROOVE.feels[n]; }).join(','));
check('未知情绪回退默认音色', L.TIMBRE.pick('bass', '不存在') === L.TIMBRE.def('bass'));

/* 示范区：常用走向要能按当前调换成 bars，且能和歌曲对得上号 */
console.log('[demo]');
const progs = L.COMPOSE.progressions(0, 'major');
check('示范走向 >= 4 条', progs.length >= 4, progs.length);
check('走向 id 唯一', new Set(progs.map(function (p) { return p.id; })).size === progs.length);
check('走向都是 4 个级数', progs.every(function (p) {
  return p.deg.length === 4 && p.deg.every(function (d) { return d >= 0 && d < 7; });
}));
check('走向能换成 4 个 pitch class', progs.every(function (p) {
  return p.bars.length === 4 && p.bars.every(function (pc) { return pc >= 0 && pc < 12; });
}));
check('1645 在大调 = C-Am-F-G',
  L.COMPOSE.pcOf([0, 5, 3, 4], 0, 'major').join() === '0,9,5,7',
  L.COMPOSE.pcOf([0, 5, 3, 4], 0, 'major').join());
check('同一条走向在小调跟着变小',
  L.COMPOSE.pcOf([0, 5, 3, 4], 9, 'minor').join() === '9,5,2,4',
  L.COMPOSE.pcOf([0, 5, 3, 4], 9, 'minor').join());
check('progOf 能认回当前走向', progs.every(function (p) {
  return L.COMPOSE.progOf(p.bars, 0, 'major') === p.id;
}));
check('对不上的走向返回空', L.COMPOSE.progOf([1, 2, 3, 4], 0, 'major') === '');

const ambPresets = L.TIMBRE.ambPresets;
const ambIds = L.TIMBRE.list('amb').map(function (x) { return x.id; });
check('底色预设 >= 3 组', ambPresets.length >= 3, ambPresets.length);
check('底色 id 唯一', new Set(ambPresets.map(function (p) { return p.id; })).size === ambPresets.length);
check('底色只引用已有氛围', ambPresets.every(function (p) {
  return p.layers.length > 0 && p.layers.every(function (l) {
    return ambIds.indexOf(l.id) >= 0;
  });
}));
check('底色音量在 0~1，且一组里不重复', ambPresets.every(function (p) {
  var ids = p.layers.map(function (l) { return l.id; });
  return new Set(ids).size === ids.length && p.layers.every(function (l) {
    return l.vol > 0 && l.vol <= 1;
  });
}));

/* 界面按「家族」展示，每个音色必须落在且只落在一个家族里 */
check('每个音色归属唯一家族', KINDS.every(function (kind) {
  return L.TIMBRE.list(kind).every(function (item) {
    var hits = L.TIMBRE.families.filter(function (f) {
      return f.kind === kind && f.ids.indexOf(item.id) >= 0;
    });
    return hits.length === 1;
  });
}));
check('家族引用的音色都存在', L.TIMBRE.families.every(function (f) {
  var ids = L.TIMBRE.list(f.kind).map(function (x) { return x.id; });
  return f.ids.length > 0 && f.ids.every(function (id) { return ids.indexOf(id) >= 0; });
}));
check('家族名不暴露引擎层名', L.TIMBRE.families.every(function (f) {
  return f.name !== '和音';
}));

console.log('[ambience]');
const ambList = L.TIMBRE.list('amb');
check('氛围有 8 种音色', ambList.length === 8, ambList.length);
check('氛围音色都有中文名', ambList.every(function (x) {
  return !!L.TIMBRE.nameOf('amb', x.id);
}));
check('氛围每条都有合成配方', ambList.every(function (x) {
  return !!L.AMB.recipes[x.id];
}), ambList.filter(function (x) { return !L.AMB.recipes[x.id]; })
  .map(function (x) { return x.id; }).join(','));
check('氛围配方都有对应音色', Object.keys(L.AMB.recipes).every(function (id) {
  return ambList.some(function (x) { return x.id === id; });
}));
check('氛围归属唯一家族', ambList.every(function (item) {
  return L.TIMBRE.families.filter(function (f) {
    return f.kind === 'amb' && f.ids.indexOf(item.id) >= 0;
  }).length === 1;
}));

/* 氛围不参与编曲排程：整首只有主旋律事件 */
check('氛围不产生伴奏事件', (function () {
  const s = Object.assign({}, song, {
    _arr: null,
    band: [{ k: 'amb', id: 'rain', vol: 0.6 }, { k: 'amb', id: 'fire', vol: 0.5 }]
  });
  const e = L.ARRANGE.arrange(s);
  return e.length > 0 && e.every(function (x) { return x.t === 'lead'; });
})());

/* 分享串里氛围只带 类别/音色/音量，不带曲调与种子 */
check('氛围能随分享往返', (function () {
  const s = Object.assign({}, song, {
    band: [
      { k: 'amb', id: 'bamboo', vol: 0.6 },
      { k: 'chord', id: 'piano', vol: 0.8, mood: '温柔', seed: 3456 }
    ]
  });
  const d = L.CODEC.decode(L.CODEC.encode(s));
  if (!d || d.band.length !== 2) return false;
  const a = d.band[0];
  return a.k === 'amb' && a.id === 'bamboo' && Math.abs(a.vol - 0.6) < 0.06
    && a.mood === undefined && a.seed === undefined
    && d.band[1].mood === '温柔' && d.band[1].seed === 3456;
})());

/* 满编 12 件、其中四条氛围，分享串仍在长度上限内 */
check('满编 12 件含氛围仍放得下', (function () {
  const s = Object.assign({}, song, { band: [] });
  for (let i = 0; i < 12; i++) {
    if (i < 4) {
      s.band.push({ k: 'amb', id: ambList[i].id, vol: 0.6 });
    } else {
      const k = KINDS[i % 3];
      s.band.push({
        k: k, id: L.TIMBRE.list(k)[0].id, vol: 0.8,
        mood: L.TIMBRE.moods[i % L.TIMBRE.moods.length].name,
        seed: 1679615 - i
      });
    }
  }
  const c = L.CODEC.encode(s);
  const d = L.CODEC.decode(c);
  return c.length < 768 && !!d && d.band.length === 12
    && d.band[3].k === 'amb' && d.band[11].seed === 1679615 - 11;
})());

console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
process.exit(failed ? 1 : 0);
