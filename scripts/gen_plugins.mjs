// 生成 9 个内置特效/滤镜插件包到 plugins/ 下。
// 这些插件走与 example_brightness 完全相同的通路：
//   - css_filter  → HTML5 回退预览（无需 WebGPU）
//   - filter_spec → 导出时 FFmpeg 滤镜串
//   - shader      → WebGPU 实时预览（需 --enable-unsafe-webgpu）
// 运行: node scripts/gen_plugins.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:');
const PLUGINS = join(ROOT, 'plugins');

const COMMON_HEADER = `struct FilterUniforms {
  resolution: vec2f,
  opacity: f32,
  time: f32,
  params: array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> u: FilterUniforms;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  var uvs = array<vec2f, 4>(vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  var out: VSOut;
  out.position = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}
`;

const shaders = {
  brightness_contrast: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  var c = textureSample(inputTex, inputSampler, in.uv);
  let b = u.params[0].x;
  let ct = u.params[1].x;
  let s = u.params[2].x;
  var rgb = (c.rgb - vec3f(0.5)) * ct + vec3f(0.5) + vec3f(b);
  let l = dot(rgb, vec3f(0.299, 0.587, 0.114));
  rgb = mix(vec3f(l), rgb, s);
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, c.a);
}`,
  blur: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texel = 1.0 / u.resolution;
  let r = max(u.params[0].x, 0.0);
  var sum = vec3f(0.0);
  var w = 0.0;
  for (var dy: i32 = -2; dy <= 2; dy = dy + 1) {
    for (var dx: i32 = -2; dx <= 2; dx = dx + 1) {
      let off = vec2f(f32(dx), f32(dy)) * texel * (r * 0.5 + 0.5);
      sum = sum + textureSample(inputTex, inputSampler, in.uv + off).rgb;
      w = w + 1.0;
    }
  }
  let c = textureSample(inputTex, inputSampler, in.uv);
  return vec4f(sum / w, c.a);
}`,
  sharpen: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texel = 1.0 / u.resolution;
  let c = textureSample(inputTex, inputSampler, in.uv);
  let n = textureSample(inputTex, inputSampler, in.uv + vec2f(texel.x, 0.0)).rgb
        + textureSample(inputTex, inputSampler, in.uv - vec2f(texel.x, 0.0)).rgb
        + textureSample(inputTex, inputSampler, in.uv + vec2f(0.0, texel.y)).rgb
        + textureSample(inputTex, inputSampler, in.uv - vec2f(0.0, texel.y)).rgb;
  let blur = n * 0.25;
  let amt = u.params[0].x;
  var rgb = c.rgb + (c.rgb - blur) * amt;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, c.a);
}`,
  vignette: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(inputTex, inputSampler, in.uv);
  let dist = u.params[1].x;
  let d = distance(in.uv, vec2f(0.5, 0.5));
  let strength = clamp((d - dist * 0.4) / (0.7 - dist * 0.4 + 0.001), 0.0, 1.0);
  let dark = 1.0 - strength * 0.85;
  return vec4f(c.rgb * dark, c.a);
}`,
  hue: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(inputTex, inputSampler, in.uv);
  let hue = u.params[0].x * 3.14159265 / 180.0;
  let s = u.params[1].x;
  let cosA = cos(hue);
  let sinA = sin(hue);
  let y = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
  let i = dot(c.rgb, vec3f(0.596, -0.274, -0.322));
  let q = dot(c.rgb, vec3f(0.211, -0.523, 0.312));
  let i2 = i * cosA - q * sinA;
  let q2 = i * sinA + q * cosA;
  var rgb = vec3f(y) + vec3f(i2 * 0.596 + q2 * 0.211, i2 * -0.274 + q2 * -0.523, i2 * 0.322 + q2 * 0.312);
  let l = dot(rgb, vec3f(0.299, 0.587, 0.114));
  rgb = mix(vec3f(l), rgb, s);
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, c.a);
}`,
  flash: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(inputTex, inputSampler, in.uv);
  let it = u.params[0].x;
  let sp = max(u.params[1].x, 0.01);
  let pulse = abs(sin(u.time * sp));
  let add = it * pulse * 0.8;
  var rgb = c.rgb + vec3f(add);
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, c.a);
}`,
  glitch: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let amt = u.params[0].x;
  let sp = max(u.params[1].x, 0.01);
  let t = u.time * sp;
  let block = floor(in.uv.y * 20.0);
  let rnd = fract(sin(block * 12.9898) * 43758.5453);
  let shift = select(0.0, (sin(block * 7.3 + t) * 0.5 + 0.5) * amt * 0.12, rnd > 0.6);
  let ux = in.uv.x + shift;
  let off = amt * 0.02;
  let r = textureSample(inputTex, inputSampler, vec2f(ux + off, in.uv.y)).r;
  let g = textureSample(inputTex, inputSampler, vec2f(ux, in.uv.y)).g;
  let b = textureSample(inputTex, inputSampler, vec2f(ux - off, in.uv.y)).b;
  let a = textureSample(inputTex, inputSampler, in.uv).a;
  return vec4f(r, g, b, a);
}`,
  oldfilm: COMMON_HEADER + `
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(inputTex, inputSampler, in.uv);
  let grain = u.params[0].x;
  let flick = u.params[1].x;
  let sep = u.params[2].x;
  let y = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
  let i = dot(c.rgb, vec3f(0.596, -0.274, -0.322));
  let q = dot(c.rgb, vec3f(0.211, -0.523, 0.312));
  var rgb = vec3f(y) + vec3f(i * 0.596 + 0.211 * q, i * -0.274 - 0.523 * q, i * 0.322 + 0.312 * q);
  rgb = mix(c.rgb, rgb, sep);
  let n = fract(sin(dot(in.uv * u.resolution + vec2f(u.time * 60.0, 0.0), vec2f(12.9898, 78.233))) * 43758.5453);
  rgb = rgb + vec3f((n - 0.5) * grain * 0.3);
  let fl = 1.0 + (fract(u.time * 8.0) - 0.5) * flick * 0.15;
  rgb = rgb * fl;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, c.a);
}`,
  edge: COMMON_HEADER + `
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let t = 1.0 / u.resolution;
  let tl = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(-t.x, -t.y)).rgb);
  let tc = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(0.0, -t.y)).rgb);
  let tr = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(t.x, -t.y)).rgb);
  let ml = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(-t.x, 0.0)).rgb);
  let mr = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(t.x, 0.0)).rgb);
  let bl = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(-t.x, t.y)).rgb);
  let bc = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(0.0, t.y)).rgb);
  let br = lum(textureSample(inputTex, inputSampler, in.uv + vec2f(t.x, t.y)).rgb);
  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  let g = sqrt(gx * gx + gy * gy);
  let th = u.params[0].x;
  let edge = select(1.0, 0.0, g < th * 2.0);
  return vec4f(vec3f(edge), c_alpha());
}
fn c_alpha() -> f32 { return 1.0; }
`,
};

// 修正 edge shader 里误用：直接返回 alpha=1
shaders.edge = shaders.edge.replace('c_alpha()', '1.0');

const defs = [
  {
    dir: 'filter_brightness_contrast',
    id: 'filter.brightness_contrast',
    name: '亮度对比度',
    plugin_type: 'Filter',
    description: '调整画面亮度、对比度与饱和度（基于 FFmpeg eq）',
    parameters: [
      { key: 'brightness', label: '亮度', param_type: 'Slider', default: 0, min: -1, max: 1, step: 0.01 },
      { key: 'contrast', label: '对比度', param_type: 'Slider', default: 1, min: 0, max: 3, step: 0.01 },
      { key: 'saturation', label: '饱和度', param_type: 'Slider', default: 1, min: 0, max: 3, step: 0.01 },
    ],
    filter_spec: 'eq=brightness={brightness}:contrast={contrast}:saturation={saturation}',
    css_filter: 'brightness(calc(1 + {brightness})) contrast({contrast}) saturate({saturation})',
    shader: shaders.brightness_contrast,
  },
  {
    dir: 'filter_blur',
    id: 'filter.blur',
    name: '模糊',
    plugin_type: 'Filter',
    description: '高斯模糊画面（基于 FFmpeg gblur）',
    parameters: [
      { key: 'blur_radius', label: '模糊半径', param_type: 'Slider', default: 5, min: 0, max: 20, step: 0.5 },
    ],
    filter_spec: 'gblur=sigma={blur_radius}',
    css_filter: 'blur({blur_radius}px)',
    shader: shaders.blur,
  },
  {
    dir: 'filter_sharpen',
    id: 'filter.sharpen',
    name: '锐化',
    plugin_type: 'Filter',
    description: '非锐化掩模锐化（基于 FFmpeg unsharp），WebGPU 预览',
    parameters: [
      { key: 'amount', label: '强度', param_type: 'Slider', default: 0.5, min: 0, max: 2, step: 0.01 },
    ],
    filter_spec: 'unsharp=5:5:{amount}:0:0',
    css_filter: '',
    shader: shaders.sharpen,
  },
  {
    dir: 'filter_vignette',
    id: 'filter.vignette',
    name: '暗角',
    plugin_type: 'Filter',
    description: '画面四周压暗（基于 FFmpeg vignette），WebGPU 预览',
    parameters: [
      { key: 'angle', label: '角度', param_type: 'Slider', default: 20, min: 0, max: 360, step: 1 },
      { key: 'distance', label: '范围', param_type: 'Slider', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    filter_spec: 'vignette=angle={angle}:x0={distance}',
    css_filter: '',
    shader: shaders.vignette,
  },
  {
    dir: 'filter_hue',
    id: 'filter.hue',
    name: '色调',
    plugin_type: 'Filter',
    description: '色相旋转与饱和度（基于 FFmpeg hue）',
    parameters: [
      { key: 'hue', label: '色相', param_type: 'Slider', default: 0, min: 0, max: 360, step: 1 },
      { key: 'saturation', label: '饱和度', param_type: 'Slider', default: 1, min: 0, max: 3, step: 0.01 },
    ],
    filter_spec: 'hue=h={hue}:s={saturation}',
    css_filter: 'hue-rotate({hue}deg) saturate({saturation})',
    shader: shaders.hue,
  },
  {
    dir: 'effect_flash',
    id: 'effect.flash',
    name: '闪光',
    plugin_type: 'Effect',
    description: '周期性闪光（导出按强度脉冲，WebGPU 实时脉冲）',
    parameters: [
      { key: 'intensity', label: '强度', param_type: 'Slider', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'speed', label: '速度', param_type: 'Slider', default: 1, min: 0.1, max: 5, step: 0.1 },
    ],
    filter_spec: "eq=brightness='{intensity}*abs(sin(t*{speed}))'",
    css_filter: 'brightness(calc(1 + {intensity} * 0.5))',
    shader: shaders.flash,
  },
  {
    dir: 'effect_glitch',
    id: 'effect.glitch',
    name: '故障',
    plugin_type: 'Effect',
    description: 'RGB 错位与块状抖动故障特效，WebGPU 预览',
    parameters: [
      { key: 'amount', label: '强度', param_type: 'Slider', default: 0.3, min: 0, max: 1, step: 0.01 },
      { key: 'speed', label: '速度', param_type: 'Slider', default: 1, min: 0.1, max: 5, step: 0.1 },
    ],
    filter_spec: 'noise=alls={amount}',
    css_filter: '',
    shader: shaders.glitch,
  },
  {
    dir: 'effect_oldfilm',
    id: 'effect.oldfilm',
    name: '老电影',
    plugin_type: 'Effect',
    description: '棕褐色调 + 颗粒 + 闪烁（导出走 sepia 矩阵），WebGPU 含颗粒/闪烁',
    parameters: [
      { key: 'grain', label: '颗粒', param_type: 'Slider', default: 0.3, min: 0, max: 1, step: 0.01 },
      { key: 'flicker', label: '闪烁', param_type: 'Slider', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'sepia', label: '褪色', param_type: 'Slider', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    filter_spec: 'colorchannelmixer=.393:.769:.189:.349:.686:.168:.272:.534:.131,eq=contrast=1.1',
    css_filter: 'sepia({sepia}) contrast(1.1)',
    shader: shaders.oldfilm,
  },
  {
    dir: 'effect_edge',
    id: 'effect.edge',
    name: '边缘检测',
    plugin_type: 'Effect',
    description: 'Sobel 边缘检测（基于 FFmpeg edgedetect），WebGPU 预览',
    parameters: [
      { key: 'threshold', label: '阈值', param_type: 'Slider', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    filter_spec: 'edgedetect=low={threshold}',
    css_filter: '',
    shader: shaders.edge,
  },
];

let ok = 0;
for (const d of defs) {
  const dir = join(PLUGINS, d.dir);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: d.id,
    name: d.name,
    version: '1.0.0',
    author: 'AIcut',
    description: d.description,
    plugin_type: d.plugin_type,
    min_app_version: '0.1.0',
    parameters: d.parameters,
    filter_spec: d.filter_spec,
    shader: d.shader,
    css_filter: d.css_filter || null,
    thumbnail: 'thumbnail.png',
  };
  const p = join(dir, 'manifest.json');
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  ok++;
  console.log('wrote', p);
}
console.log('TOTAL', ok, 'plugins generated');
