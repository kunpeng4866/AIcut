//! tests/speech_assemble_separated_pause.rs — 分离路径「暂停压缩」落地验证
//!
//! 目标：验证 `aicut_engine::speech::speech_assemble` 在 `separated:true` 且收到
//! `keepSegmentsOut`（输出时间轴）时，确实把「压缩后的短停顿」落到了音频输出，并保留背景音乐：
//!   (a) 输出文件时长 ≈ 2 + gap + 2 = 4.35s（gap 被压缩到 0.35s，而非源 2s）；
//!   (b) 输出 [2.0, 2.35]s 区间含伴奏音频（背景音乐未被删，RMS 远高于静音）；
//!   (c) 该 gap 时长 ≈ 0.35s（非源 2s）——由 (a) 的总时长反推 + 频段能量定位证明。
//! 回退：相同输入但不带 `keepSegmentsOut` → 旧行为（vocal Mix + 完整源时长 accomp 桥接，
//!     输出 ≈ 6s，[2,4] 区间为完整 2s 背景音乐）。
//!
//! 不依赖 Demucs：用 ffmpeg 合成 3 个素材（vocal.wav / accomp.wav / input.mp4）模拟分离 stem。
//! 运行：`cargo test --test speech_assemble_separated_pause`
//! （ffmpeg/ffprobe 需在 PATH 或经 AICUT_FFMPEG/AICUT_FFPROBE 暴露）。

use std::path::{Path, PathBuf};
use std::process::Command;

fn ffmpeg() -> String {
    std::env::var("AICUT_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}
fn ffprobe() -> String {
    std::env::var("AICUT_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}

fn run_ffmpeg(args: &[&str]) -> bool {
    Command::new(ffmpeg())
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 取输出某子区间的音频平均音量（dB，volumedetect）。越接近 -91 越静音。
fn mean_volume(p: &Path, start: f64, dur: f64) -> f64 {
    let out = Command::new(ffmpeg())
        .args([
            "-ss",
            &format!("{:.3}", start),
            "-t",
            &format!("{:.3}", dur),
            "-i",
            p.to_str().unwrap(),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg volumedetect 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    for line in s.lines() {
        if let Some(pos) = line.find("mean_volume:") {
            let val = line[pos + "mean_volume:".len()..].trim().trim_end_matches(" dB");
            if let Ok(x) = val.parse::<f64>() {
                return x;
            }
        }
    }
    f64::MAX
}

/// 取某子区间「某中心频率附近」的音频平均音量（dB）：用高/低通带通抽出该频段的能量，
/// 再用 volumedetect 量 RMS。用于区分 vocal(440Hz) 与 accomp(220Hz) 频段。
fn band_rms(p: &Path, start: f64, dur: f64, freq: f64) -> f64 {
    let lo = (freq - 40.0).max(20.0);
    let hi = freq + 40.0;
    let af = format!("highpass=f={:.0},lowpass=f={:.0},volumedetect", lo, hi);
    let out = Command::new(ffmpeg())
        .args([
            "-ss",
            &format!("{:.3}", start),
            "-t",
            &format!("{:.3}", dur),
            "-i",
            p.to_str().unwrap(),
            "-af",
            &af,
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg band volumedetect 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    for line in s.lines() {
        if let Some(pos) = line.find("mean_volume:") {
            let val = line[pos + "mean_volume:".len()..].trim().trim_end_matches(" dB");
            if let Ok(x) = val.parse::<f64>() {
                return x;
            }
        }
    }
    f64::MAX
}

/// 用 ffprobe 取文件时长（秒）。
fn probe_duration(p: &Path) -> f64 {
    let out = Command::new(ffprobe())
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            p.to_str().unwrap(),
        ])
        .output()
        .expect("ffprobe 失败");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(f64::NAN)
}

/// 生成合成素材（幂等：已存在则复用）。
///   - vocal.wav : 440Hz tone 块 [0,2] + 静音 [2,4] + 440Hz tone 块 [4,6]（总 ≈6s）
///   - accomp.wav: 220Hz tone 全程（≈6s），模拟背景音乐 stem
///   - input.mp4 : 纯蓝画面视频（≈6s），分离路径只用其视频轨
fn ensure_materials() -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir();
    let vocal = dir.join("aicut_sep_test_vocal.wav");
    let accomp = dir.join("aicut_sep_test_accomp.wav");
    let input = dir.join("aicut_sep_test_input.mp4");

    if !vocal.exists() {
        assert!(
            run_ffmpeg(&[
                "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=6",
                "-filter_complex",
                "[0]atrim=0:2,asetpts=PTS-STARTPTS[a];\
                 [1]atrim=2:4,asetpts=PTS-STARTPTS[b];\
                 [0]atrim=4:6,asetpts=PTS-STARTPTS[c];\
                 [a][b][c]concat=n=3:v=0:a=1",
                "-ar", "48000", "-ac", "2",
                vocal.to_str().unwrap(),
            ]),
            "生成 vocal.wav 失败"
        );
    }
    if !accomp.exists() {
        assert!(
            run_ffmpeg(&[
                "-y",
                "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
                "-ar", "48000", "-ac", "2",
                accomp.to_str().unwrap(),
            ]),
            "生成 accomp.wav 失败"
        );
    }
    if !input.exists() {
        assert!(
            run_ffmpeg(&[
                "-y",
                "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=6:r=25",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                input.to_str().unwrap(),
            ]),
            "生成 input.mp4 失败"
        );
    }
    (vocal, accomp, input)
}

fn fmt_segs(segs: &[(f64, f64)]) -> String {
    let mut s = String::new();
    for (i, (a, b)) in segs.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("[{:.6},{:.6}]", a, b));
    }
    s
}

fn build_opts(
    vocal: &Path,
    accomp: &Path,
    ks: &[(f64, f64)],
    ko: Option<&[(f64, f64)]>,
    music: &[(f64, f64)],
    crossfade_ms: f64,
    output: &Path,
) -> String {
    let k = fmt_segs(ks);
    let m = fmt_segs(music);
    let o = output.to_string_lossy().replace('\\', "/");
    let v = vocal.to_string_lossy().replace('\\', "/");
    let ac = accomp.to_string_lossy().replace('\\', "/");
    match ko {
        Some(ko) => format!(
            "{{\"separated\":true,\"vocalPath\":\"{}\",\"accompPath\":\"{}\",\
             \"keepSegments\":[{}],\"keepSegmentsOut\":[{}],\"musicSegments\":[{}],\
             \"crossfadeMs\":{:.3},\"outputPath\":\"{}\"}}",
            v, ac, k, fmt_segs(ko), m, crossfade_ms, o
        ),
        None => format!(
            "{{\"separated\":true,\"vocalPath\":\"{}\",\"accompPath\":\"{}\",\
             \"keepSegments\":[{}],\"musicSegments\":[{}],\
             \"crossfadeMs\":{:.3},\"outputPath\":\"{}\"}}",
            v, ac, k, m, crossfade_ms, o
        ),
    }
}

#[test]
fn separated_pause_compress_lands_and_keeps_music() {
    let (vocal, accomp, input) = ensure_materials();
    let vocal_s = vocal.to_str().unwrap();
    let accomp_s = accomp.to_str().unwrap();
    let _ = (vocal_s, accomp_s); // 路径仅在 opts JSON 中使用，抑制未用警告
    let input_s = input.to_str().unwrap();

    let ks: Vec<(f64, f64)> = vec![(0.0, 2.0), (4.0, 6.0)];
    let ko: Vec<(f64, f64)> = vec![(0.0, 2.0), (2.35, 4.35)];
    let music: Vec<(f64, f64)> = vec![(2.0, 4.0)];

    // ---------- 1) 暂停压缩路径：带 keepSegmentsOut ----------
    let out1 = std::env::temp_dir().join("aicut_sep_pause_out.mp4");
    let opts1 = build_opts(&vocal, &accomp, &ks, Some(&ko), &music, 0.0, &out1);
    println!("[pause] opts = {}", opts1);
    let r1 = aicut_engine::speech::speech_assemble(input_s, &opts1)
        .expect("暂停压缩 assemble 失败");
    let d1 = r1["duration"].as_f64().expect("out1 duration");
    // 校验实测文件时长（probe）与返回时长一致
    let probe_d1 = probe_duration(&out1);
    println!(
        "[pause] 返回 duration={:.3}s 实测 probe={:.3}s",
        d1, probe_d1
    );

    // 验收 (a)：输出时长 ≈ 2 + 0.35 + 2 = 4.35s（容差 0.1）
    assert!(
        (d1 - 4.35).abs() < 0.1,
        "(a) 暂停压缩输出时长应 ≈4.35s（2+0.35+2），实际 {:.3}s",
        d1
    );

    // 验收 (b)：输出 [2.0, 2.35]s 区间含伴奏音频（背景音乐未被删）
    //   - 该区间应存在明显能量（mean_volume 远高于静音 -91）；
    //   - 且该区间应以 220Hz 伴奏为主（220Hz 频段能量明显高于 440Hz 频段，证明是 accomp 桥接、
    //     而非被删成静音，也非混入了 vocal 段——440Hz 仅来自 220Hz 谐波泄漏，故弱于 220Hz）。
    let mv_bridge = mean_volume(&out1, 2.05, 0.25);
    let rms_vocal_in_bridge = band_rms(&out1, 2.05, 0.25, 440.0);
    let rms_accomp_in_bridge = band_rms(&out1, 2.05, 0.25, 220.0);
    println!(
        "[pause] bridge[2.05,2.30] mean={:.1}dB 440Hz={:.1}dB 220Hz={:.1}dB",
        mv_bridge, rms_vocal_in_bridge, rms_accomp_in_bridge
    );
    assert!(
        mv_bridge > -40.0,
        "(b) gap[2.0,2.35] 应含背景音乐(mean_volume 非静音)，实际 {:.1}dB",
        mv_bridge
    );
    assert!(
        rms_accomp_in_bridge > -40.0,
        "(b) gap 应有 220Hz 伴奏成分，实际 {:.1}dB",
        rms_accomp_in_bridge
    );
    // 桥接段应以伴奏(220Hz)为主：220Hz 频段比 440Hz 频段强 ≥3dB（440Hz 仅谐波泄漏）
    assert!(
        rms_accomp_in_bridge > rms_vocal_in_bridge + 3.0,
        "(b) gap 应为 accomp-dominant 桥接（220Hz 明显强于 440Hz）：220Hz {:.1}dB vs 440Hz {:.1}dB",
        rms_accomp_in_bridge, rms_vocal_in_bridge
    );

    // 验收 (c)：gap 时长 ≈0.35s（非源 2s）
    //   输出 = seg0(2s) + gap + seg1(2s) → gap = duration - 4.0
    let gap = d1 - 4.0;
    println!("[pause] 反推 gap 时长 = {:.3}s", gap);
    assert!(
        (gap - 0.35).abs() < 0.1,
        "(c) 压缩后 gap 应 ≈0.35s（非源 2s），实际 {:.3}s",
        gap
    );
    // 进一步：gap 明显短于源 2s（证明被压缩而非整段保留）
    assert!(gap < 1.0, "(c) gap 应被压缩，应 <1s，实际 {:.3}s", gap);

    // ---------- 2) 回退路径：不带 keepSegmentsOut → 旧行为（无压缩） ----------
    let out2 = std::env::temp_dir().join("aicut_sep_fallback_out.mp4");
    let opts2 = build_opts(&vocal, &accomp, &ks, None, &music, 0.0, &out2);
    println!("[fallback] opts = {}", opts2);
    let r2 = aicut_engine::speech::speech_assemble(input_s, &opts2)
        .expect("回退 assemble 失败");
    let d2 = r2["duration"].as_f64().expect("out2 duration");
    println!("[fallback] 输出时长={:.3}s", d2);

    // 回退输出 ≈ 各段和（2+2+2=6，crossfadeMs=0 无 acrossfade 缩短），容差 0.1
    assert!(
        (d2 - 6.0).abs() < 0.1,
        "(fallback) 无 keepSegmentsOut 时输出应 ≈6s（vocal Mix + 完整源时长 accomp 桥接），实际 {:.3}s",
        d2
    );
    // 回退路径 [2,4] 区间应为完整 2s 背景音乐（源 gap 原长铺满，未压缩）
    let mv_fb = mean_volume(&out2, 2.5, 1.5);
    let rms_accomp_fb = band_rms(&out2, 2.5, 1.5, 220.0);
    println!(
        "[fallback] [2.5,4.0] mean={:.1}dB 220Hz={:.1}dB",
        mv_fb, rms_accomp_fb
    );
    assert!(
        mv_fb > -40.0,
        "(fallback) [2,4] 应铺满完整背景音乐，实际 mean {:.1}dB",
        mv_fb
    );
    // 关键对比：暂停压缩输出应明显短于回退输出（gap 被压缩）
    assert!(
        d1 < d2 - 1.0,
        "暂停压缩输出({:.3}s) 应明显短于回退输出({:.3}s)，证明 gap 被压缩而非保留 2s",
        d1, d2
    );

    println!("\n=== 分离路径暂停压缩验证：全部断言通过（pause={:.3}s, fallback={:.3}s, 反推gap={:.3}s）===", d1, d2, gap);
}
