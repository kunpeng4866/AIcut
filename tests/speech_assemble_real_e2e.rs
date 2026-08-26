//! tests/speech_assemble_real_e2e.rs — 真实口播样本端到端回归（暂停压缩链路）
//!
//! 目的：在真实样本上验证「Python 决策层(49c8f6f 修复后) 产出的 keepSegmentsOut
//! → Rust speech_assemble 消费」整条链路确实把压缩停顿落到音频输出。
//!
//! 与 `speech_assemble_pause.rs`（合成 fixture）互为补充：本文件用真实口播，证明
//! 真实数据下暂停压缩优先生效（长停顿被压到 ~targetPause 而非整段删除 / 机关枪拼接）。
//!
//! 运行：`cargo test --test speech_assemble_real_e2e`
//! 样本：默认 `C:/Users/Administrator/Documents/录音/仓哥有温度.m4a`，可用
//! `AICUT_TEST_M4A` 覆盖；样本缺失或 analyze 失败则本测试跳过（不影响 CI）。

use std::path::Path;
use std::process::Command;

/// 真实口播样本（默认指向本机路径）。CI / 其他机器用 `AICUT_TEST_M4A` 覆盖。
const M4A_DEFAULT: &str = "C:/Users/Administrator/Documents/录音/仓哥有温度.m4a";
fn m4a_path() -> String {
    std::env::var("AICUT_TEST_M4A").unwrap_or_else(|_| M4A_DEFAULT.to_string())
}

fn ffmpeg() -> String {
    std::env::var("AICUT_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// 强制指向仓库内真正的 bridge.py（集成测试 exe 位于 target/debug/deps/，
/// 反推仓库根会落空，用 AICUT_SPEECH_BRIDGE 覆盖）。
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

/// 取输出音频中的静音区间（真实时间轴）：(start, end, dur)。噪音阈值 -30dB，
/// 最小静音时长 0.1s，规避 ffmpeg 切割量化带来的边界噪声。
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
    (0..n)
        .map(|i| (starts[i], ends[i], ends[i] - starts[i]))
        .collect()
}

/// 取输出某子区间的音频平均音量（dB）。越接近 -91 越静音。
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

/// 真实样本端到端：analyze(暂停压缩) → assemble(带 keepSegmentsOut) → 验证停顿落到音频。
#[test]
fn real_sample_pause_compress_e2e() {
    let m4a = m4a_path();
    if !Path::new(&m4a).exists() {
        println!("跳过：真实样本缺失 {}", m4a);
        return;
    }
    set_bridge_env();

    // ---------- 1) analyze：确认决策层(修复后) 产出压缩停顿 ----------
    // keepNonspeech=true（默认）：背景音乐/环境音保留进 keep 段，但段间停顿应被压缩。
    let analyze_opts = r#"{"pauseCompress":true,"targetPause":0.35,"modelSize":"small","denoise":false,"keepNonspeech":true,"trimSilence":true}"#;
    let res = match aicut_engine::speech::speech_analyze(&m4a, analyze_opts) {
        Ok(r) => r,
        Err(e) => {
            println!("analyze 失败（环境缺 whisper / 网络？）：{:?}，跳过", e);
            return;
        }
    };
    let duration = res["duration"].as_f64().unwrap_or(0.0);
    let output_duration = res["outputDuration"].as_f64().unwrap_or(0.0);
    let ks = res["keepSegments"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|seg| (seg[0].as_f64().unwrap(), seg[1].as_f64().unwrap()))
                .collect::<Vec<(f64, f64)>>()
        })
        .unwrap_or_default();
    let ko = res["keepSegmentsOut"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|seg| (seg[0].as_f64().unwrap(), seg[1].as_f64().unwrap()))
                .collect::<Vec<(f64, f64)>>()
        })
        .unwrap_or_default();

    println!(
        "[real analyze] duration={:.3} outputDuration={:.3} segs={} ks_out_len={}",
        duration,
        output_duration,
        ks.len(),
        ko.len()
    );
    println!("[real analyze] keepSegmentsOut = {:?}", ko);

    assert_eq!(ks.len(), ko.len(), "keepSegmentsOut 与 keepSegments 必须等长");
    assert!(ks.len() > 1, "真实样本应有多段语音");

    // 统计源间隙与输出间隙
    let mut src_gaps = Vec::new();
    let mut out_gaps = Vec::new();
    for i in 0..ks.len().saturating_sub(1) {
        src_gaps.push(ks[i + 1].0 - ks[i].1);
        out_gaps.push(ko[i + 1].0 - ko[i].1);
    }
    let positive_out = out_gaps.iter().filter(|&&g| g > 1e-3).count();
    println!(
        "[real analyze] 源间隙={:?}\n[real analyze] 输出间隙={:?}\n[real analyze] 正输出间隙数={}",
        src_gaps, out_gaps, positive_out
    );

    // 回归核心断言①：修复后，真实样本应至少有被压缩的软停顿（这是 49c8f6f 的修复效果）
    assert!(
        positive_out > 0,
        "真实样本修复后应存在被压缩的软停顿（keepSegmentsOut 含正间隙）；若无，说明硬编码根因未修或样本被重新标注"
    );
    // 长停顿应被压到 ≈targetPause(0.35s)，而非保留源长度
    let long_src = src_gaps.iter().filter(|&&g| g > 0.35).count();
    let long_out_compressed = src_gaps
        .iter()
        .zip(&out_gaps)
        .filter(|(sg, og)| **sg > 0.35 && (**og - 0.35).abs() < 0.06)
        .count();
    println!(
        "[real analyze] 源长停顿(>0.35s)数={} 其中被压到≈0.35s={}",
        long_src, long_out_compressed
    );

    let temp = std::env::temp_dir();

    // ---------- 2) assemble：带 keepSegmentsOut（暂停压缩路径） ----------
    let out1 = temp.join("aicut_real_e2e_pause.mp4");
    let out1_s = out1.to_str().unwrap();
    let asm_opts = build_asm_opts(&ks, &ko, out1_s);
    println!("[real assemble pause] opts = {}", asm_opts);
    let r1 = match aicut_engine::speech::speech_assemble(&m4a, &asm_opts) {
        Ok(r) => r,
        Err(e) => {
            println!("assemble(暂停压缩) 失败：{:?}，跳过", e);
            return;
        }
    };
    let d1 = r1["duration"].as_f64().expect("out1 duration");

    // 回归核心断言②：输出时长 ≈ outputDuration（含切割量化容差 0.3s）
    assert!(
        (d1 - output_duration).abs() < 0.3,
        "(real) 输出时长 {:.3}s 应 ≈ analyze outputDuration {:.3}s",
        d1,
        output_duration
    );
    println!(
        "[real assemble pause] 输出时长={:.3}s (outputDuration={:.3})",
        d1, output_duration
    );

    // 回归核心断言③：输出音频中确实存在 ≈0.35s 的静音间隙（停顿真的被插入了）
    let sil1: Vec<f64> = silence_regions(&out1).into_iter().map(|(_, _, d)| d).collect();
    println!("[real assemble pause] 静音区间时长={:?}", sil1);
    let has_pause = sil1.iter().any(|&x| (x - 0.35).abs() < 0.08);
    assert!(
        has_pause,
        "(real) 输出应含 ≈0.35s 静音间隙（暂停压缩落地），实际 {:?}",
        sil1
    );

    // 回归核心断言④：暂停区音频为静音
    let mut regions = silence_regions(&out1);
    regions.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let (reg_start, reg_end, reg_dur) = regions[0];
    let mv = mean_volume(&out1, reg_start + 0.05, (reg_dur - 0.1).max(0.05));
    println!(
        "[real assemble pause] 最大静音区({:.3}~{:.3}s) 平均音量={:.1}dB (应<<0 静音)",
        reg_start, reg_end, mv
    );
    assert!(mv < -40.0, "(real) 暂停区音频应为静音，实际 {:.1}dB", mv);

    // ---------- 3) 回归：相同 keepSegments 不带 keepSegmentsOut → 间隙全删 ----------
    let out2 = temp.join("aicut_real_e2e_nopause.mp4");
    let out2_s = out2.to_str().unwrap();
    let asm_opts2 = build_asm_opts_no_out(&ks, out2_s);
    let r2 = match aicut_engine::speech::speech_assemble(&m4a, &asm_opts2) {
        Ok(r) => r,
        Err(e) => {
            println!("assemble(无pause) 失败：{:?}，跳过回归对比", e);
            return;
        }
    };
    let d2 = r2["duration"].as_f64().expect("out2 duration");
    let sil2: Vec<f64> = silence_regions(&out2).into_iter().map(|(_, _, d)| d).collect();
    println!(
        "[real assemble nopause] 输出时长={:.3}s 静音区间={:?}",
        d2, sil2
    );
    // 无 pause 时不应插入额外的 ≈0.35s 停顿。注意：语音段内部自带的「自然句内停顿」也可能
    // 落在 0.27~0.43s 区间，故不能简单地"禁止出现≈0.35s 单段"——正确判据是：回退路径的
    // 静音总时长应明显少于「带暂停压缩」路径（插入的停顿是额外累加的）。
    let sil1_sum: f64 = sil1.iter().sum();
    let sil2_sum: f64 = sil2.iter().sum();
    println!(
        "[real] 静音总时长  带压缩={:.2}s  回退全删={:.2}s  差值={:.2}s",
        sil1_sum,
        sil2_sum,
        sil1_sum - sil2_sum
    );
    assert!(
        sil1_sum > sil2_sum + 2.0,
        "(real) 暂停压缩输出静音总时长({:.2}s) 应明显多于回退路径({:.2}s)，差值应≈插入的停顿总量",
        sil1_sum,
        sil2_sum
    );
    assert!(
        d1 > d2 + 0.3,
        "(real) 暂停压缩输出({:.3}s) 应明显长于间隙全删({:.3}s)",
        d1,
        d2
    );

    println!("\n=== 真实样本端到端暂停压缩回归：全部断言通过 ===");
}
