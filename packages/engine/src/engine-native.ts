/**
 * 本地 N-API 原生模块桥接
 *
 * `cargo build` 会产出 `target/<profile>/aicut_engine.dll`（cdylib）。构建流程将其
 * 重命名为 `aicut_engine.node` 并复制到本目录（packages/engine/）。本模块直接加载它，
 * 使 @aicut/engine 在本地开发态优先走 N-API（零进程开销），而非回退 CLI 二进制。
 *
 * 注：.node 为平台相关原生模块，无类型声明，故用 @ts-ignore。
 */
// @ts-ignore - native .node module has no type declarations
// eslint-disable-next-line @typescript-eslint/no-var-requires
const native = require('../aicut_engine.node');

export default native;
