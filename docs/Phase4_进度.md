# AIcut Phase 4 杩涘害鎶ュ憡

> **鐘舵€?*: 馃攧 鎭㈠涓?鈥?鍘熶細璇濅笂涓嬫枃鐖嗕粨锛坄400 input length too long`锛夛紝宸茬敱鏂颁細璇濇帴鎵?> **鏃ユ湡**: 2026-07-19
> **妯″瀷**: DeepSeek-V4-Pro (鍘? 鈫?WorkBuddy 鏂颁細璇?鎭㈠)
> **鏍瑰洜**: 鍗曞璇濇壙杞姐€屾柟妗堝鏍?+ 鐜鎺㈡祴 + 鍏ㄩ噺缂栫爜(7鏂囦欢L1-鏈熬) + ~1400琛孯ust鐢熸垚 + 缂栬瘧娴嬭瘯銆嶁啋 绱瓒呰緭鍏ヤ笂闄?> **鎭㈠鏂瑰紡**: 鏈細璇濅粠 `.claude` transcript 鎻愬彇鐘舵€?鈫?鍐?CLAUDE.md/杩涘害鏂囨。 鈫?鐢ㄥ叏鏂颁笂涓嬫枃瀛?agent 娴佽浆 A鈫払鈫扖

---

## 鉁?宸插畬鎴愭ā鍧?
### 1. `src/project.rs` 鈥?椤圭洰/鐢诲竷鏁版嵁妯″瀷锛?8 琛岋級

**鑱岃矗**: 瀹氫箟 AIcut 宸ョ▼鐨勬牳蹇冩暟鎹粨鏋勶紝瀵瑰簲 TS `project.ts`

| 鍐呭 | 璇存槑 |
|------|------|
| `struct Project` | 宸ョ▼鏍癸細鐗堟湰銆佺敾甯冨昂瀵?fps/瀹介珮/閲囨牱鐜?銆佺礌鏉愬垪琛ㄣ€佽建閬撳垪琛?|
| `struct Asset` | 绱犲紩锛歩d/type(video/audio/image)銆佽矾寰勩€佹椂闀裤€佸垎杈ㄧ巼銆佺紪鐮?|
| `struct Track` | 杞ㄩ亾锛歩d/type(video/audio/text/effect)銆佹帓搴忋€佺墖娈靛垪琛?|
| `struct Clip` | 鐗囨锛氱礌鏉愬紩鐢ㄣ€佹簮鑼冨洿(srcRange)銆佹椂闂寸嚎浣嶇疆(timelineIn/Out)銆佸彉鎹?transform: x/y/scaleX/scaleY/rotation/opacity)銆侀煶閲忋€佸彉閫?|
| `struct Transform` | 2D 鍙樻崲鐭╅樀锛堜綅缃?缂╂斁/鏃嬭浆/閫忔槑搴︼級 |
| `CanvasConfig` / `compute_canvas()` | 鐢诲竷璁＄畻閫昏緫锛屽熀浜?`ASPECT_PRESETS` 棰勮 |

**鍏抽敭甯搁噺**:
- `ASPECT_PRESETS`: 瀹介珮姣旈璁捐〃 `{ "16:9": (1920,1080), "9:16": (1080,1920), "1:1": (1080,1080), "4:3": (1440,1080), "21:9": (2560,1080) }`
- `DEFAULT_FPS`: 30
- `DEFAULT_SAMPLE_RATE`: 48000
- `defaultBitrateMbps`: 瀵煎嚭鐮佺巼榛樿鍊?
**TS 瀵瑰簲**: `project.ts` 鈫?`Project`, `Asset`, `Track`, `Clip` 绫?
---

### 2. `src/ffmpeg.rs` 鈥?FFmpeg 鍛戒护鏋勫缓鍣紙164 琛岋級

**鑱岃矗**: 灏嗘覆鏌撶绾挎娊璞′负 FFmpeg 鍛戒护琛屽弬鏁帮紝瀵瑰簲 TS `ffmpeg.ts`

| 鍐呭 | 璇存槑 |
|------|------|
| `struct RenderCommand` | 娓叉煋鍛戒护瀹瑰櫒锛氳緭鍏ユ枃浠跺垪琛ㄣ€佹护闀滈摼(filter_graph)銆佽緭鍑哄弬鏁?codec/crf/resolution/fps/bitrate) |
| `struct FilterChain` | 婊ら暅閾撅細鏈夊簭婊ら暅鑺傜偣鍒楄〃 + 搴忓垪鍖栨柟娉?|
| `fn build_input_args()` | 鏋勫缓杈撳叆鍙傛暟锛?i file -framerate 绛夛級 |
| `fn build_filter_graph()` | 灏?FilterChain 搴忓垪鍖栦负 FFmpeg `-filter_complex` 瀛楃涓?|
| `fn build_output_args()` | 鏋勫缓杈撳嚭鍙傛暟锛?c:v libx264 -crf 18 绛夛級 |
| `fn to_command_line()` | 缁勫悎涓哄畬鏁?Vec<String> 鍛戒护 |

**FFmpeg 婊ら暅鎺㈡祴闄嶇骇鏈哄埗**:
```
鍚姩鏃舵帰娴嬫矙鐩掔幆澧冨彲鐢ㄦ护闀?鈫?缂哄け鍒欓檷绾э細
  eq (璋冭壊)     鈫?璺宠繃鎴栫敤 brightness/contrast 鏇夸唬
  mask (钂欑増)    鈫?璺宠繃钂欑増鏁堟灉锛屼繚鐣欏熀纭€鍚堟垚
  format (鏍煎紡)  鈫?寮哄埗 pix_fmt=yuv420p
```
**TS 瀵瑰簲**: `ffmpeg.ts` 鈫?`RenderCommand`, `FilterChain`, `buildFFmpegCommand()` 鍑芥暟鏃?
---

### 3. `src/filters.rs` 鈥?婊ら暅/鐗规晥绯荤粺锛?57 琛岋級猸?鏈€澶фā鍧?
**鑱岃矗**: 瑙嗛澶勭悊鏍稿績鈥斺€旀护闀滃畾涔夈€佸弬鏁扮鐞嗐€佸叧閿抚鎻掑€笺€佹护闀滃浘鏋勫缓

| 瀛愭ā鍧?| 琛屾暟(浼? | 璇存槑 |
|--------|---------|------|
| 婊ら暅鏋氫妇/娉ㄥ唽琛?| ~120 | `enum FilterType` { ColorAdjust, CropRotate, Speed, Mask, Transition, TextOverlay, ... } + `FilterRegistry` |
| 婊ら暅鍙傛暟瀹氫箟 | ~200 | `FilterParam` 缁撴瀯浣擄紙name/type/min/max/default/step锛? 鍚勬护闀滅殑榛樿鍙傛暟闆?|
| 鍏抽敭甯х郴缁?| ~180 | `Keyframe { time, value, easing }` + `KeyframeTrack` + 鎻掑€肩畻娉?绾挎€?璐濆灏? |
| 婊ら暅鍥炬瀯寤?| ~150 | `FilterGraphBuilder` 鈥?灏嗚建閬?鐗囨+婊ら暅缁勫悎鎴?FFmpeg filter_complex DAG |
| 棰勭疆/妯℃澘 | ~100 | 鍐呯疆婊ら暅棰勭疆锛堢數褰辨劅/鏃ョ郴/澶嶅彜绛夐鏍煎寘锛?|
| 搴忓垪鍖?| ~100 | FilterChain 鈫?FFmpeg 瀛楃涓茬殑瀹屾暣搴忓垪鍖栭€昏緫 |
| 閿欒澶勭悊/闄嶇骇 | ~107 | 娌欑洅缂哄け婊ら暅鐨勪紭闆呴檷绾?+ 閿欒浼犳挱 |

**鍏抽敭璁捐鍐崇瓥**:
- 姣忎釜婊ら暅绫诲瀷鏈夊浐瀹氱殑 `FilterParamSchema`锛堝弬鏁版ā寮忥級
- 鍏抽敭甯ч┍鍔ㄤ换鎰忓睘鎬у姩鐢?- FilterGraphBuilder 鎸夈€岃建閬撲粠搴曞埌椤躲€佹椂闂翠粠宸﹀埌鍙炽€嶉『搴忔嫾鎺?- 涓?`ffmpeg.rs` 鐨?`FilterChain` 鍙屽悜瀵规帴

---

### 4. `src/lib.rs` 鈥?N-API 缁戝畾瀵煎嚭灞傦紙160 琛岋級

**鑱岃矗**: Rust 鈫?Node.js 鐨勬ˉ鎺ュ眰锛岄€氳繃 napi-rs 瀵煎嚭鍏叡 API

| 鍐呭 | 璇存槑 |
|------|------|
| `#[napi]` 灞炴€у畯鏍囪 | 鎵€鏈夊鍑虹殑 struct/fn |
| `impl Project for NapiProject` | Project 鐨?NAPI 鍖呰 |
| `impl FilterChain for NapiFilterChain` | FilterChain 鐨?NAPI 鍖呰 |
| `napi_export_render()` | 涓诲叆鍙ｏ細鎺ユ敹 JSON 宸ョ▼鎻忚堪 鈫?鏋勫缓 RenderCommand 鈫?杩斿洖 FFmpeg 鍛戒护瀛楃涓?|
| `napi_export_preset_list()` | 杩斿洖鍙敤婊ら暅棰勮鍒楄〃 |
| `napi_get_version()` | 鐗堟湰鏌ヨ |
| 閿欒鏄犲皠 | Rust Error 鈫?napi::Error 鐨勮浆鎹?|

**N-API 绛惧悕棰勬湡**:
```typescript
// TS 渚ц皟鐢ㄦ柟寮?import { render, getPresetList, getVersion } from '@aicut/engine-native';
const cmd = render(projectJson); // -> string (ffmpeg command line)
const presets = getPresetList(); // -> string[]
const ver = getVersion();         // -> string
```

---

## 馃搳 瀹屾垚搴︽€昏锛?026-07-20 鏇存柊锛?
| 妯″潡 | 鐘舵€?| 琛屾暟 | 澶囨敞 |
|------|------|------|------|
| `project.rs` | 鉁?瀹屾垚 | 165 | 鏁版嵁妯″瀷 + ASPECT_PRESETS + compute_canvas |
| `ffmpeg.rs` | 鉁?瀹屾垚 | 196 | 鍛戒护鏋勫缓 + 婊ら暅鎺㈡祴闄嶇骇 |
| `filters.rs` | 鉁?瀹屾垚 | 727 | 鍏抽敭甯?娉ㄥ唽琛?FilterGraphBuilder/棰勭疆/鍙橀€?鏃嬭浆/闊抽/xfade |
| `lib.rs` | 鉁?瀹屾垚 | 27 | 绾?`pub fn` API锛圢-API 寤跺悗锛?|
| `main.rs` | 鉁?瀹屾垚 | 63 | CLI 浜岃繘鍒跺叆鍙ｏ紙render/presets/version锛?|
| `build.rs` | 鉁?瀹屾垚 | 3 | 鍗犱綅锛圢-API 寤跺悗锛?|
| `tests/integration_test.rs` | 鉁?瀹屾垚 | 339 | **8 涓叏閮ㄩ€氳繃** |
| **鎬昏** | **8 娴嬭瘯閫氳繃** | **~1520** | `cargo build --offline` + `cargo test --offline` 鍏ㄧ豢 |

### 鏂板鍔熻兘锛坴s 鍘熷璁捐锛?- 鉁?鍙橀€熸帶鍒讹紙setpts锛?- 鉁?鏃嬭浆锛坮otate锛?- 鉁?闊抽杞ㄩ亾锛坴olume/atempo/amix锛?- 鉁?鍚岃建 xfade 杩囨浮
- 鉁?鍏抽敭甯ч┍鍔ㄥ睘鎬э紙opacity/scale/rotation/position/volume锛?
### N-API 鐘舵€?宸蹭粠 Cargo.toml 绉婚櫎 napi 渚濊禆銆傚紩鎿庝互 `pub fn` API + CLI 浜岃繘鍒惰繍琛屻€傚緟缃戠粶鍙敤鏃舵仮澶?napi銆?
### N-API 鎭㈠姝ラ锛堢綉缁滃彲鐢ㄦ椂锛?1. `Cargo.toml` 鎭㈠ `napi` / `napi-derive` / `napi-build`
2. `src/lib.rs` 鐨?`pub fn` 鏀瑰洖 `#[napi] pub fn`
3. `build.rs` 鎭㈠ `napi_build::setup();`
4. `cargo build` 鐢熸垚 `.node` 鏂囦欢

## 鏈€缁堜氦浠樼墿锛?026-07-20锛?
```
E:\AIcut\
鈹溾攢鈹€ CLAUDE.md                    鏋舵瀯鎽樿锛?56琛岋級
鈹溾攢鈹€ Cargo.toml                   绾?Rust 搴?+ CLI 浜岃繘鍒?鈹溾攢鈹€ build.rs                     鍗犱綅
鈹溾攢鈹€ src/
鈹?  鈹溾攢鈹€ project.rs  (165L)       鏁版嵁妯″瀷 + ASPECT_PRESETS + compute_canvas
鈹?  鈹溾攢鈹€ ffmpeg.rs   (196L)       RenderCommand + 婊ら暅鎺㈡祴闄嶇骇
鈹?  鈹溾攢鈹€ filters.rs  (727L)       婊ら暅娉ㄥ唽琛?鍏抽敭甯?鍙橀€?鏃嬭浆/闊抽/xfade/棰勭疆
鈹?  鈹溾攢鈹€ lib.rs       (27L)       pub fn API: render/get_preset_list/get_version
鈹?  鈹斺攢鈹€ main.rs      (63L)       CLI 浜岃繘鍒? aicut-engine render|presets|version
鈹溾攢鈹€ packages/engine/             TS 妗ユ帴灞傦紙package.json + tsconfig.json锛?鈹溾攢鈹€ tests/integration_test.rs    **8 娴嬭瘯鍏ㄩ儴閫氳繃**
鈹斺攢鈹€ docs/
    鈹溾攢鈹€ Phase4_杩涘害.md           鏈枃浠?    鈹斺攢鈹€ Phase4_瀛愪换鍔℃媶鍒?md     A/B/C 瀛愪换鍔¤鏍?```

> **`cargo build --offline` 闆堕敊璇紝`cargo test --offline` 8/8 閫氳繃銆?*
> **CLI 浜岃繘鍒?`aicut-engine.exe` 绔埌绔敓鎴?FFmpeg 娓叉煋鍛戒护銆?*
> **N-API 缁戝畾寰呯綉缁滄仮澶嶅悗鎸変笂杩版楠ゆ縺娲汇€?*



### N-API 恢复步骤（网络可用时）
1. Cargo.toml 恢复 
api / 
api-derive / 
api-build  
2. src/lib.rs pub fn 改回 #[napi] pub fn  
3. uild.rs 恢复 napi_build::setup()  
4. cargo build 生成 .node 文件

## 最终交付物（2026-07-20）

E:\AIcut\
├── src/project.rs (165L)   数据模型 + ASPECT_PRESETS
├── src/ffmpeg.rs  (196L)   RenderCommand + 滤镜探测降级
├── src/filters.rs (727L)   滤镜/关键帧/变速/旋转/音频/xfade/预置
├── src/lib.rs      (27L)   pub fn API
├── src/main.rs     (63L)   CLI 二进制
├── tests/integration_test.rs  **8/8 通过**
└── docs/

> cargo build --offline 零错误  
> cargo test --offline 8/8 通过  
> CLI 二进制 aicut-engine.exe 端到端生成 FFmpeg 命令  
> N-API 绑定待网络恢复后激活
