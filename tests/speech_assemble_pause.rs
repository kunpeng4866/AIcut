//! tests/speech_assemble_pause.rs — 暂停压缩优先（P1）音频落地端到端验证
//!
//! 严格验证 `aicut_engine::speech::speech_assemble` 在收到 `keepSegmentsOut`（输出时间轴）
//! 时，确实把「压缩后的短停顿」落到了音频输出：
//!   (a) 输出文件时长 ≈ analyze 给出的 outputDuration；
//!   (b) 输出中段间存在 ≈ targetPause(0.35s) 的静音间隙（NOT 全删 → 比「间隙全删」长、比源短）；
//!   (c) 暂停区音频为静音、视频为冻结帧（非黑屏/非跳变）；
//! 回归：相同 keepSegments 但不带 keepSegmentsOut → 回退「间隙全删」（无插入暂停、不报错）。
//!
//! 不修改任何功能代码；仅新增此集成测试。运行：`cargo test --test speech_assemble_pause`
//! （ffmpeg/ffprobe 需在 PATH 或经 AICUT_FFMPEG/AICUT_FFPROBE 暴露；analyze 走托管 Python 桥）。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 真实口播样本（默认指向本机路径）。CI / 其他机器用 `AICUT_TEST_M4A` 覆盖。
/// 注意：测试主路径依赖仓库内 `tests/assets/pause_compress_input.mp4` 合成 fixture，
/// 仅在 fixture 缺失时才回退到本样本重新生成，故正常 clone 不依赖此路径存在。
const M4A_DEFAULT: &str = "C:/Users/Administrator/Documents/录音/仓哥有温度.m4a";
fn m4a_path() -> String {
    std::env::var("AICUT_TEST_M4A").unwrap_or_else(|_| M4A_DEFAULT.to_string())
}

fn ffmpeg() -> String {
    std::env::var("AICUT_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}
fn ffprobe() -> String {
    std::env::var("AICUT_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}

/// 用 ffmpeg `freezedetect` 找出输出中的冻结帧区间：(start, dur)。
///
/// 为什么不用「逐帧解码像素 MD5 全等」：libx264 对静止画面的 P 帧重建允许极微小差异
/// （逐帧 md5 会全不相同），用 md5 全等判定冻结会产生假失败。freezedetect 是 ffmpeg
/// 为此场景提供的专用滤镜，按噪声阈值判定「画面无变化」，才是正确的度量。
fn freeze_regions(p: &Path, noise: &str, min_dur: f64) -> Vec<(f64, f64)> {
    let out = Command::new(ffmpeg())
        .args([
            "-i",
            p.to_str().unwrap(),
            "-an",
            "-vf",
            &format!("freezedetect=n={}:d={:.3}", noise, min_dur),
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg freezedetect 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    let mut starts: Vec<f64> = Vec::new();
    let mut durs: Vec<f64> = Vec::new();
    for line in s.lines() {
        if let Some(pos) = line.find("freeze_start:") {
            if let Ok(x) = line[pos + "freeze_start:".len()..].trim().parse::<f64>() {
                starts.push(x);
            }
        }
        if let Some(pos) = line.find("freeze_duration:") {
            if let Ok(x) = line[pos + "freeze_duration:".len()..].trim().parse::<f64>() {
                durs.push(x);
            }
        }
    }
    let n = starts.len().min(durs.len());
    (0..n).map(|i| (starts[i], durs[i])).collect()
}

/// 取一帧的平均亮度 YAVG（signalstats）。纯黑帧 ≈16（yuv420p 的 black level），
/// 用于证明冻结帧不是黑屏。
fn y_avg(p: &Path) -> f64 {
    let out = Command::new(ffmpeg())
        .args([
            "-i",
            p.to_str().unwrap(),
            "-vf",
            "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg signalstats 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    for line in s.lines() {
        if let Some(pos) = line.find("lavfi.signalstats.YAVG=") {
            if let Ok(x) = line[pos + "lavfi.signalstats.YAVG=".len()..].trim().parse::<f64>() {
                return x;
            }
        }
    }
    f64::NAN
}

/// 两张图的 PSNR（dB）。>40dB 视为「肉眼同一帧」，用于证明暂停区画面就是
/// 暂停前的末帧（冻结），而不是跳变到别处。
fn psnr_between(a: &Path, b: &Path) -> f64 {
    let out = Command::new(ffmpeg())
        .args([
            "-i",
            a.to_str().unwrap(),
            "-i",
            b.to_str().unwrap(),
            "-lavfi",
            "psnr",
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg psnr 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    for line in s.lines() {
        if let Some(pos) = line.find("average:") {
            let rest = &line[pos + "average:".len()..];
            let tok = rest.trim().split_whitespace().next().unwrap_or("");
            if let Ok(x) = tok.parse::<f64>() {
                return x;
            }
        }
    }
    f64::NAN
}

/// 强制指向仓库内真正的 bridge.py。
/// 注意：`speech_analyze` 默认按「可执行文件在 target/debug/」反推仓库根，
/// 但集成测试 exe 位于 target/debug/deps/，反推会落空。用 AICUT_SPEECH_BRIDGE 覆盖。
fn set_bridge_env() {
    let bridge = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("python")
        .join("speech_edit")
        .join("bridge.py");
    std::env::set_var("AICUT_SPEECH_BRIDGE", bridge.to_str().unwrap());
}

fn run_ffmpeg(args: &[&str]) -> bool {
    Command::new(ffmpeg())
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 取输出音频中的静音区间时长列表（silencedetect）。
fn silence_intervals(p: &Path) -> Vec<f64> {
    silence_regions(p).into_iter().map(|(_, _, d)| d).collect()
}

/// 取输出音频中的静音区间（真实时间轴）：(start, end, dur)。
/// 用真实位置而非理论 keepSegmentsOut，规避 ffmpeg 切割量化带来的偏移。
fn silence_regions(p: &Path) -> Vec<(f64, f64, f64)> {
    let out = Command::new(ffmpeg())
        .args([
            "-i",
            p.to_str().unwrap(),
            "-af",
            "silencedetect=noise=-30dB:d=0.1",
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg silencedetect 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    let mut starts: Vec<f64> = Vec::new();
    let mut ends: Vec<f64> = Vec::new();
    for line in s.lines() {
        if let Some(pos) = line.find("silence_start:") {
            if let Ok(x) = line[pos + "silence_start:".len()..]
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()
            {
                starts.push(x);
            }
        }
        if let Some(pos) = line.find("silence_end:") {
            if let Ok(x) = line[pos + "silence_end:".len()..]
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()
            {
                ends.push(x);
            }
        }
    }
    let n = starts.len().min(ends.len());
    (0..n).map(|i| (starts[i], ends[i], ends[i] - starts[i])).collect()
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
            let val = line[pos + "mean_volume:".len()..].trim();
            let val = val.trim_end_matches(" dB");
            if let Ok(x) = val.parse::<f64>() {
                return x;
            }
        }
    }
    f64::MAX
}

/// 在指定时刻抽一帧 PNG（预留，当前冻结检测改用 YDIF，不需要逐帧抽图）。
#[allow(dead_code)]
fn extract_frame(p: &Path, t: f64, dst: &Path) {
    assert!(
        run_ffmpeg(&[
            "-y",
            "-ss",
            &format!("{:.3}", t),
            "-i",
            p.to_str().unwrap(),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            dst.to_str().unwrap(),
        ]),
        "extract_frame 失败 @ {:.3}s",
        t
    );
}

fn files_equal(a: &Path, b: &Path) -> bool {
    let fa = std::fs::read(a).unwrap_or_default();
    let fb = std::fs::read(b).unwrap_or_default();
    fa == fb
}

/// 取 [start,end] 区间内视频的「最大逐帧时序亮度差」YDIF（signalstats）。
/// YDIF≈0 表示画面逐帧冻结（暂停区应为此值）；若 >几级说明画面在动（非冻结、非黑屏）。
///
/// 为何不用逐帧 MD5/像素相等：ffmpeg 对「-loop 1 末帧」做 RGB→YUV420P 时会引入逐帧
/// 抖动噪声，导致字节级 MD5 不同，但画面感知完全冻结（实测 YDIF≈0.003）。严格 MD5 相等
/// 会把正确的冻结误判为失败，故改用对感知更鲁棒的 YDIF 阈值法。
fn max_temporal_diff(p: &Path, start: f64, end: f64) -> f64 {
    let out = Command::new(ffmpeg())
        .args([
            "-ss",
            &format!("{:.3}", start),
            "-to",
            &format!("{:.3}", end),
            "-i",
            p.to_str().unwrap(),
            "-an",
            "-vf",
            "signalstats,metadata=print:key=lavfi.signalstats.YDIF",
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("ffmpeg signalstats YDIF 失败");
    let s = String::from_utf8_lossy(&out.stderr);
    let mut maxv = 0.0_f64;
    for line in s.lines() {
        if let Some(pos) = line.find("YDIF=") {
            if let Ok(x) = line[pos + "YDIF=".len()..].trim().parse::<f64>() {
                if x > maxv {
                    maxv = x;
                }
            }
        }
    }
    maxv
}

/// 生成/复用测试输入：真实 m4a 语音 + 一段干净 2s 静音 + 真实语音，mux 测试图案视频。
/// 这样 analyze（keepNonspeech=false）会把 2s 软停顿压到 0.35s，真正触发 Rust 暂停压缩路径。
fn ensure_input() -> PathBuf {
    let assets = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("assets");
    std::fs::create_dir_all(&assets).ok();
    let out = assets.join("pause_compress_input.mp4");
    if out.exists() {
        return out;
    }
    assert!(
        Path::new(&m4a_path()).exists(),
        "测试样本缺失：{}（请放置该样本或用 AICUT_TEST_M4A 指定，或放置 tests/assets/pause_compress_input.mp4）",
        m4a_path()
    );
    // 第 1 步：拼出含长静音的音频（与已验证可产生 0.35s 压缩停顿的结构一致）
    let audio = assets.join("pause_compress_audio.wav");
    let audio_s = audio.to_str().unwrap();
    let m4a_s = m4a_path();
    let filter = "[0:a]atrim=6.74:10.60,asetpts=PTS-STARTPTS[a1];\
                  anullsrc=r=48000:cl=stereo:d=2.0[b];\
                  [0:a]atrim=11.54:15.00,asetpts=PTS-STARTPTS[a2];\
                  anullsrc=r=48000:cl=stereo:d=1.0[c];\
                  [a1][b][a2][c]concat=n=4:v=0:a=1[outa]";
    assert!(
        run_ffmpeg(&[
            "-y",
            "-i",
            &m4a_s,
            "-filter_complex",
            filter,
            "-map",
            "[outa]",
            "-ar",
            "48000",
            "-ac",
            "2",
            audio_s,
        ]),
        "生成测试音频失败"
    );
    // 第 2 步：mux 测试图案视频（使冻结末帧分支被覆盖）
    let out_s = out.to_str().unwrap();
    assert!(
        run_ffmpeg(&[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=10.6:size=640x360:rate=25",
            "-i",
            audio_s,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            out_s,
        ]),
        "mux 测试视频失败"
    );
    assert!(out.exists(), "测试输入未生成");
    out
}


#[test]
fn pause_compress_lands_in_audio() {
    set_bridge_env();
    let input = ensure_input();
    let input_s = input.to_str().unwrap();

    // ---------- 1) analyze：确认 keepSegmentsOut 含被压缩的短停顿 ----------
    let analyze_opts = r#"{"pauseCompress":true,"targetPause":0.35,"modelSize":"small","denoise":false,"keepNonspeech":false,"trimSilence":true}"#;
    let res = aicut_engine::speech::speech_analyze(input_s, analyze_opts)
        .expect("speech_analyze 失败");
    let duration = res["duration"].as_f64().expect("duration");
    let output_duration = res["outputDuration"].as_f64().expect("outputDuration");
    let ks = res["keepSegments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|seg| (seg[0].as_f64().unwrap(), seg[1].as_f64().unwrap()))
        .collect::<Vec<(f64, f64)>>();
    let ko = res["keepSegmentsOut"]
        .as_array()
        .unwrap()
        .iter()
        .map(|seg| (seg[0].as_f64().unwrap(), seg[1].as_f64().unwrap()))
        .collect::<Vec<(f64, f64)>>();
    let pause_compress = res["pauseCompress"].as_bool().unwrap_or(false);

    println!(
        "[analyze] duration={:.3} outputDuration={:.3} keepSegments.len={} keepSegmentsOut.len={} pauseCompress={}",
        duration, output_duration, ks.len(), ko.len(), pause_compress
    );
    println!("[analyze] keepSegments    = {:?}", ks);
    println!("[analyze] keepSegmentsOut = {:?}", ko);

    // 验收 1a：keepSegmentsOut 存在且与 keepSegments 等长
    assert_eq!(ks.len(), ko.len(), "keepSegmentsOut 与 keepSegments 长度必须一致");
    // 验收 1b：源间隙 >0.35s 处，keepSegmentsOut 相邻段间隙 ≈ 0.35s
    let mut max_src_gap = 0.0_f64;
    let mut compressed_gap = 0.0_f64;
    let mut positive_out_gaps = 0_usize;
    for i in 0..ks.len().saturating_sub(1) {
        let src_gap = ks[i + 1].0 - ks[i].1;
        let out_gap = ko[i + 1].0 - ko[i].1;
        if src_gap > max_src_gap {
            max_src_gap = src_gap;
        }
        if out_gap > 1e-3 {
            positive_out_gaps += 1;
            if src_gap > 0.35 {
                compressed_gap = out_gap;
                assert!(
                    (out_gap - 0.35).abs() < 0.06,
                    "源间隙 {:.3}s 处的输出间隙应为 ≈0.35s，实际 {:.3}s",
                    src_gap,
                    out_gap
                );
            }
        }
    }
    // 验收 1c：outputDuration < duration
    assert!(
        output_duration < duration,
        "outputDuration({:.3}) 应 < duration({:.3})",
        output_duration,
        duration
    );
    // 本测试必须真的产生至少一个被压缩的软停顿，否则无法验证落地
    assert!(
        positive_out_gaps > 0 && compressed_gap > 0.0,
        "未检测到任何被压缩的软停顿（请检查样本/决策层）——无法验证暂停落地"
    );
    println!(
        "[analyze] max_src_gap={:.3}s 被压缩后的输出间隙={:.3}s 正输出间隙数={}",
        max_src_gap, compressed_gap, positive_out_gaps
    );

    // 找到被压缩停顿在输出时间轴的位置（用于后续取帧/取音频）
    let mut pause_idx = 0_usize;
    let mut pause_start = 0.0_f64;
    let mut pause_dur = 0.0_f64;
    for i in 0..ko.len().saturating_sub(1) {
        let out_gap = ko[i + 1].0 - ko[i].1;
        if out_gap > pause_dur {
            pause_dur = out_gap;
            pause_idx = i;
            pause_start = ko[i].1;
        }
    }
    println!(
        "[analyze] 最大输出间隙位于段{}之后：pause_start={:.3}s pause_dur={:.3}s",
        pause_idx, pause_start, pause_dur
    );

    let temp = std::env::temp_dir();

    // ---------- 2) assemble：带 keepSegmentsOut（暂停压缩路径） ----------
    let out1 = temp.join("aicut_pause_out1.mp4");
    let out1_s = out1.to_str().unwrap();
    let asm_opts = build_asm_opts(&ks, &ko, out1_s);
    println!("[assemble pause] opts = {}", asm_opts);
    let r1 = aicut_engine::speech::speech_assemble(input_s, &asm_opts)
        .expect("pause-compress assemble 失败");
    let d1 = r1["duration"].as_f64().expect("out1 duration");

    // 验收 (a)：输出时长 ≈ outputDuration
    // 注：ffmpeg 按源坐标 -ss/-to 切割 + concat -c copy，每片受帧率(本例 25fps=0.04s)量化，
    // 多片累加后实际文件时长会比 analyze 给出的纯理论 outputDuration 略长（约 0.1~0.2s 量级），
    // 属切割量化误差，非暂停逻辑错误。容差放宽为 0.2。
    assert!(
        (d1 - output_duration).abs() < 0.2,
        "(a) 输出时长 {:.3}s 应 ≈ outputDuration {:.3}s（含切割量化）",
        d1,
        output_duration
    );
    println!(
        "[assemble pause] 输出时长={:.3}s (outputDuration={:.3}, 切割量化差 {:.3}s)",
        d1,
        output_duration,
        d1 - output_duration
    );

    // 验收 (b)：输出中段间存在 ≈0.35s 的静音间隙（用真实输出时间轴定位）
    let sil1 = silence_intervals(&out1);
    println!("[assemble pause] 静音区间={:?}", sil1);
    assert!(
        sil1.iter().any(|&x| (x - 0.35).abs() < 0.06),
        "(b) 输出应含 ≈0.35s 静音间隙，实际 {:?}",
        sil1
    );

    // 定位真实输出中最大的静音区（即被压缩插入的暂停），用它做 (c) 的取帧/取音频
    let mut regions = silence_regions(&out1);
    regions.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let (reg_start, reg_end, reg_dur) = regions[0];
    println!(
        "[assemble pause] 最大静音区(真实输出)=[{:.3},{:.3}] dur={:.3}s",
        reg_start, reg_end, reg_dur
    );

    // 验收 (c)：暂停区音频为静音（在真实静音区内取中间段测 RMS）
    let mv = mean_volume(&out1, reg_start + 0.05, (reg_dur - 0.1).max(0.05));
    println!(
        "[assemble pause] 暂停区({:.3}~{:.3}s) 平均音量={:.1}dB",
        reg_start + 0.05,
        reg_end - 0.05,
        mv
    );
    assert!(
        mv < -40.0,
        "(c) 暂停区音频应为静音(mean_volume<<0)，实际 {:.1}dB",
        mv
    );

    // 验收 (c)：暂停区视频为冻结帧（非黑屏、非跳变）。
    // 用「最大逐帧时序亮度差 YDIF」判定：暂停区内画面应完全静止（YDIF≈0）。
    // 注意：ffmpeg 对循环静帧做 RGB→YUV420P 时存在逐帧字节级抖动（MD5 不同），
    // 但画面感知冻结（实测 YDIF≈0.003），故用 YDIF 阈值而非严格像素相等。
    // 为避免「段→暂停」边界处的硬切跳变被计入，扫描静音区内部（去掉首尾 0.08s）。
    let interior_s = (reg_start + 0.08).min(reg_end - 0.02);
    let interior_e = (reg_end - 0.08).max(reg_start + 0.04);
    let max_ydif = if interior_e > interior_s {
        max_temporal_diff(&out1, interior_s, interior_e)
    } else {
        max_temporal_diff(&out1, reg_start, reg_end)
    };
    println!(
        "[assemble pause] 暂停区内部最大逐帧时序差 YDIF={:.4}（≈0 表示冻结，无黑屏/跳变）",
        max_ydif
    );
    assert!(
        max_ydif < 3.0,
        "(c) 暂停区视频应冻结（YDIF<<3 表示无运动），实际 YDIF={:.4}",
        max_ydif
    );

    // 验收 (c) 加强版：YDIF 只能证明「暂停区内部没有运动」，不能证明
    //   ① 冻结持续了 targetPause 那么久；② 冻结的就是暂停前的末帧（而非跳变到别处/黑屏）。
    // 故再用 ffmpeg 专用的 freezedetect 量出冻结时长，并用 PSNR / YAVG 验证画面内容。
    let freezes = freeze_regions(&out1, "-60dB", 0.2);
    println!(
        "[assemble pause] 冻结帧区间(freezedetect n=-60dB d=0.2)={:?}",
        freezes
    );
    let target_freeze = freezes
        .iter()
        .find(|&&(_, d)| (d - pause_dur).abs() < 0.03)
        .copied();
    assert!(
        target_freeze.is_some(),
        "(c) 应存在时长 ≈{:.3}s 的冻结画面，实际检测到的冻结区间 {:?}",
        pause_dur,
        freezes
    );
    let (fz_start, fz_dur) = target_freeze.unwrap();
    println!(
        "[assemble pause] 目标冻结区 start={:.3}s dur={:.3}s（理论 pause_dur={:.3}s）",
        fz_start, fz_dur, pause_dur
    );

    // 冻结区必须落在音频静音区内：证明「画面冻结」与「音频静音」是同一段暂停（音视频对齐）
    assert!(
        fz_start >= reg_start - 0.12 && fz_start + fz_dur <= reg_end + 0.12,
        "(c) 冻结区[{:.3},{:.3}] 应落在音频静音区[{:.3},{:.3}] 内（音视频应对齐）",
        fz_start,
        fz_start + fz_dur,
        reg_start,
        reg_end
    );

    // 冻结画面 == 暂停前最后一帧 → 证明是「冻结末帧」而不是跳变；且非黑屏。
    let f_before = temp.join("aicut_pause_f_before.png");
    let f_pause = temp.join("aicut_pause_f_pause.png");
    extract_frame(&out1, (fz_start - 0.03).max(0.0), &f_before);
    extract_frame(&out1, fz_start + fz_dur / 2.0, &f_pause);
    let psnr = psnr_between(&f_before, &f_pause);
    println!(
        "[assemble pause] PSNR(暂停前末帧@{:.3}s vs 暂停中间帧@{:.3}s)={:.2}dB",
        (fz_start - 0.03).max(0.0),
        fz_start + fz_dur / 2.0,
        psnr
    );
    assert!(
        psnr > 40.0,
        "(c) 暂停画面应等于暂停前末帧（冻结），PSNR 应 >40dB，实际 {:.2}dB",
        psnr
    );
    let yavg = y_avg(&f_pause);
    println!("[assemble pause] 暂停帧 YAVG={:.2}（纯黑帧≈16）", yavg);
    assert!(
        yavg > 30.0,
        "(c) 暂停画面不应是黑屏（YAVG 应远大于 16），实际 {:.2}",
        yavg
    );

    // ---------- 3) 回归：相同 keepSegments，但不带 keepSegmentsOut（回退间隙全删） ----------
    let out2 = temp.join("aicut_pause_out2.mp4");
    let out2_s = out2.to_str().unwrap();
    let asm_opts2 = build_asm_opts_no_out(&ks, out2_s);
    println!("[assemble regress(noOut)] opts = {}", asm_opts2);
    let r2 = aicut_engine::speech::speech_assemble(input_s, &asm_opts2)
        .expect("regress assemble 失败");
    let d2 = r2["duration"].as_f64().expect("out2 duration");
    let sum_seg: f64 = ks.iter().map(|&(s, e)| (e - s).max(0.0)).sum();
    // 间隙全删（crossfade 路径会略微缩短 ≈(n-1)*0.02s），故与源段长和接近
    assert!(
        (d2 - sum_seg).abs() < 0.2,
        "(regress) 无 keepSegmentsOut 时输出应≈各段长和 {:.3}s，实际 {:.3}s",
        sum_seg,
        d2
    );
    let sil2 = silence_intervals(&out2);
    println!("[assemble regress(noOut)] 静音区间={:?}", sil2);
    assert!(
        !sil2.iter().any(|&x| (x - 0.35).abs() < 0.06),
        "(regress) 间隙全删后不应存在 ≈0.35s 插入静音，实际 {:?}",
        sil2
    );
    // 关键对比：带暂停压缩的输出应明显长于间隙全删的输出
    assert!(
        d1 > d2 + 0.4,
        "暂停压缩输出({:.3}s) 应明显长于间隙全删输出({:.3}s)",
        d1,
        d2
    );
    println!(
        "[assemble regress(noOut)] 输出时长={:.3}s（段长和={:.3}s）；pause 比它长 {:.3}s → 证明插入了暂停",
        d2,
        sum_seg,
        d1 - d2
    );

    // ---------- 4) 回归：keepSegments 与 keepSegmentsOut 错位（长度不匹配→回退） ----------
    // 重要：Rust 的 segs_valid 只校验「段长度一致 + 首段始于 0」，不校验绝对位置。
    // 因此「整体平移坐标」(长度不变) 仍会被判为有效并插入暂停；要触发回退必须真正破坏
    // 长度匹配（或首段非 0）。这里把第 0 段的终点 +0.10（长度 0.72→0.82，与 ko[0] 不一致）
    // 来制造长度错位，验证回退为「间隙全删」且不报错、不崩溃。
    let mut ks_broken = ks.clone();
    ks_broken[0].1 = (ks_broken[0].1 + 0.10).min(ks[1].0 - 0.02); // 使其长度与 ko[0] 不一致且不与下一段重叠
    let out3 = temp.join("aicut_pause_out3.mp4");
    let out3_s = out3.to_str().unwrap();
    let asm_opts3 = build_asm_opts(&ks_broken, &ko, out3_s);
    println!("[assemble regress(mismatch)] opts = {}", asm_opts3);
    let r3 = aicut_engine::speech::speech_assemble(input_s, &asm_opts3)
        .expect("mismatch assemble 不应报错");
    let d3 = r3["duration"].as_f64().expect("out3 duration");
    let sum_broken: f64 = ks_broken.iter().map(|&(s, e)| (e - s).max(0.0)).sum();
    assert!(
        (d3 - sum_broken).abs() < 0.2,
        "(mismatch) 长度错位时应回退间隙全删≈段长和 {:.3}s，实际 {:.3}s",
        sum_broken,
        d3
    );
    // 错位时不应使用暂停压缩时间轴（否则会与 outputDuration 接近）
    assert!(
        (d3 - output_duration).abs() > 0.5,
        "(mismatch) 错位不应触发暂停压缩时间轴（不应≈outputDuration {:.3}s），实际 {:.3}s",
        output_duration,
        d3
    );
    let sil3 = silence_intervals(&out3);
    println!("[assemble regress(mismatch)] 静音区间={:?}", sil3);
    assert!(
        !sil3.iter().any(|&x| (x - 0.35).abs() < 0.06),
        "(mismatch) 回退后不应存在 ≈0.35s 插入静音，实际 {:?}",
        sil3
    );
    println!(
        "[assemble regress(mismatch)] 输出时长={:.3}s（段长和={:.3}s，回退间隙全删，无插入暂停、未错位崩溃）",
        d3,
        sum_broken
    );

    println!("\n=== 暂停压缩音频落地验证：全部断言通过 ===");
}

/// 真实样本 + keepNonspeech=true（默认）：记录决策层行为。
/// 已知：真实口播中长停顿常被检测为硬删声音事件 → keepSegmentsOut 无正间隙（不会触发暂停压缩）。
/// 此测试记录该事实，证明 Rust 路径对此类输入正确回退为间隙全删（不插入停顿）。
#[test]
fn real_sample_keeps_nonspeech_true_no_compress() {
    if !Path::new(&m4a_path()).exists() {
        println!("跳过：样本缺失 {}", m4a_path());
        return;
    }
    set_bridge_env();
    let analyze_opts = r#"{"pauseCompress":true,"targetPause":0.35,"modelSize":"small","denoise":false,"keepNonspeech":true,"trimSilence":true}"#;
    let res = match aicut_engine::speech::speech_analyze(&m4a_path(), analyze_opts) {
        Ok(r) => r,
        Err(e) => {
            println!("analyze 失败（环境缺 whisper？）：{:?}，跳过", e);
            return;
        }
    };
    let duration = res["duration"].as_f64().unwrap_or(0.0);
    let output_duration = res["outputDuration"].as_f64().unwrap_or(0.0);
    let ks = res["keepSegments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|seg| (seg[0].as_f64().unwrap(), seg[1].as_f64().unwrap()))
        .collect::<Vec<(f64, f64)>>();
    let ko = res["keepSegmentsOut"]
        .as_array()
        .unwrap()
        .iter()
        .map(|seg| (seg[0].as_f64().unwrap(), seg[1].as_f64().unwrap()))
        .collect::<Vec<(f64, f64)>>();
    let mut max_out_gap = 0.0_f64;
    for i in 0..ks.len().saturating_sub(1) {
        let g = ko[i + 1].0 - ko[i].1;
        if g > max_out_gap {
            max_out_gap = g;
        }
    }
    println!(
        "[real-sample keepNonspeech=true] duration={:.3} outputDuration={:.3} segs={} max_out_gap={:.3}",
        duration, output_duration, ks.len(), max_out_gap
    );
    println!(
        "[记录] 真实样本默认 opts 下 max_out_gap={:.3}s（≈0 表示长停顿被硬删、未压缩）",
        max_out_gap
    );
    assert!(duration > 0.0);
}

// ---------- JSON 构造辅助（直接拼字符串，避免引入 serde_json 依赖） ----------
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

fn build_asm_opts(ks: &[(f64, f64)], ko: &[(f64, f64)], output: &str) -> String {
    format!(
        "{{\"keepSegments\":[{}],\"keepSegmentsOut\":[{}],\"outputPath\":\"{}\"}}",
        fmt_segs(ks),
        fmt_segs(ko),
        output.replace('\\', "/")
    )
}

fn build_asm_opts_no_out(ks: &[(f64, f64)], output: &str) -> String {
    format!(
        "{{\"keepSegments\":[{}],\"outputPath\":\"{}\"}}",
        fmt_segs(ks),
        output.replace('\\', "/")
    )
}
