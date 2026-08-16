//! 多轨道合成器 — 逐轨道 Over 合成（RGBA alpha 混合）
//!
//! 合成模型：Source Over（Porter-Duff）
//!   out_a = src_a + dst_a * (1 - src_a)
//!   out_c = (src_c * src_a + dst_c * dst_a * (1 - src_a)) / out_a   (out_a > 0 时)
//!
//! Transform 应用顺序：缩放 → 旋转（双线性插值，中心为原点）→ 位置 → 不透明度

use crate::pipeline::strategy::{PixelFormat, VideoFrame};
use crate::project::Transform;

// ════════════════════ 类型定义 ════════════════════

/// 合成层：一帧画面 + 其变换参数
#[derive(Clone, Debug)]
pub struct CompositeLayer {
    /// 已解码的视频帧（RGBA8）
    pub frame: VideoFrame,
    /// 该层的变换（位置、缩放、旋转、不透明度）
    pub transform: Transform,
    /// 转场 wipe 遮罩：画布归一化矩形 (x0,y0,x1,y1)，y-down；仅保留矩形内像素。None = 不裁剪。
    pub reveal_mask: Option<(f32, f32, f32, f32)>,
}

// ════════════════════ Compositor ════════════════════

/// 多轨道合成器
///
/// 将多个 `CompositeLayer` 按"从底到顶"顺序合成到一张画布上。
/// 每层先经过 Transform 变换，再用 Over 操作叠加到画布。
pub struct Compositor {
    width: u32,
    height: u32,
}

impl Compositor {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// 逐轨道 Over 合成
    ///
    /// - `layers`: 从底到顶排列的层（第一个在最底层）
    /// - 返回: 合成后的 VideoFrame（RGBA8，画布大小）
    pub fn composite(&self, layers: &[CompositeLayer]) -> VideoFrame {
        // 画布初始化为全透明黑
        let mut canvas = vec![0u8; (self.width as usize) * (self.height as usize) * 4];

        for layer in layers {
            self.composite_layer(&mut canvas, layer);
        }

        // 如果画布完全透明（无层），填为黑色不透明
        if layers.is_empty() {
            for px in canvas.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }

        VideoFrame {
            width: self.width,
            height: self.height,
            format: PixelFormat::Rgba8,
            data: canvas,
            timestamp: layers.first().map(|l| l.frame.timestamp).unwrap_or(0.0),
            source_asset_id: String::new(),
            source_time: 0.0,
        }
    }

    /// 合成单层到画布（带 Transform）
    fn composite_layer(&self, canvas: &mut [u8], layer: &CompositeLayer) {
        let frame = &layer.frame;
        let tf = &layer.transform;

        // contain-fit 与 WebGPU 预览对齐：先按资产/画布宽高比做一次 fit，再乘用户缩放。
        // 预览 shader 中：
        //   videoAspect > canvasAspect ? fitScale=(1, canvasAspect/videoAspect)
        //                              : fitScale=(videoAspect/canvasAspect, 1)
        let frame_aspect = frame.width as f64 / (frame.height as f64).max(1.0);
        let canvas_aspect = self.width as f64 / (self.height as f64).max(1.0);
        let (fit_x, fit_y) = if frame_aspect > canvas_aspect {
            (1.0, canvas_aspect / frame_aspect)
        } else {
            (frame_aspect / canvas_aspect, 1.0)
        };
        let eff_scale_x = fit_x * tf.scale_x;
        let eff_scale_y = fit_y * tf.scale_y;

        // 1. 缩放到 contain-fit + 用户缩放后的目标尺寸（画布坐标系）。
        //    预览里显示尺寸 = 画布尺寸 * fitScale * 用户缩放；这里保持一致。
        let scaled_w = ((self.width as f64) * eff_scale_x).round().max(1.0) as u32;
        let scaled_h = ((self.height as f64) * eff_scale_y).round().max(1.0) as u32;

        let scaled = if scaled_w == frame.width && scaled_h == frame.height {
            frame.data.clone()
        } else {
            let sx = if frame.width == 0 {
                1.0
            } else {
                scaled_w as f64 / frame.width as f64
            };
            let sy = if frame.height == 0 {
                1.0
            } else {
                scaled_h as f64 / frame.height as f64
            };
            Self::scale_nearest(&frame.data, frame.width, frame.height, sx, sy)
        };

        // 2. 旋转（围绕中心，双线性插值）。输出尺寸为旋转后外接矩形（AABB），
        //    视频画面本身的形状/比例保持不变，只是整体绕中心转了一个角度（视觉上矩形转成菱形）；
        //    菱形之外的 AABB 四角置透明。这与 WebGPU 预览原始 shader（直接渲染旋转后的矩形 quad、
        //    不缩放/不变形、四角透明）效果一致。超出全局画布的裁切由 over_blit 依据 dst_x/dst_y
        //    的画布坐标裁剪负责。方向：正角在屏幕上表现为逆时针，与预览一致。
        let (rotated, rotated_w, rotated_h) = if tf.rotation.abs() < f64::EPSILON {
            (scaled, scaled_w, scaled_h)
        } else {
            Self::rotate_rgba(&scaled, scaled_w, scaled_h, tf.rotation)
        };

        // 3. 计算目标位置（Transform.x/y 是归一化坐标，0.5 = 中心）
        //    旋转后的外接矩形居中放置，与预览旋转 quad 的中心一致。
        let center_x = tf.x * (self.width as f64);
        let center_y = tf.y * (self.height as f64);
        let dst_x = (center_x - (rotated_w as f64) / 2.0).round() as i64;
        let dst_y = (center_y - (rotated_h as f64) / 2.0).round() as i64;

        // 4. Over 合成（应用 opacity + 已旋转）
        //    注意：源尺寸必须传旋转后的 AABB 尺寸，而不是缩放后的 scaled_w/scaled_h。
        let opacity = tf.opacity.clamp(0.0, 1.0);
        Self::over_blit(
            canvas,
            self.width,
            self.height,
            &rotated,
            rotated_w,
            rotated_h,
            dst_x,
            dst_y,
            opacity,
            layer.reveal_mask,
        );
    }

    /// 最近邻缩放
    ///
    /// 将 src（src_w x src_h）缩放到 (src_w*sx, src_h*sy)
    fn scale_nearest(
        src: &[u8],
        src_w: u32,
        src_h: u32,
        sx: f64,
        sy: f64,
    ) -> Vec<u8> {
        let dst_w = ((src_w as f64) * sx).round().max(1.0) as u32;
        let dst_h = ((src_h as f64) * sy).round().max(1.0) as u32;
        let mut dst = vec![0u8; (dst_w as usize) * (dst_h as usize) * 4];

        let x_ratio = (src_w as f64) / (dst_w as f64);
        let y_ratio = (src_h as f64) / (dst_h as f64);

        for dy in 0..dst_h {
            let sy = ((dy as f64) * y_ratio).floor() as u32;
            let sy = sy.min(src_h - 1);
            for dx in 0..dst_w {
                let sx = ((dx as f64) * x_ratio).floor() as u32;
                let sx = sx.min(src_w - 1);

                let src_idx = ((sy as usize) * (src_w as usize) + (sx as usize)) * 4;
                let dst_idx = ((dy as usize) * (dst_w as usize) + (dx as usize)) * 4;

                dst[dst_idx..dst_idx + 4].copy_from_slice(&src[src_idx..src_idx + 4]);
            }
        }

        dst
    }

    /// 围绕中心旋转 RGBA 帧（双线性插值采样）。
    ///
    /// - 输出尺寸为旋转后的轴对齐外接矩形（AABB），包含完整菱形及其四个尖角；
    ///   菱形之外的 AABB 四角区域置透明 (0,0,0,0)。这与 WebGPU 预览原始 shader 直接
    ///   渲染旋转后菱形 quad 的行为一致（四角透明，尖角可见）。
    /// - 超出全局画布的裁切由调用方 `over_blit` 依据 dst_x/dst_y 的画布坐标裁剪处理。
    /// - 旋转方向：正角度在屏幕上表现为逆时针(CCW)，与 WebGPU 预览一致。图像(Y-down)与
    ///   NDC(Y-up) 的 Y 轴符号相反，故直接套用预览同款矩阵即自动对齐，无需对角度取负。
    /// - 采用后向映射：对 AABB 输出每个像素逆旋转求源坐标。
    fn rotate_rgba(src: &[u8], w: u32, h: u32, degrees: f64) -> (Vec<u8>, u32, u32) {
        let src_w = w as i64;
        let src_h = h as i64;

        if degrees.abs() < f64::EPSILON {
            return (src.to_vec(), w, h);
        }

        // 旋转方向必须与 WebGPU 预览一致（正角度 = 屏幕逆时针 CCW）。
        // 推导：预览在 NDC(Y-up) 用矩阵 M=(cos,-sin; sin,cos) 旋转；源视频顶部在 NDC 为 +Y。
        // 导出缓冲是图像(Y-down)，源顶部在图像中为 -Y。两坐标系 Y 轴符号相反，故在图像空间
        // 直接套用同一矩阵 M 的「逆映射」恰好等价于预览的 CCW——**不要对角度取负**，否则方向反转。
        // （已验证：竖版 +90° 时预览把顶部红条转到屏幕左侧，本实现 forward map
        //  (IC·cosφ+IR·sinφ, -IC·sinφ+IR·cosφ) 同样把红条送到输出左侧，二者一致。）
        let rad = degrees * std::f64::consts::PI / 180.0;
        let cos = rad.cos();
        let sin = rad.sin();
        let abs_cos = cos.abs();
        let abs_sin = sin.abs();

        // 旋转后外接矩形（AABB）尺寸，保证能完整容纳旋转后的菱形。
        let out_w = ((src_w as f64) * abs_cos + (src_h as f64) * abs_sin)
            .ceil()
            .max(1.0) as u32;
        let out_h = ((src_w as f64) * abs_sin + (src_h as f64) * abs_cos)
            .ceil()
            .max(1.0) as u32;
        let out_w_i = out_w as i64;
        let out_h_i = out_h as i64;

        let src_cx = (src_w - 1) as f64 / 2.0;
        let src_cy = (src_h - 1) as f64 / 2.0;
        let out_cx = (out_w_i - 1) as f64 / 2.0;
        let out_cy = (out_h_i - 1) as f64 / 2.0;

        let mut dst = vec![0u8; (out_w as usize) * (out_h as usize) * 4];

        for y in 0..out_h_i {
            for x in 0..out_w_i {
                let dx = x as f64 - out_cx;
                let dy = y as f64 - out_cy;
                // 后向映射（与预览旋转方向一致：正角 = 屏幕逆时针）
                let sx = dx * cos - dy * sin + src_cx;
                let sy = dx * sin + dy * cos + src_cy;

                // 落在原帧矩形之外 → 透明（菱形外四角）。
                if sx < 0.0 || sx > (src_w - 1) as f64 || sy < 0.0 || sy > (src_h - 1) as f64 {
                    continue;
                }

                // 双线性插值（sx/sy 已在帧内；x1/y1 的 min 边界防御仍保留）
                let dst_idx = ((y * out_w_i + x) as usize) * 4;
                let x0 = sx.floor() as i64;
                let y0 = sy.floor() as i64;
                let x1 = (x0 + 1).min(src_w - 1);
                let y1 = (y0 + 1).min(src_h - 1);
                let fx = sx - x0 as f64;
                let fy = sy - y0 as f64;

                let i00 = ((y0 * src_w + x0) as usize) * 4;
                let i10 = ((y0 * src_w + x1) as usize) * 4;
                let i01 = ((y1 * src_w + x0) as usize) * 4;
                let i11 = ((y1 * src_w + x1) as usize) * 4;

                for c in 0..4 {
                    let v00 = src[i00 + c] as f64;
                    let v10 = src[i10 + c] as f64;
                    let v01 = src[i01 + c] as f64;
                    let v11 = src[i11 + c] as f64;
                    let top = v00 * (1.0 - fx) + v10 * fx;
                    let bot = v01 * (1.0 - fx) + v11 * fx;
                    let v = top * (1.0 - fy) + bot * fy;
                    dst[dst_idx + c] = v.round().clamp(0.0, 255.0) as u8;
                }
            }
        }

        (dst, out_w, out_h)
    }

    /// Over 合成：将 src（带 opacity）blit 到 dst 画布的 (dst_x, dst_y) 位置
    ///
    /// - `dst`: 画布 RGBA 数据（可变）
    /// - `dst_w`/`dst_h`: 画布尺寸
    /// - `src`: 源帧 RGBA 数据
    /// - `src_w`/`src_h`: 源帧尺寸
    /// - `dst_x`/`dst_y`: 源帧左上角在画布上的坐标（可为负，表示部分超出画布）
    /// - `opacity`: 全局不透明度（0.0-1.0），乘到源帧 alpha 上
    fn over_blit(
        dst: &mut [u8],
        dst_w: u32,
        dst_h: u32,
        src: &[u8],
        src_w: u32,
        src_h: u32,
        dst_x: i64,
        dst_y: i64,
        opacity: f64,
        mask: Option<(f32, f32, f32, f32)>,
    ) {
        let dst_w = dst_w as i64;
        let dst_h = dst_h as i64;
        let src_w = src_w as i64;
        let src_h = src_h as i64;

        // 计算有效重叠区域
        let x_start = dst_x.max(0);
        let y_start = dst_y.max(0);
        let x_end = (dst_x + src_w).min(dst_w);
        let y_end = (dst_y + src_h).min(dst_h);

        if x_start >= x_end || y_start >= y_end {
            return; // 无重叠
        }

        for dy in y_start..y_end {
            let sy = dy - dst_y; // 源帧中的 y 坐标
            for dx in x_start..x_end {
                let sx = dx - dst_x; // 源帧中的 x 坐标

                // wipe 遮罩：仅保留画布归一化矩形内的像素
                if let Some((mx0, my0, mx1, my1)) = mask {
                    let nx = dx as f32 / dst_w as f32;
                    let ny = dy as f32 / dst_h as f32;
                    if nx < mx0 || nx > mx1 || ny < my0 || ny > my1 {
                        continue;
                    }
                }

                let src_idx = ((sy * src_w + sx) as usize) * 4;
                let dst_idx = ((dy * dst_w + dx) as usize) * 4;

                // 源像素 alpha（乘以全局 opacity）
                let src_a = (src[src_idx + 3] as f64 / 255.0) * opacity;
                if src_a < 1e-6 {
                    continue; // 完全透明，跳过
                }

                let dst_a = dst[dst_idx + 3] as f64 / 255.0;

                // Over 合成
                let out_a = src_a + dst_a * (1.0 - src_a);
                if out_a < 1e-6 {
                    dst[dst_idx..dst_idx + 4].copy_from_slice(&[0, 0, 0, 0]);
                    continue;
                }

                let inv_out = 1.0 / out_a;
                for c in 0..3 {
                    let src_c = src[src_idx + c] as f64;
                    let dst_c = dst[dst_idx + c] as f64;
                    let out_c = (src_c * src_a + dst_c * dst_a * (1.0 - src_a)) * inv_out;
                    dst[dst_idx + c] = out_c.round().clamp(0.0, 255.0) as u8;
                }
                dst[dst_idx + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    /// 获取画布宽度
    pub fn width(&self) -> u32 {
        self.width
    }

    /// 获取画布高度
    pub fn height(&self) -> u32 {
        self.height
    }
}

// ════════════════════ 辅助函数 ════════════════════

/// 创建默认 Transform（居中、无缩放、无旋转、完全不透明）
pub fn default_transform() -> Transform {
    Transform::default()
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn make_frame(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8, timestamp: f64) -> VideoFrame {
        VideoFrame {
            width: w,
            height: h,
            format: PixelFormat::Rgba8,
            data: [r, g, b, a].repeat((w as usize) * (h as usize)),
            timestamp,
            source_asset_id: String::new(),
            source_time: 0.0,
        }
    }

    fn make_layer(frame: VideoFrame, tf: Transform) -> CompositeLayer {
        CompositeLayer { frame, transform: tf, reveal_mask: None }
    }

    #[test]
    fn test_empty_composite_is_black() {
        let comp = Compositor::new(10, 10);
        let result = comp.composite(&[]);
        assert_eq!(result.width, 10);
        assert_eq!(result.height, 10);
        // 空合成应为黑色不透明
        for chunk in result.data.chunks_exact(4) {
            assert_eq!(chunk, &[0, 0, 0, 255]);
        }
    }

    #[test]
    fn test_single_opaque_layer() {
        let comp = Compositor::new(4, 4);
        let frame = make_frame(4, 4, 255, 0, 0, 255, 0.0); // 红色不透明
        let layer = make_layer(frame, default_transform());

        let result = comp.composite(&[layer]);

        // 整个画布应为红色不透明
        for chunk in result.data.chunks_exact(4) {
            assert_eq!(chunk, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn test_over_blit_basic() {
        let mut canvas = vec![0u8; 2 * 2 * 4]; // 透明画布
        let src = vec![255, 0, 0, 255, 0, 255, 0, 255,
                       0, 0, 255, 255, 255, 255, 0, 255]; // 2x2 源

        Compositor::over_blit(&mut canvas, 2, 2, &src, 2, 2, 0, 0, 1.0, None);

        // 源不透明 → 画布应完全被覆盖
        assert_eq!(&canvas[0..4], &[255, 0, 0, 255]);
        assert_eq!(&canvas[4..8], &[0, 255, 0, 255]);
        assert_eq!(&canvas[8..12], &[0, 0, 255, 255]);
        assert_eq!(&canvas[12..16], &[255, 255, 0, 255]);
    }

    #[test]
    fn test_over_blit_partial_offset() {
        // 4x4 透明画布，2x2 源放在 (1,1)
        let mut canvas = vec![0u8; 4 * 4 * 4];
        let src = [255, 0, 0, 255].repeat(2 * 2); // 红色 2x2

        Compositor::over_blit(&mut canvas, 4, 4, &src, 2, 2, 1, 1, 1.0, None);

        // (0,0) 应透明
        assert_eq!(&canvas[0..4], &[0, 0, 0, 0]);
        // (1,1) 应红色（覆盖区域左上角）
        let idx = (1 * 4 + 1) * 4;
        assert_eq!(&canvas[idx..idx + 4], &[255, 0, 0, 255]);
        // (2,2) 应红色（覆盖区域右下角）
        let idx = (2 * 4 + 2) * 4;
        assert_eq!(&canvas[idx..idx + 4], &[255, 0, 0, 255]);
        // (3,3) 应透明（不在覆盖范围内）
        let idx = (3 * 4 + 3) * 4;
        assert_eq!(&canvas[idx..idx + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_over_blit_negative_offset() {
        // 源部分超出画布左上角
        let mut canvas = vec![0u8; 4 * 4 * 4];
        let src = [255, 0, 0, 255].repeat(4 * 4); // 4x4 红色

        Compositor::over_blit(&mut canvas, 4, 4, &src, 4, 4, -2, -2, 1.0, None);

        // 只有右下 2x2 区域被覆盖（坐标 0..2）
        let idx = (1 * 4 + 1) * 4;
        assert_eq!(&canvas[idx..idx + 4], &[255, 0, 0, 255]);
        // (2,2) 不在覆盖范围（x_end = -2+4 = 2, 循环 0..2）
        let idx = (2 * 4 + 2) * 4;
        assert_eq!(&canvas[idx..idx + 4], &[0, 0, 0, 0]);
        // (0,0) 应红色（覆盖范围内）
        assert_eq!(&canvas[0..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn test_over_blit_no_overlap() {
        let mut canvas = vec![0u8; 4 * 4 * 4];
        let src = [255, 0, 0, 255].repeat(2 * 2);

        // 源完全在画布外
        Compositor::over_blit(&mut canvas, 4, 4, &src, 2, 2, 10, 10, 1.0, None);

        // 画布应不变
        for chunk in canvas.chunks_exact(4) {
            assert_eq!(chunk, &[0, 0, 0, 0]);
        }
    }

    #[test]
    fn test_opacity_half() {
        let mut canvas = [0, 0, 0, 255].repeat(4 * 4); // 黑色不透明画布
        let src = [255, 255, 255, 255].repeat(2 * 2); // 白色不透明源

        Compositor::over_blit(&mut canvas, 4, 4, &src, 2, 2, 1, 1, 0.5, None);

        // 50% 白色 over 黑色 → 灰色 (128, 128, 128)
        let idx = (1 * 4 + 1) * 4;
        assert_eq!(canvas[idx], 128, "R should be ~128");
        assert_eq!(canvas[idx + 1], 128, "G should be ~128");
        assert_eq!(canvas[idx + 2], 128, "B should be ~128");
        assert_eq!(canvas[idx + 3], 255, "A should remain 255");
    }

    #[test]
    fn test_scale_nearest_upscale() {
        // 1x1 红色 → 2x2
        let src = vec![255, 0, 0, 255];
        let dst = Compositor::scale_nearest(&src, 1, 1, 2.0, 2.0);

        assert_eq!(dst.len(), 2 * 2 * 4);
        for chunk in dst.chunks_exact(4) {
            assert_eq!(chunk, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn test_scale_nearest_downscale() {
        // 2x2 → 1x1（取左上角像素）
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255,
            0, 0, 255, 255, 255, 255, 0, 255,
        ];
        let dst = Compositor::scale_nearest(&src, 2, 2, 0.5, 0.5);

        assert_eq!(dst.len(), 4);
        assert_eq!(&dst[..], &[255, 0, 0, 255]);
    }

    #[test]
    fn test_two_layers_over() {
        // 底层：半透明红色 → 顶层：半透明绿色
        let comp = Compositor::new(2, 2);
        let bottom = make_frame(2, 2, 255, 0, 0, 128, 0.0);
        let top = make_frame(2, 2, 0, 255, 0, 128, 0.0);

        let mut tf = default_transform();
        tf.opacity = 1.0; // opacity 已在帧 alpha 中

        let layers = vec![
            make_layer(bottom, tf.clone()),
            make_layer(top, tf),
        ];

        let result = comp.composite(&layers);

        // 底层 alpha=128/255≈0.502
        // 顶层 alpha=128/255≈0.502
        // out_a = 0.502 + 0.502*(1-0.502) ≈ 0.753
        // out_r = (0*0.502 + 255*0.502*0.498) / 0.753 ≈ 84
        // out_g = (255*0.502 + 0*0.502*0.498) / 0.753 ≈ 170
        let px = &result.data[0..4];
        assert!(px[0] > 70 && px[0] < 100, "R should be ~84, got {}", px[0]);
        assert!(px[1] > 150 && px[1] < 190, "G should be ~170, got {}", px[1]);
        assert!(px[3] > 180 && px[3] < 210, "A should be ~193, got {}", px[3]);
    }

    #[test]
    fn test_transform_position() {
        // contain-fit 下显示尺寸基于画布：4x4 画布、4x4 红色帧（aspect=1 与画布一致，
        // fit 因子=1）缩放 0.25 → 显示尺寸 = 4 * 1 * 0.25 = 1px。
        // 放在 (x=0.25, y=0.25 → 中心在 (1,1))，应仅覆盖像素 (1,1)。
        let comp = Compositor::new(4, 4);
        let frame = make_frame(4, 4, 255, 0, 0, 255, 0.0);

        let mut tf = default_transform();
        tf.x = 0.25;
        tf.y = 0.25;
        tf.scale_x = 0.25;
        tf.scale_y = 0.25;

        let result = comp.composite(&[make_layer(frame, tf)]);

        // 像素 (1,1) 应为红色
        let idx = (1 * 4 + 1) * 4;
        assert_eq!(&result.data[idx..idx + 4], &[255, 0, 0, 255]);
        // (0,0) 应透明
        assert_eq!(&result.data[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_transform_scale() {
        // 4x4 画布，1x1 红色帧缩放 4x → 覆盖整个画布
        let comp = Compositor::new(4, 4);
        let frame = make_frame(1, 1, 255, 0, 0, 255, 0.0);

        let mut tf = default_transform();
        tf.scale_x = 4.0;
        tf.scale_y = 4.0;

        let result = comp.composite(&[make_layer(frame, tf)]);

        // 整个画布应为红色
        for chunk in result.data.chunks_exact(4) {
            assert_eq!(chunk, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn test_transform_opacity_zero() {
        let comp = Compositor::new(2, 2);
        let frame = make_frame(2, 2, 255, 0, 0, 255, 0.0);

        let mut tf = default_transform();
        tf.opacity = 0.0;

        let result = comp.composite(&[make_layer(frame, tf)]);

        // opacity=0 → 完全透明
        for chunk in result.data.chunks_exact(4) {
            assert_eq!(chunk[3], 0, "alpha should be 0 with opacity=0");
        }
    }

    #[test]
    fn test_rotate_45_800x800() {
        // 800x800 不透明红块旋转 45°：输出为外接矩形 AABB（≈1132x1132），
        // 菱形之内不透明红，AABB 四角透明——与 WebGPU 预览原始 shader 一致。
        let w = 800u32;
        let h = 800u32;
        let src = [255, 0, 0, 255].repeat((w * h) as usize);
        let (dst, out_w, out_h) = Compositor::rotate_rgba(&src, w, h, 45.0);
        // AABB 尺寸 = ceil(800 * sqrt(2)) = 1132。
        assert_eq!(out_w, 1132, "AABB width should be ceil(800*sqrt(2))");
        assert_eq!(out_h, 1132, "AABB height should be ceil(800*sqrt(2))");
        let px = |x: u32, y: u32| -> &[u8] {
            &dst[((y * out_w + x) as usize) * 4..((y * out_w + x) as usize) * 4 + 4]
        };
        // AABB 四角在菱形之外 → 透明。
        assert_eq!(px(0, 0), &[0, 0, 0, 0], "TL corner must be transparent");
        assert_eq!(px(out_w - 1, 0), &[0, 0, 0, 0], "TR corner must be transparent");
        assert_eq!(px(0, out_h - 1), &[0, 0, 0, 0], "BL corner must be transparent");
        assert_eq!(px(out_w - 1, out_h - 1), &[0, 0, 0, 0], "BR corner must be transparent");
        // 菱形主体：贯穿中心的横/纵线应整段为红（旋转后矩形=菱形，不缩放不变形）。
        // 用几何中心 (AABB 尺寸-1)/2，避免半像素取整误差。
        let cw = ((out_w as i64 - 1) / 2) as u32;
        let ch = ((out_h as i64 - 1) / 2) as u32;
        for x in (cw - 200)..=(cw + 200) {
            assert_eq!(px(x, ch), &[255, 0, 0, 255], "horizontal spine must be red");
        }
        for y in (ch - 200)..=(ch + 200) {
            assert_eq!(px(cw, y), &[255, 0, 0, 255], "vertical spine must be red");
        }
        // 中心仍是红。
        assert_eq!(px(cw, ch), &[255, 0, 0, 255], "center must be red");
    }

    #[test]
    fn test_default_transform_centered() {
        let tf = default_transform();
        assert_eq!(tf.x, 0.5);
        assert_eq!(tf.y, 0.5);
        assert_eq!(tf.scale_x, 1.0);
        assert_eq!(tf.scale_y, 1.0);
        assert_eq!(tf.opacity, 1.0);
    }

    #[test]
    fn test_rotate_identity() {
        // 0 度旋转应原样返回 (data, w, h)
        let src = [255, 0, 0, 255].repeat(4 * 4);
        let (dst, out_w, out_h) = Compositor::rotate_rgba(&src, 4, 4, 0.0);
        assert_eq!(dst, src);
        assert_eq!(out_w, 4);
        assert_eq!(out_h, 4);
    }

    #[test]
    fn test_rotate_direction_matches_preview() {
        // 方向锁定：源为竖版(20x40)「上红下蓝」竖条，旋转 +90°。
        // 预览约定（正角=CCW）：顶部红条转到屏幕左侧 → 输出左半应为红、右半应为蓝。
        // 若方向被反转（误对角度取负），结果会左右颠倒，本测试即失败。
        let w = 20u32;
        let h = 40u32;
        let mut src = vec![0u8; (w * h * 4) as usize];
        for r in 0..h {
            let col = if r < h / 2 {
                [255u8, 0, 0, 255]
            } else {
                [0u8, 0, 255, 255]
            };
            for c in 0..w {
                let i = ((r * w + c) as usize) * 4;
                src[i..i + 4].copy_from_slice(&col);
            }
        }
        let (dst, out_w, out_h) = Compositor::rotate_rgba(&src, w, h, 90.0);
        let px = |x: u32, y: u32| -> &[u8] {
            &dst[((y * out_w + x) as usize) * 4..((y * out_w + x) as usize) * 4 + 4]
        };
        // 输出应为 ≈40x20（竖版转横，含浮点 epsilon 取整允许 ±1）。
        // 取安全内列 x=10（左）、x=30（右），纵向中段均不透明。
        assert!(out_w >= 40 && out_w <= 41, "AABB width ~40, got {}", out_w);
        assert!(out_h >= 20 && out_h <= 21, "AABB height ~20, got {}", out_h);
        for y in 4..16 {
            assert_eq!(px(10, y), &[255, 0, 0, 255], "left half must be red (preview CCW)");
            assert_eq!(px(30, y), &[0, 0, 255, 255], "right half must be blue (preview CCW)");
        }
    }

    #[test]
    fn test_rotate_45_transparent_corners() {
        // 8x8 不透明红块旋转 45°：输出 AABB ≈12x12，菱形之内不透明红，
        // AABB 四角透明，与 WebGPU 预览原始 shader（无额外矩形裁剪）一致。
        let w = 8u32;
        let h = 8u32;
        let src = [255, 0, 0, 255].repeat((w * h) as usize);
        let (dst, out_w, out_h) = Compositor::rotate_rgba(&src, w, h, 45.0);

        // AABB 尺寸 = ceil(8 * sqrt(2)) = 12。
        assert_eq!(out_w, 12, "AABB width should be 12");
        assert_eq!(out_h, 12, "AABB height should be 12");

        let px = |x: u32, y: u32| -> &[u8] {
            &dst[((y * out_w + x) as usize) * 4..((y * out_w + x) as usize) * 4 + 4]
        };

        // AABB 四角在菱形之外 → 透明
        assert_eq!(px(0, 0), &[0, 0, 0, 0], "TL corner should be transparent");
        assert_eq!(px(out_w - 1, 0), &[0, 0, 0, 0], "TR corner should be transparent");
        assert_eq!(px(0, out_h - 1), &[0, 0, 0, 0], "BL corner should be transparent");
        assert_eq!(px(out_w - 1, out_h - 1), &[0, 0, 0, 0], "BR corner should be transparent");

        // 中心点：原始红块核心，旋转后仍完全不透明且为红
        let c = px(out_w / 2, out_h / 2);
        assert_eq!(c, &[255, 0, 0, 255], "center should be opaque red");
    }

    #[test]
    fn test_composite_with_rotation() {
        // 画布 8x8。底层蓝色（不透明），顶层红色旋转 45°（菱形内红，菱形四角透明）→
        // 红块菱形覆盖处为红，菱形外的矩形四角仍为蓝；中心红。
        let comp = Compositor::new(8, 8);
        let blue = make_frame(8, 8, 0, 0, 255, 255, 0.0);
        let red = make_frame(8, 8, 255, 0, 0, 255, 0.0);

        let mut tf_red = default_transform();
        tf_red.rotation = 45.0;

        let layers = vec![
            make_layer(blue, default_transform()),
            make_layer(red, tf_red),
        ];
        let result = comp.composite(&layers);

        let px = |x: u32, y: u32| -> &[u8] {
            &result.data[((y * 8 + x) as usize) * 4..((y * 8 + x) as usize) * 4 + 4]
        };

        // 四角在旋转后的菱形之外 → 露出底层蓝色
        assert_eq!(px(0, 0), &[0, 0, 255, 255], "TL corner should show blue bg");
        assert_eq!(px(7, 0), &[0, 0, 255, 255], "TR corner should show blue bg");
        assert_eq!(px(0, 7), &[0, 0, 255, 255], "BL corner should show blue bg");
        assert_eq!(px(7, 7), &[0, 0, 255, 255], "BR corner should show blue bg");

        // 中心应为红（旋转后主体）
        let c = px(4, 4);
        assert_eq!(c, &[255, 0, 0, 255], "center should be red");
    }

    #[test]
    fn test_rotate_clip_at_canvas_edge() {
        // 场景 B：红块紧贴右边缘 (x=1.0) 旋转 45°，超出全局画布的角应由 over_blit
        // 按画布坐标裁切为黑色背景，而非在帧内部挖出透明角。
        let comp = Compositor::new(12, 12);
        let red = make_frame(12, 12, 255, 0, 0, 255, 0.0);
        let mut tf_red = default_transform();
        tf_red.x = 1.0; // 中心贴在右边缘
        tf_red.rotation = 45.0;
        let result = comp.composite(&[make_layer(red, tf_red)]);

        let mut bg_count = 0usize;
        let mut red_count = 0usize;
        for i in 0..(12 * 12) {
            let p = &result.data[i * 4..i * 4 + 4];
            // 合成结果只应出现两种像素：不透明红，或透明黑(背景)——不得出现
            // 半透明 / 内部透明角（即 alpha 非 0 非 255）。
            assert!(p[3] == 0 || p[3] == 255, "像素 alpha 应为 0 或 255（无内部透明角）");
            if p == &[0, 0, 0, 0] {
                bg_count += 1;
            } else if p == &[255, 0, 0, 255] {
                red_count += 1;
            }
        }
        assert!(bg_count > 0, "超出画布部分应被裁切为黑色背景");
        assert!(red_count > 0, "红块主体应出现在画布内");
    }
}
