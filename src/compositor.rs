//! 多轨道合成器 — 逐轨道 Over 合成（RGBA alpha 混合）
//!
//! 合成模型：Source Over（Porter-Duff）
//!   out_a = src_a + dst_a * (1 - src_a)
//!   out_c = (src_c * src_a + dst_c * dst_a * (1 - src_a)) / out_a   (out_a > 0 时)
//!
//! Transform 应用顺序：缩放 → 旋转（预留）→ 位置 → 不透明度

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

        // 1. 缩放
        let scaled = if (tf.scale_x - 1.0).abs() < f64::EPSILON
            && (tf.scale_y - 1.0).abs() < f64::EPSILON
        {
            // 无缩放，直接用原帧
            frame.data.clone()
        } else {
            Self::scale_nearest(
                &frame.data,
                frame.width,
                frame.height,
                tf.scale_x,
                tf.scale_y,
            )
        };

        let scaled_w = ((frame.width as f64) * tf.scale_x).round().max(1.0) as u32;
        let scaled_h = ((frame.height as f64) * tf.scale_y).round().max(1.0) as u32;

        // 2. 计算目标位置（Transform.x/y 是归一化坐标，0.5 = 中心）
        //    帧-> 画布上的左上角
        let center_x = tf.x * (self.width as f64);
        let center_y = tf.y * (self.height as f64);
        let dst_x = (center_x - (scaled_w as f64) / 2.0).round() as i64;
        let dst_y = (center_y - (scaled_h as f64) / 2.0).round() as i64;

        // 3. Over 合成（应用 opacity）
        let opacity = tf.opacity.clamp(0.0, 1.0);
        Self::over_blit(
            canvas,
            self.width,
            self.height,
            &scaled,
            scaled_w,
            scaled_h,
            dst_x,
            dst_y,
            opacity,
            layer.reveal_mask,
        );

        // TODO: 旋转 — 需要 3-pass shear 或矩阵插值，当前预留接口
        // if tf.rotation.abs() > f64::EPSILON { ... }
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
    Transform {
        x: 0.5,
        y: 0.5,
        scale_x: 1.0,
        scale_y: 1.0,
        rotation: 0.0,
        opacity: 1.0,
    }
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
        // 4x4 画布，1x1 红色帧放在左上角 (x=0.25, y=0.25 → 中心在 (1,1))
        let comp = Compositor::new(4, 4);
        let frame = make_frame(1, 1, 255, 0, 0, 255, 0.0);

        let mut tf = default_transform();
        tf.x = 0.25;
        tf.y = 0.25;

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
    fn test_default_transform_centered() {
        let tf = default_transform();
        assert_eq!(tf.x, 0.5);
        assert_eq!(tf.y, 0.5);
        assert_eq!(tf.scale_x, 1.0);
        assert_eq!(tf.scale_y, 1.0);
        assert_eq!(tf.opacity, 1.0);
    }
}
