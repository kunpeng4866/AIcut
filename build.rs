fn main() {
    #[cfg(feature = "napi")]
    napi_build::setup();

    // 编译时构建标识：每次 src 源码变更后重新构建都会刷新该时间戳，
    // 供 `aicut-engine version` 返回，Electron 据此识别二进制是否与源码脱节。
    let build_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    println!("cargo:rustc-env=ENGINE_BUILD_ID={}", build_id);
    println!("cargo:rerun-if-changed=src");
}
