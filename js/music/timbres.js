/* ============================================================
 * music/timbres.js — 每个乐器能出什么声音
 * 心情只决定「候选声音」，真正弹成什么样由 music/groove.js 现场生成。
 * 暴露：LALA.TIMBRE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;

  var BASS = [
    { id: 'finger',  name: '指弹贝斯' },
    { id: 'pick',    name: '拨片贝斯' },
    { id: 'synth',   name: '合成贝斯' },
    { id: 'upright', name: '低音提琴' }
  ];

  var CHORD = [
    { id: 'piano',   name: '钢琴' },
    { id: 'guitar',  name: '木吉他' },
    { id: 'eguitar', name: '电吉他' },
    { id: 'guzheng', name: '古筝' },
    { id: 'ep',      name: '电钢琴' },
    { id: 'organ',   name: '风琴' }
  ];

  var DRUMS = [
    { id: 'acoustic', name: '原声鼓' },
    { id: 'electro',  name: '电子鼓' },
    { id: 'hand',     name: '手鼓' }
  ];

  /* 人声层：不放合成音，播的是这一次的录音。没有录音时这一族不可用 */
  var VOICE = [
    { id: 'hum', name: '我的哼唱' }
  ];

  /* 主旋律已经和普通乐器一样是 band 里的一条轨，音色就是当初选的主音。
     id 和 app.js 的 VOICE_UI 对齐：'voice' = 那一次的原声，其余走 lead() 合成 */
  var LEAD = [
    { id: 'voice',   name: '我的原声' },
    { id: 'piano',   name: '钢琴' },
    { id: 'guitar',  name: '木吉他' },
    { id: 'guzheng', name: '古筝' },
    { id: 'soft',    name: '柔和合成' },
    { id: 'flute',   name: '笛子' },
    { id: 'chip',    name: '8-bit' }
  ];

  /* 氛围层：不参与编曲排程，是一条贯穿整首的铺底噪声。
     声音配方在 audio/ambience.js，这里只管有哪些名字 */
  var AMBIENCE = [
    { id: 'rain',     name: '雨声' },
    { id: 'fire',     name: '篝火' },
    { id: 'stream',   name: '溪流' },
    { id: 'cicada',   name: '蝉鸣' },
    { id: 'bamboo',   name: '竹林' },
    { id: 'crickets', name: '夜晚虫鸣' },
    { id: 'waves',    name: '海浪' },
    { id: 'wind',     name: '风声' }
  ];

  /* 底色：几组常用的氛围铺底。点一下就把这几层一起叠上去，
     音量按「主铺底 + 点缀」配好，省得一条条加再调滑杆 */
  var AMB_PRESETS = [
    { id: 'rainynight', name: '雨夜',   hint: '雨 + 虫鸣',  layers: [{ id: 'rain', vol: 0.55 }, { id: 'crickets', vol: 0.3 }] },
    { id: 'fireside',   name: '炉边',   hint: '火 + 风',    layers: [{ id: 'fire', vol: 0.6 }, { id: 'wind', vol: 0.26 }] },
    { id: 'creekside',  name: '溪畔',   hint: '溪 + 竹林',  layers: [{ id: 'stream', vol: 0.55 }, { id: 'bamboo', vol: 0.3 }] },
    { id: 'seaside',    name: '海边',   hint: '浪 + 蝉',    layers: [{ id: 'waves', vol: 0.6 }, { id: 'cicada', vol: 0.22 }] }
  ];

  /* 心情 → 这层乐器能用哪些声音。点心情时在池里随机取一个，
     同一心情点两次可能换声音；曲子本身由 groove.js 按种子生成 */
  var MOODS = [
    { name: '晴天', drums: ['acoustic'],           bass: ['finger', 'pick'],  chord: ['guitar', 'piano'] },
    { name: '深夜', drums: ['hand'],               bass: ['upright', 'finger'], chord: ['piano', 'ep'] },
    { name: '温柔', drums: ['hand', 'acoustic'],   bass: ['finger'],          chord: ['piano', 'guzheng'] },
    { name: '下雨', drums: ['acoustic'],           bass: ['upright'],         chord: ['piano', 'guzheng'] },
    { name: '热血', drums: ['electro', 'acoustic'], bass: ['pick', 'synth'],  chord: ['eguitar'] },
    { name: '复古', drums: ['acoustic'],           bass: ['pick'],            chord: ['organ', 'eguitar'] },
    { name: '派对', drums: ['electro'],            bass: ['synth'],           chord: ['ep', 'eguitar'] },
    { name: '清晨', drums: ['hand'],               bass: ['finger'],          chord: ['guzheng', 'guitar'] }
  ];

  /* 引擎只有三层发声通道，但界面上按「乐器家族」展示：
     家族是给人看的，kind 是给引擎看的，别把 kind 的名字漏到界面 */
  var FAMILIES = [
    { id: 'keys',   name: '键盘', kind: 'chord', ids: ['piano', 'ep', 'organ'] },
    { id: 'guitar', name: '吉他', kind: 'chord', ids: ['guitar', 'eguitar'] },
    { id: 'zheng',  name: '古筝', kind: 'chord', ids: ['guzheng'] },
    { id: 'drums',  name: '鼓',   kind: 'drums', ids: ['acoustic', 'electro', 'hand'] },
    { id: 'bass',   name: '贝斯', kind: 'bass',  ids: ['finger', 'pick', 'synth', 'upright'] },
    { id: 'vocal',  name: '人声', kind: 'voice', ids: ['hum'] },
    { id: 'amb',    name: '氛围', kind: 'amb',   ids: ['rain', 'fire', 'stream', 'cicada',
                                                       'bamboo', 'crickets', 'waves', 'wind'] }
  ];

  var KINDS = {
    drums: { label: '鼓', list: DRUMS, def: 'acoustic' },
    bass:  { label: '贝斯', list: BASS, def: 'finger' },
    chord: { label: '和音', list: CHORD, def: 'piano' },
    voice: { label: '人声', list: VOICE, def: 'hum' },
    amb:   { label: '氛围', list: AMBIENCE, def: 'rain' },
    lead:  { label: '旋律', list: LEAD, def: 'soft' }
  };

  function listOf(kind) {
    return (KINDS[kind] && KINDS[kind].list) || [];
  }

  function defOf(kind) {
    return (KINDS[kind] && KINDS[kind].def) || null;
  }

  function nameOf(kind, id) {
    var list = listOf(kind);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return '';
  }

  function moodOf(name) {
    for (var i = 0; i < MOODS.length; i++) if (MOODS[i].name === name) return MOODS[i];
    return null;
  }

  function oneOf(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* 该心情下这层乐器能用哪些声音 */
  function pool(kind, moodName) {
    var m = moodOf(moodName);
    return (m && m[kind]) || null;
  }

  function pick(kind, moodName) {
    var p = pool(kind, moodName);
    if (!p || !p.length) return defOf(kind);
    return oneOf(p);
  }

  function anyOf(kind) {
    var list = listOf(kind);
    return list.length ? oneOf(list).id : defOf(kind);
  }

  function familyOf(kind, id) {
    for (var i = 0; i < FAMILIES.length; i++) {
      var f = FAMILIES[i];
      if (f.kind === kind && f.ids.indexOf(id) >= 0) return f;
    }
    return null;
  }

  /* 界面上说「键盘 / 吉他 / 古筝」，不说引擎里的「和音」 */
  function familyName(kind, id) {
    var f = familyOf(kind, id);
    return f ? f.name : (KINDS[kind] ? KINDS[kind].label : '乐器');
  }

  L.TIMBRE = {
    kinds: KINDS, families: FAMILIES, moods: MOODS, ambPresets: AMB_PRESETS,
    list: listOf, def: defOf, nameOf: nameOf, familyOf: familyOf, familyName: familyName,
    pool: pool, pick: pick, anyOf: anyOf, mood: moodOf
  };
})();
