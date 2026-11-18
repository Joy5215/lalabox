# 开发记录

只记「会再踩的坑」和「不能改坏的约定」。改代码前扫一眼。

---

## 一、手机真机必须走安全上下文

浏览器只在 `https` 或 `http://localhost` 下暴露 `navigator.mediaDevices`。
用 `http://192.168.x.x:8080` 打开会直接 `undefined`，页面报 `no-media`。

**首选：cloudflared 隧道**（不碰 USB，电脑重启后也照用）：

```powershell
node tools/tunnel.js                                  # 起本地服务 + 隧道，打印 https 地址
node tools/tunnel.js --check                          # 只探测 cloudflared 与端口，排障先跑这个
node tools/tunnel.js 8080 --no-server                 # 已有 serve.js 在跑，只打隧道
```

手机直接打开控制台打印的 `https://xxx.trycloudflare.com/`。quick tunnel 的域名每次启动都变，
脚本只打印不落盘；`Ctrl+C` 会同时关掉本地服务和 cloudflared 进程树（Windows 走 `taskkill /T`）。

**兜底：`adb reverse`**（断网 / 公司网禁出站 / 装不了 cloudflared 时）：

```powershell
node tools/serve.js                                        # 电脑开服务
adb reverse tcp:8080 tcp:8080                              # 手机 localhost 转发
# 无线：adb tcpip 5555 → adb connect <手机IP>:5555 → 再 reverse 一次
```

手机浏览器打开 `http://localhost:8080`。

**为什么电脑一重启就打不开了**：`adb reverse` 规则不是持久化配置，它挂在 adb server 与这台设备
当前的连接上。电脑重启 = adb server 重启，规则全部丢失；手机重启、拔线、换 USB 口、从 USB 切无线
同理。表现就是「昨天还好好的，今天 `localhost:8080` 直接打不开」，重新执行一次 `adb reverse` 即可。
这也是把隧道设为首选的原因：隧道只依赖出站网络，与 USB / adb server 无关。

| 现象 | 处理 |
| --- | --- |
| `adb devices` 空 | 开发者选项里关掉再开 USB 调试，确认「仅充电模式下允许 ADB 调试」 |
| 页面报 `no-media` | 没走 localhost / https |
| 点开始唱卡在「等一下…」 | 权限被锁死，见下 |
| 拔线后打不开 | 重新 connect + reverse |
| 电脑重启后 `localhost:8080` 打不开 | `adb reverse` 规则随 adb server 一起没了：重设，或改用 `node tools/tunnel.js` |

华为浏览器 `USER_FIXED` 会导致授权框都不弹、Promise 永远挂着：

```powershell
adb shell "pm grant com.huawei.browser android.permission.RECORD_AUDIO"
adb shell "appops set com.huawei.browser RECORD_AUDIO allow"
```

代码侧已给 `getUserMedia` 包了 8 秒超时，抛 `mic-timeout`，不会无限等。

---

## 二、音高算法：六个已修的坑

都在 `js/music/analyze.js` / `compose.js`，**改之前先看这里**。

| 坑 | 根因 | 现在的值 |
| --- | --- | --- |
| 每个音高约 +120 cents | YIN 阈值在下降沿就返回，没走到谷底 | 命中后 `while (cmnd[best+1] < cmnd[best]) best++` |
| 正常大跳被折八度 | `diff > 7` 就折 | 改成 `diff >= 12` 才折 |
| 短音被合并 | 量化网格 0.5 拍太粗 | 十六分网格 `Math.round(b*4)/4`，时值 0.25~4 |
| 压嗓低音录不到 | 窗长 32ms 装不下两个周期 | `W = 640`、`TAU_MAX = 290`（约 55Hz） |
| 低音被整体抬高 | 成曲门槛 `minM < 55` | 改成 `minM < 40`（E2） |
| 长音只出两拍 | 时值上限写死 2 | 上限改 4 |

代价：窗长变长后 100ms 连奏会从 8 个降到 5 个，150ms 以上仍正常。
短音问题若回归，优先怀疑 `W` 和量化网格。

**仍未解决**：同音重复（同音高连哼、中间没停顿）会被并成一个音，因为分段只看音高变化，
没做起音检测。

---

## 三、录音链路

`AudioWorklet` 优先，`ScriptProcessor` 兜底；Android WebView 上两条都可能全静音，
所以同时开 `MediaRecorder`，静音时改吃它的 blob 再解码。
静音判定看 `peak < 0.005`。两条都没声音 → 弹「麦克风自检」。

---

## 四、结果页与数据

**流程**：录完只有一条主音（原声或转成的乐器），乐队默认是空的（`band: []`），
页面上只有一个圆形 ＋ 按钮（`#btnBand`）作为入口，点开是乐队总面板。

**Song**：

```js
{ v, bpm, tonic, mode,
  style,                                               // 随机旋律的来源风格（可空），只给界面提示
  mood:  { drums, bass, chord },                       // 老数据的回落值，随机旋律里 = 风格曲调
  seeds: { drums, bass, chord },                       // 同上，老链接缺 per-item 字段时用
  band:  [{ k:'chord', id:'guzheng', vol:0.8,
            mood:'温柔', seed:12345 }, …],             // 曲调与种子属于每一件乐器
  bars: [pc×4], notes: [{b,d,m}] }
```

- `bars` 存的是**音级度数算出来的 pitch class**，不是绝对和弦，换调不会错位。
  但 `transposeBy()` 必须**连 `bars` 一起搬**（`pc + d`）：只改 `tonic` 会让伴奏比旋律低半音，
  示范区的「当前走向」也就认不出来了
- `bars` 必须进 `arrange` 的缓存 key：换走向时漏掉它就会拿到上一版
- 和弦走向由 `chooseChords()` 给哼唱音符打分选优；全局「换一个」从界面下线，
  `COMPOSE.rollChords()` 的 API 与测试保留，供以后的全局方案复用。
  示范区的「常用走向」是另一套：`COMPOSE.progressions(tonic, mode)` 给带 pitch class 的卡片数据，
  `COMPOSE.progOf(bars, tonic, mode)` 反查当前用的是哪一条（对不上返回 `''`）。
  这套卡片**不走打分**，点了就直接覆盖 `song.bars`
- `buildSong(notes, opts)` 的 `opts` 是这四条：`tonic` / `mode`（不让识别器改音）、
  `bpm`、`pools`（风格自带的走向池）、`moodName`（风格曲调）。缺省时行为与老版本一致
- codec 到 v9：mood(3) + seeds(12) + band(2 + **每件变长**) + tonic / mode + **bpm(2)** + bars / notes；
  每件 = 11 位基础字段（类别 / 音色 / 音量 / 曲调 / 种子(4) / **占位 0,32** / **律动倍率**）
  + 段数（1 位，0 = 整段）+ 每段两位起止（半拍 0~32）。
  `KINDS` 末尾是 `amb`（氛围），它没有曲调和种子，编码时这两个字段写固定占位（`晴天` / `101`），
  读回来只回填 `k/id/vol`；整段也不落 `clips` / `from` / `to` 字段，老数据的形状保持一致
- v9 的段数是**变长**的：读的时候按位走（`q = base + 11` 再按段数跳），不能再用固定步长跳；
  每件最多 8 段、整串最多 32 段，解码侧超了就判失败。编码侧按预算截断，
  截到只剩一段时用首末把整条包住，绝不生成解不开的串；`decode` 长度上限 512 → 768
- v1（风格位）、v2（模板索引）、v3（无乐器清单）、v4（乐器无曲调/种子）、
  v5（无 bpm）、v6（乐器无片段区间）、v7（乐器无律动倍率）、v8（单段区间）仍能解；
  v5 及更早一律回落 96 BPM，v4 及更早的乐器靠 `arrange` 回落到 `song.mood[it.k]` / `song.seeds[it.k]`，
  v6 及更早的乐器一律按整段播，v8 及更早解出来就是一段
- 主音色（`voice` / 钢琴…）不进编码，只有 band 里的乐器音色进

**速度是每条各自的**（`U.spbOf(song)`）：
- 播放链路（`renderSong` / `songDur` / `beatPos` / 原声循环）一律走 `spbOf(song)`，
  `C.SPB` 只剩录音链路用（节拍器、倒计时、量化网格都按 96 BPM 录，别跟着歌速变）
- 新入口把 `bpm` 写进 song，结果页徽标与分享编码都读它；漏掉哪一环就出现
  「标签写 120、听起来还是 96」

**不用麦克风的两个入口**（`js/app.js` + `js/music/compose.js` + `js/music/styles.js`）：
- 「输入简谱」：`COMPOSE.parseDegrees()` 只认 1-7 与 0（0 是停顿），一个数字一拍、最多 16 拍；
  空格 / 逗号 / 竖线都当分隔，连写「1235321」也认；非法字符实时提示并禁用生成
- 「输入简谱」的随机变奏 = `COMPOSE.typedBatch(notes, seed, {view})`：**音级序列不动**，
  只改时值（`auto` / `straight` / `half` / `long` 四档）、大小调色彩（三 / 六 / 七级降半音）、
  移调、八度，并把原谱的停顿按新格距保留。三段各占一个速度档，卡片上一眼看出快慢
- 「换一版」= `COMPOSE.typedRoll(notes, seed, {view, bpm, mode})`：只换选中那一条，
  节奏档与速度保留，属微调；没选中就整批重来
- 「随机旋律」= `COMPOSE.melodyBatch(seed, {vibe, style})`，两层选择：
  氛围（治愈 / 忧郁 / 躁动 / 空灵）定音阶与轮廓，风格（民谣 / Lo-fi / 摇滚 / 电子 /
  爵士 / 国风 / 派对 / 说唱）定速度区间、常用走向、节奏型与曲调。两层都有「随机」，
  随机时三段各挑不同的风格与氛围 —— 差异就是从这里来的
- `STYLE.planFor(vibe, style)` 把两层合成一份 `plan`（scale / contour / feels / bpm /
  pools / mood / transpose）。生成器只认 plan，**别再往 `rhythmFor` / `walkDegrees`
  里塞 if**：想加风格就往 `styles.js` 的 `STYLES` 里加一行
- 音阶按 C 大调 / A 小调起音，所以小调五声靠 `plan.transpose` 搬到目标主音；
  三段必须落在自己声明的调内，否则试听与结果页会听到两种音
- 差异闸门 `distinctEnough()`：同调同轮廓同速度、或音高直方图余弦 > 0.93 就算重复，
  重抽最多 4 次；一批三段之间也走同一闸门。它过严时宁可放近似，也不能少于三段
- 候选卡点击只试听：`band` 空着，只有主旋律，按**候选自己的 bpm** 算时长后自动停；
  底部「就用这段」才 `showResult` 进结果页。试听音色遇到 `voice` 会退回 `soft`——
  原声模式没有合成主旋律，否则点了没声；关面板 / 换一批 / 确认都要 `stopCandPreview()`
- 两个面板共用一套候选池（`cand.source` 区分 `typed` / `random`），生成 / 试听 / 选中
  只有一份实现；别退回各自一份，否则两个面板会互相覆盖候选
- 两条路都落到同一个 `COMPOSE.buildSong(notes, opts)`，选音色 / 乐队 / 分享 / 海报完全复用；
  生成时清 `state.voiceBuf`，免得把上一次录音当成这次的「原声」
- 结果页标题按来源改（你的哼唱 / 你的简谱 / 随机旋律）：`showResult(song, { source })`；
  随机旋律的 band 里带上 `style.timbreHint`，乐队面板据此提示常用配器

**伴奏是现算的，不是模板表**（`js/music/groove.js`）：

```js
FEEL = { '热血': { energy:.95, density:.85, sync:.5, space:.1 }, ... }
```

- 种子驱动 LCG，每小节 `rngOf(seed + bar * 131)` 派生
- 情绪参数只影响**概率**（`chance(r, .32 + energy*.5)` 决定第三拍有没有底鼓）
- 硬约束兜底：第一拍必有底鼓、军鼓按 style 钉二四拍（半速那版只钉第三拍）、
  贝斯至少一个根音、和音只取和弦内音
- 同一件乐器同 `(mood, seed)` 一定长出同一版；`arrange` 的缓存 key 覆盖每件的
  `mood` / `seed` / `vol`，再加 `bars` 与调性，少一样就会「点了没变化」
- **只改拍位不够**：`GROOVE.variant(seed)` 还派生 `style`（节奏型）、`inv`（和弦转位）、
  `oct`（音区）。少了这三样，换个种子听起来就是同一个律动，因为概率本来就容易掷出同样结果

**主旋律覆盖整个循环**：`arrange` 把 8 拍乐句在后两小节原样重复一次（原声模式本来就是录音循环，
不重复就前后不一致）。所以 `DRAW.melody` 读的是 `arrange` 的 `lead` 事件，**不是** `song.notes`，
否则右半边画不出来、听到的和看到的对不上。

**lead 轨**：主旋律已经和别的乐器同构，`song.band` 里 `k:'lead'` 且 `id` 就是主音色面板选的音色
（`voice` = 那一次的原声，其余走 `lead()`）。`arrange` 给它发 `t:'lead'` + `bi` 的事件，
片段 / 静音 / 音量口径完全复用其它轨；只有老数据或候选试听没有 lead 轨时才退回无 `bi` 的事件。
`renderSong` 见 `bi` 就认轨上的音色，别再只看 `playCfg.timbre`；lead 的 `id==='voice'` 时由
`startVoiceLoop` 发声音，`pump()` 照跑，八度 / 电音才由 renderSong 补一层合成。
`normalizeSong` 保证每条歌都有一条 lead 轨；分享串带不过录音，原声 id 要回落 `soft`，否则整轨静音。

**播放的两个不变量**（`js/audio/engine.js`）：
- 原声模式只是用录音循环代替合成主音，`pump()` 必须照跑，否则加了鼓 / 贝斯 / 和音也没声音；
  lead 轨自己按片段开门，八度 / 电音只补合成层，别把录音再叠一遍
- 整个 4 小节循环是一次排完的（最远约 10 秒后才响），任何 cleanup 的 `setTimeout`
  都要按 `(endAt - ctx.currentTime)` 换算；用「现在的墙钟 + 时值」会让靠后的和弦
  还没出声就被 `disconnect()` 掐断，表现就是「有些音块没声音」

**音色**（`js/music/timbres.js` + `engine.js`）：
`DRUM_KIT / BASS_SPEC / CHORD_SPEC` 才是合成参数，`timbres.js` 只管有哪些名字。
拨弦感的三个关键字段：`nz` 触弦噪声、`harmDec` 泛音先于基频消失、`strum` 逐音起音。

**乐队面板的两栏约定**（`js/app.js` + `index.html#sheetBand`）：
- 面板最上面那张清单是「所有已经在响的」：乐器 / 人声 / 氛围混排，`buildBandList` **不按页签过滤**，
  且必须用真实下标（`bands.map(function(it, idx){…})`），否则滑杆与 ✕ 会指到另一件
- 页签（乐器 / 氛围 / 示范，`bandTab`）只切下面的「添加 · 示范」区：决定列出哪些家族。
  氛围页不摆家族按钮，八个音色直接铺开（`openFamily` 固定 `'amb'`）；乐器页的家族清单要排除 `amb`；
  示范页整块交给 `buildDemos()`（不走家族那一套，`buildAdd` 一进来就 early return）。
  切页签清 `previewSel` / `openRowIdx`，如果正在试听就 `replay()` 回整队
- 示范页两块：**常用和弦走向**（`COMPOSE.progressions` / `progOf`，点了直接覆盖 `song.bars`
  并立刻重排，标题高亮当前那条）和**底色**（`TIMBRE.ambPresets`，一组氛围层一起 push 进
  `song.band`，已有的跳过、音量按预设给）。两处都在 `syncBand()` 里重建，所以改完调性 /
  加完层会自动刷新「当前是哪条 / 哪组已在铺底」
- 入口仍是结果页唯一的 ＋，每次打开都落回乐器页；加了氛围之后它照样立刻出现在顶层清单里
- 第一栏是 `song.band` 的真实列表：滑块写回 `it.vol`，✕ 直接 `splice`（清 `openRowIdx`，
  免得展开行指到下一件）。点行名展开这一行换曲调（人声 / 氛围没有曲调，点了直接进编曲），
  「编曲」打开全屏时间线并选中这一轨；`openRowIdx` 同时只展开一件
- 换曲调 = 写 `it.mood` + `GROOVE.newSeed()`，**心情和种子必须一起换**，只改心情听到的还是
  同一版拍位；换完立刻清 `song._arr`，否则命中旧编曲缓存
- 曲调只认 `TIMBRE.moods` 里的名字（写入前校验），改完整支乐队里只让这一件响
  （`previewOnly([it])`），列表保持展开方便连着试；关面板时 `replay()` 回到整支乐队
- 第二栏是「乐器家族 → 音色」两级展开，默认全部收起。**试听与加入必须分离**：
  点家族 = 展开 + 试听代表音色，点音色 = 换试听对象，只有「加入乐队」才写 `song.band`
- 试听默认 = **已加入的乐队 + 这一件候选**：孤零零一件听不出合不合群；lead 已经是 band 里的
  普通轨，想听整队就别从 `previewOnly` 的清单里剔掉它。试听台右上角的「整队 / 单件」分段
  控件用 `previewSolo` 切（乐队空着时不显示，两种模式声音一样）。曲调（心情 + 种子）
  在选中时就抽定，`addInstrument` 沿用同一份，听到的就是加进来的
- 试听台里的「曲调氛围」= `STYLE.vibes` 映射到 `VIBE_MOODS` 里的心情，选中就重掷一条；
  「换一版」(`rerollPreview`) 按当前氛围再抽心情 + 换种子。`''`（跟随这首歌）走
  `teamMood()`，即 `song.mood` / 风格曲调，别改成随机，否则新乐器会偏离整首歌的味道
- **加入后必须 `replay()` 整队**，不能只 `previewOnly([item])`：那样用户加完只听到一件，
  得关掉面板才知道合奏什么效果（这就是以前的抱怨）
- 加乐器时就给它 `mood` + `seed`：同一层加两件是两份独立律动，别再按层重抽种子
- 加完一件要清掉 `previewSel` 并重绘，不然「加入」按钮还能连点，重复加同一件
- 界面上只出现家族名（`TIMBRE.familyName`），`chord` 这个引擎层名（和音）不要漏给用户
- 全局「换个编曲」（全队心情 + 换一个）本轮移除，等全局方案再设计；
  `rollChords` 会过滤「首个和弦与上一版相同」「整条相同」的候选，以后接全局时别把过滤去掉
- 伴奏按 `song.band` 逐件播：事件的 `bi` 指回乐器，音色 / 音量 / 鼓组都取那一件的。
  别再恢复「按层聚合 + `1/sqrt(n)`」的中间层，那套已删；音量由每件的 `vol` 单独控制
- 乐队画布**每件乐器一行**、行名用音色名（钢琴 / 古筝 / 原声鼓），同类多件各占一行，
  lead 轨也在其中（通常第一行，名字就是主音色），不再额外加「主旋律」行；
  行数多时 `DRAW.band` 按行高自动压字号、标签宽与色块高
  （13 行时色块仍有 2px，分隔线在行高 < 9px 时省掉）
- 加乐器上限 12，与 `CODEC` 的 `MAX_BAND` 对齐：超出的件在分享编码时会被静默截掉，
  所以 `addInstrument` 在加之前就拦住并提示
- **人声层**（`k:'voice'`）放的是这一次的录音，不参与 `arrange` 排程：`play()` 从 `song.band`
  里找 `k==='voice'` 的那一件，用 `startVoiceLoop()` 按它自己的 `vol` 起录音循环。
  主音色本身就是「我的原声」时跳过这一层，否则同一段音频叠两遍等于音量翻倍
- 人声层可以直接在面板里录：`人声 → 哼一段 / 重录一条` 走 `startBandHum()`，
  `state.recMode='band'` 让 `stopRecordingNow()` 只解码录音、**不跑识别**，录完
  `endBandHum()` 回面板并自动加入（已有就替换那一条）。录音流程与首页完全一致
  （四拍倒计时 + 八拍），差别只在录完的去向：首页出整首歌，这里只叠一层
- 人声层没有曲调与节奏型：不展开曲调、不给「换一版」，只有音量滑杆；画布上是一条
  按片段区间画的底色带（没有逐音事件）
- 分享串能带 `voice` 这一项（`KINDS` **只能往末尾加**，插在中间会让老链接按下标解码错位），
  但音频传不过去：别人打开时这一层是静的
- **氛围层**（`k:'amb'`）也是一条贯穿整首的铺底，不参与 `arrange`：`G['amb']` 不存在，
  `arrange` 的 `var gen = G[it.k]; if (!gen) return;` 天然跳过，`renderSong` 里永远没有它的事件。
  合成配方在 `js/audio/ambience.js`（`L.AMB`），`play()` 调 `startAmbience()`、`stop()` 统一收
- 氛围的**节点只在 `play()` 建一次**，`pump()` 里只调 `renderClips()` 给它的 gate 排包络：
  绝不能每圈重建噪声源，否则会有咔哒声、也让「雨一直下」变成「每 4 小节重新下一次」
- 每条氛围一个配方（噪声 + 滤波 + LFO），随机事件（水滴 / 爆裂 / 虫叫）用 `setTimeout` 链，
  句柄必须进层里的 `timers`，`stop()` 时一起清；停止先淡出总线 0.25 秒再 `stop()` 源节点
- 氛围没有曲调与种子：`addInstrument` 不写 `mood` / `seed`，默认 `vol: 0.6`；
  面板里不展开曲调、也没有「换一版」（和人声层共用同一个 `isStatic` 判断）
- 画布上氛围按每一段画底色带（和人声同分支），`ROW_COLOR.amb` 是竹青灰；
  不加颜色整行会消失
- 氛围计入 12 件上限，与乐器共用 `MAX_BAND`；试听/加入/卸下都走整队 `replay()`，别只放单条

**片段（`clips`）与全屏时间线**：
- 一件乐器可以有**多段**：`it.clips = [{from,to}, …]`，单位是拍、半拍对齐、范围 0~16，
  按起点排好、互不重叠、每段最短 0.5 拍、每件最多 8 段；整段时不落字段
- `U.bandClips(it)` 是**唯一取值口径**：`clips` 优先 → 老 `from/to` 折成一段 → 都没有就是整段。
  别在别处直接读 `it.from`；`U.bandWindow(it)` 只留给老调用取第一段
- `U.writeClips(it, list)` 归一化后写回（排序 / 去重叠 / 夹紧 / 最短半拍），整段时把
  `clips` / `from` / `to` 一起删掉。所有写入前都要过它，别让脏数据进 `arrange` / codec
- `arrange` 先按 `rate` 重排时间，再判断事件起点落在哪一段、时值截到那一段的终点；
  缓存 key 必须带整串片段（`1-4,6-9`）与 `mute`，否则改了听到的还是上一版
- 静音 `it.mute` 只影响本机：整条轨不进事件、人声与氛围也不起，**不进分享码**。
  界面上有两个入口（轨道头的小喇叭、底栏「静音这一轨」），共用这一个字段，行整体压暗
- **两种静音别混**：轨道静音 `it.mute` = 整条轨；片段静音 `clip.mute = 1` = 只关那一段（斜纹标记）。
  文案必须分开（`静音这一轨` vs `片段静音`），否则用户分不清自己关了什么。两者都只在本机生效
- 片段静音的实现口径：`arrange` 的 `clipEnd()` 命中静音段返回 null（等于这一段不存在），
  `renderClips` / `AMB.render` 对静音段不排开门；`normClips` 必须原样带着这个标记，
  拖动 / 裁剪 / 分割 / 步进走 `seg()` 复制标记，别用裸对象覆盖掉它；
  `writeClips` 也不能把「整段但静音」折叠成没有字段，否则静音会丢
- **点选按拍位兜底**：片段块只有 28px 高，点在它上下的空白里要点中它而不是当空白。
  `onLaneDown` 先看命中的元素，没命中再用 `hitOf(clips, beat0)` 按拍位找；都落空才是空白处
- **空白处「点一下」不新建，必须横向拖**（`NEW_PX = 10` 起）：早先点一下就建 4 拍，
  删掉一段后顺手点一下空白，那段会「长回来」，看起来像删除没生效。现在点空白 = 只选轨，
  拖出来才建，长度跟手；拖不到 10px / 满 8 段都给一句提示，别做成「点了没反应」
- 人声与氛围不走进 `renderSong`：`pump()` 每排一个循环就调 `renderClips(base, spb)`，
  按它们**每一段**给 gate 排开关包络。整段时直接给 1，跨循环不断开
- 全屏时间线是 `js/ui/timeline.js`（`L.TIMELINE`，DOM 不是 canvas）：只做视图与指针交互，
  数据仍然归 `app.js`，通过 `ctx` 回调写回（`onChange / onMoveClip / onSeek / onDeleteTrack /
  onToggleMute / onRate / onKey / onAudition / onAuditionTrack / onAuditionSection / isAudition /
  audition / onJoin / onCancel / onDone`）。
  `open(ctx)` 进来、`refresh()` 重画、`tick(beat)` 只挪播放头、`close()` 收起
- **拖动只改本地 ghost 样式，`pointerup` 才 `onChange`**：每移动一像素就重启音频会听不下去。
  片段两端各 12px 是裁剪热区（光标提示），4px 以内当点击；全部吸附半拍；
  拖动压到邻段就吃掉重叠的那一截（拖动的优先），裁剪则被邻段夹紧
- **跨轨拖动**：只有 `kind:'move'` 参与，按 `clientY` 命中行（`dropTargetAt`）只改 `drag.target`，
  节点直接 reparent 到目标 `.tl-lane` 里做实时预览；数据仍由 `ctx.onMoveClip` 一次写完
  （`moveClipToTrack`）：**先写目标轨、再删源轨**，否则删了源轨目标下标会前移。
  源轨被搬空就整轨收起（和「删掉最后一段」同口径），函数返回新轨下标，时间线据此重新选中
- 拖动中临时出现的「＋ 新轨」行（`data-bi = -3`）只是 DOM，不进 `band`；`buildRows` 一重建就置空引用。
  它**必须追加在最后**：插在中间会把别的轨顶下去，落点跟着跳。试听候选轨（`bi = -1`）不参与跨轨；
  原来的主旋律参考轨已删，lead 轨就是普通轨，照常拖动 / 静音 / 调片段
- `.tl-clip` 必须 `touch-action:none`：不然手机上竖拖会被浏览器当滚动（pointercancel），换轨拖不动。
  轨道背景仍是 `pan-y`，要滚轨道就在空白处滑
- 拖动到轨道区上下边缘时 `autoScroll` 每次 pointermove 滚 12px；12 条轨时靠它才拖得到最后一条
- 改片段**不动播放头**：`onChange` 的第三个参数只有「新建片段」才带 `{seek, play}`；
  其它改动只清 `song._arr`，正在播就从当前这一拍接着放（`restartHere()`）
- 播放头是 `state.seekBeat`：暂停时 = `ENG.beatPos()`，点/拖时间尺就写它。
  `playOpts()` 带 `seekBeat`，`ENG.play` 把 `playStart` 往前挪 `seekBeat * spb`，
  `beatPos()` 的公式天然从该拍开始数；播放中定位 = 重新 `play()`
- seek 时 `renderSong` 跳过已经过去的事件（否则会一拥而上），`renderClips` / `scheduleGate`
  把时间夹到 `now` 并立即短淡入开门；**人声在 seek 时不做事句对齐**（录音永远从起点开始）
- `tick()` 里时间线打开时不再画底下的两块画布；关闭时间线把 `seekBeat` 归 0、
  刷新乐队行摘要；面板关掉时时间线一起收，别留一个盖在别的面板上
- 两个入口：乐队行「编曲」→ `openTimeline({bi})`；试听卡「编曲」→
  `openTimeline({preview:true})`，候选挂在 `previewSel` 上当**临时轨**（`bi = -1`），
  区间 / 律动调好点「加入乐队」由 `previewAsItem()` + `addInstrument` 原样带走，取消就丢掉
- lead 轨和其它轨一样挂拖拽：点片段改区间 / 静音 / 跨轨搬运都走同一套回调；
  主音色面板换音色只改 `lead.id` + 清 `_arr`，名字、画布、声音一起变
- 时间线里改候选只碰 `previewSel`（`applyClips(-1, …)`），不要清 `state.song._arr`
- **复制 / 剪切 / 粘贴**在时间线自己手里（`clipboard`，全局一份）：复制只记长度与静音位；
  剪切 = 复制 + 删这一段（删的是最后一段就等价于删轨，剪贴板留着还能粘到别的轨）；
  粘贴从播放头往后找第一个空档（`freeGap`），放不下就提示，不硬塞
- **单独试听有三个口径，别混**（`app.js` 的 `startAudition`）：
  `mode:'clip'` = 只循环**这一个片段**（`opts.loop = {from,to}`，引擎的循环窗口收到段长）；
  `mode:'track'` = 整条轨按 16 拍整圈循环，它所有的段照常进出；
  `mode:'section'` = 循环窗口同样是这一段，但**整支乐队一起进临时 Song**，静音的轨由
  `arrange` / `AMB.start` / `play()` 的人声门自己跳过（别在时间线里再筛一遍，否则两处口径）。
  三者都 `lead:false`、不写 `song.band`，再点同一个按钮即停。
  `paintAir` 里 **只有 section 放开 `scope`**（所有轨都亮），clip / track 只亮试听那一条
- 试听靠 `audition` 这一个状态位：`startPlaying` / 暂停 / 播放候选 / 关时间线都要
  `clearAudition()`，否则底栏会显示「停止」而实际在放整队
- 整轨试听的起播点必须是**第一段未静音片段的起点**（`live[0].from`）：从 0 起播而片段在 8~12 时
  会先静 5 秒，用户只会判定「整轨循环没出声」。片段与律动倍率凑不出事件时（快一倍 + 片段在后半圈），
  `startAudition` 退回整段并在底栏说清楚，别留一片静音让人猜
- **正在发声的视觉口径**是片段右上角的小喇叭（`.tl-clip.air`，`tick()` 里的 `paintAir` 按拍位点亮）
  加底栏 `.tl-live` 提示「正在响 x–y 拍 / 这一段是空档」。静音轨、静音段不亮；单独试听只有那一条轨亮。
  别用实时电平（`ENG.level`）驱动：它量的是总线，别的层也在响，分不清是哪一段
- 底栏「整段」的两个小箭头（`moveClip`）只改片段起点、长度不变，被邻段与 0~16 拍夹住；
  与拖拽同一口径，静音标记要跟着走
- **引擎的循环窗口**（`winFrom` / `winTo`，默认 0~16）是「片段自己循环」的唯一实现：
  `songDur = (winTo-winFrom) * spb`，`pump()` 用 `base - winFrom*spb` 作为渲染基准，
  `renderSong` 丢掉窗口外的事件、时值截到窗口终点，`renderClips` / `AMB.render` 把每段的
  起止平移进窗口，`beatPos()` 返回窗口内的绝对拍。改这几处要一起改，漏一个就会出现
  「循环点前的声音被排进来」或「播放头跑出片段」
- 整圈（窗口 = 0~16）时行为必须与以前完全一致：`full` 判定改成对着**窗口长度**比，
  别再写死 `LOOP_BEATS`

---

## 五、离线验证音高算法

不用真机、不开浏览器：合成已知频率的正弦，直接跑算法。

```js
const vm = require('vm');
const ctx = { console, setTimeout, Promise, Math, JSON, Float32Array,
  Array, Object, String, Number, Date, Error };
ctx.window = ctx;
ctx.document = { querySelector: () => null, querySelectorAll: () => [] };
ctx.requestAnimationFrame = (fn) => setImmediate(fn);
vm.createContext(ctx);
['js/core/utils.js', 'js/music/analyze.js', 'js/music/compose.js']
  .forEach((f) => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }));
```

造 48kHz 正弦（每音 0.625s = 一拍）喂 `ANALYZE.run(pcm, 48000, 0)`，逐音比 cents 偏差。
改门限 / 量化 / 窗长一律先跑这个再上真机。

---

## 六、发布

```powershell
node tools/push.js          # 打包 + 推预览（不送审）
toy update 55182818016256 dist --json --yes
```

预览地址每次推送都换 token，收藏 `/latest` 而不是直链。

---

## 七、可见的端到端自测（tools/e2e.js）

要「自己看着它跑」时用这个：窗口会真的弹在桌面上（默认 440×920 手机比例、屏幕右侧），
脚本一步步点，终端同步打印进度。

```powershell
node tools/e2e.js               # 有窗口，默认节奏（约 15 秒）
node tools/e2e.js --slow        # 每步 1.5 秒，方便一边看一边讲
node tools/e2e.js --keep        # 跑完不关窗口，可以接着自己点
node tools/e2e.js --hum         # 多走一步：在乐队面板里现录一段人声
node tools/e2e.js --headless    # 无窗口跑批，CI 用
node tools/e2e.js --url http://localhost:8080/   # 换地址（默认带 ?debug=1）
```

- **麦克风是假的**：`--use-fake-device-for-media-stream` + `--use-file-for-fake-audio-capture=<wav>`，
  脚本自己生成「2.9s 静音 + `C D E(3拍) F G(2拍)`」的 48k WAV，不占用真人麦克风，
  顺带验证长音有没有被截短。
- **必须由脚本自己拉起浏览器**：`--use-file-for-fake-audio-capture` 是启动参数，
  直接打开日常浏览器不生效；`--user-data-dir` 指向临时目录，避免「已有实例吞掉新参数」。
- 流程：点「开始唱」→ 等识别（读 `#badgeKey` / `#badgeBpm`）→ 开乐队 → 人声 → 加入 →
  汇总控制台报错。关键节点截图落在 `tools/.shots/`（`01-idle` … `05-voice-added`）。
- **前提**：静态服务已经在跑（`node tools/serve.js` 或 `node tools/tunnel.js`）。
- 有报错或走不到结果页时退出码非 0，并额外存一张 `99-fail` 截图。
