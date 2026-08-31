#!/usr/bin/env node
/**
 * AIcut 全方位密钥泄露扫描器
 * 用途：pre-commit 钩子 + CI + 本地手动审计
 * 扫描范围：工作区文件、暂存区、可选 git 全历史
 * 扫描目标：API key / token / secret / 私钥 / 证书 / 高熵字符串 / .env 内容
 * 规则：只报告疑似硬编码；允许 getenv/os.environ/空默认值/占位符
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODE = process.argv.includes('--history') ? 'history' :
             process.argv.includes('--staged') ? 'staged' : 'working-tree';

const ROOT = path.resolve(__dirname, '..');

// 排除目录/文件：依赖、构建产物、LFS 对象、压缩包、模型权重、临时目录
const EXCLUDE_DIRS = new Set([
  '.git', 'node_modules', '.workbuddy', '.build-trash',
  'dist', 'dist-electron', 'dist-lite', 'dist-lite-v2',
  'pack-staging', 'target', 'release', 'out', 'build',
  'gui/dist', 'gui/dist-electron', 'gui/dist-lite', 'gui/dist-lite-v2',
  'gui/node_modules', 'python/__pycache__', 'python/models',
]);

const EXCLUDE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.mp3', '.mp4',
  '.wav', '.m4a', '.mov', '.avi', '.mkv', '.webm', '.ttf', '.otf', '.woff', '.woff2',
  '.exe', '.dll', '.so', '.dylib', '.onnx', '.pt', '.pth', '.bin', '.safetensors',
  '.zip', '.7z', '.tar', '.gz', '.rar', '.asar', '.pak', '.pdf', '.docx', '.xlsx',
]);

// 行级白名单：允许这些模式存在（占位符、从环境读、空默认值、注释、类型定义等）
const ALLOWLIST_LINE = [
  /^\s*\/\/.*/,
  /^\s*\*.*$/,
  /^\s*#.*$/,
  /process\.env\./,
  /os\.environ/,
  /getenv\s*\(/,
  /loadConfig\s*\(/,
  /getConfig\s*\(/,
  /config\./,
  /\.apiKey\s*[:=]\s*['"]?['"]?/,
  /apiKey\s*[:=]\s*['"]\s*['"]/,
  /appId\s*[:=]\s*['"]\s*['"]/,
  /accessToken\s*[:=]\s*['"]\s*['"]/,
  /secret\s*[:=]\s*['"]\s*['"]/,
  /token\s*[:=]\s*['"]\s*['"]/,
  /checksum\s*=/,
  /sha256\s*[:=]/,
  /"sha256":\s*"[a-f0-9]{64}"/,
  /`[a-f0-9]{64}`/i,
  /SHA256\s*[:=]/,
  /sha256sum/,
  /REPLAC[EA]_WITH_YOUR_/,
  /REPLACE_/,
  /YOUR_/,
  /<YOUR_/,
  /placeholder/i,
  /请输入/,
  /未配置/,
  /example/i,
  /testonly/i,
  /mock/i,
  /demo/i,
  /dummy/i,
  /None\s*:\s*\{\s*appId\s*:\s*['"]\s*['"]/,
];

// 核心检测规则：每个规则返回 {name, pattern, severity}
const RULES = [
  {
    name: 'Private Key',
    severity: 'CRITICAL',
    pattern: /-----BEGIN (RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----/,
  },
  {
    name: 'Certificate',
    severity: 'HIGH',
    pattern: /-----BEGIN CERTIFICATE-----/,
  },
  {
    name: 'OpenAI/DeepSeek/DashScope API Key (含百炼 sk-ws- 实时 key)',
    severity: 'CRITICAL',
    pattern: /\b(sk-[A-Za-z0-9._-]{20,})\b/,
  },
  {
    name: 'GitHub Token',
    severity: 'CRITICAL',
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{30,})\b/,
  },
  {
    name: 'Volcano/Bytedance AppID + Token pair',
    severity: 'HIGH',
    pattern: /(appid|appId|app_id)\s*[:=]\s*['"](\d{6,})['"].{0,200}(accessToken|access_token|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{10,}['"]/is,
  },
  {
    name: 'Aliyun AccessKey ID',
    severity: 'CRITICAL',
    pattern: /\b(AKID[A-Za-z0-9]{10,}|LTAI[A-Za-z0-9]{10,})\b/,
  },
  {
    name: 'Generic high-entropy secret',
    severity: 'MEDIUM',
    pattern: /(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?token|bearer)\s*[:=]\s*['"`]([A-Za-z0-9_\-]{16,})['"`]/i,
  },
  {
    name: 'Hardcoded password/passwd',
    severity: 'HIGH',
    pattern: /(?:password|passwd)\s*[:=]\s*['"`]([^'"`\s]{6,})['"`]/i,
  },
  {
    name: 'Base64-like high entropy blob',
    severity: 'MEDIUM',
    pattern: /['"`]([A-Za-z0-9+/]{40,}={0,2})['"`]/,
    entropy: 4.5,
  },
  {
    name: 'Hex-like high entropy blob',
    severity: 'MEDIUM',
    pattern: /['"`]([a-f0-9]{32,})['"`]/i,
    entropy: 3.8,
  },
];

function shannonEntropy(str) {
  const freq = {};
  for (const c of str) freq[c] = (freq[c] || 0) + 1;
  let len = str.length;
  return Object.values(freq).reduce((sum, count) => {
    const p = count / len;
    return sum - p * Math.log2(p);
  }, 0);
}

function shouldSkipFile(filePath) {
  const parts = filePath.split(/[\\/]/);
  for (const p of parts) {
    if (EXCLUDE_DIRS.has(p)) return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (EXCLUDE_EXTS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.sample')) return true;
  if (base === 'secret-scan.js' || base === 'secret-scan-known.json') return true;
  return false;
}

function isAllowlisted(line) {
  return ALLOWLIST_LINE.some((re) => re.test(line));
}

function mask(value) {
  if (!value || value.length <= 8) return value;
  return value.slice(0, 4) + '***' + value.slice(-4);
}

function runGit(cmd, options = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch (e) {
    if (options.mute) return '';
    return e.stdout || '';
  }
}

function getFilesFromWorkingTree() {
  // ⚠️ 无死角：直接用 os.walk 遍历整个工作树（含被 .gitignore 排除的 .env 等密钥文件），
  // 跳过依赖/构建大目录与 .git。不依赖 git ls-files，确保 gitignored 的密钥绝不被漏扫。
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name) || /^(dist|dist-lite|dist-electron|release|out|build|target|node_modules|pack-staging|dist-staging)/.test(e.name)) continue;
        walk(full);
      } else {
        out.push(rel);
      }
    }
  }
  walk(ROOT);
  return [...new Set(out)].filter((f) => !shouldSkipFile(f));
}

function getFilesFromStaged() {
  return runGit('git diff --cached --name-only --diff-filter=ACM')
    .split('\n')
    .filter(Boolean)
    .filter((f) => !shouldSkipFile(f));
}

function getFilesFromHistory() {
  // 扫描所有 commit 中引入的文件（按路径去重），然后逐文件扫描所有版本内容
  const files = runGit('git log --all --name-only --pretty=format:')
    .split('\n')
    .filter(Boolean)
    .filter((f) => !shouldSkipFile(f));
  return [...new Set(files)];
}

function scanHistoryWithGitGrep() {
  const findings = [];
  // 仅对高置信度规则在历史中搜索（避免 Hex 类规则把 Cargo.lock 校验值扫爆）
  const historyRules = RULES.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH');
  for (const rule of historyRules) {
    const pattern = rule.pattern.source;
    // -I 跳过 binary，--all 搜索所有 commit，-n 显示行号
    const out = runGit(`git grep -I --all -nE "${pattern.replace(/"/g, '\\"')}"`, { mute: true });
    if (!out) continue;
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      // git grep --all 输出格式: <commit>:<path>:<line>:<content>
      const m = line.match(/^([a-f0-9]+):(.+):(\d+):(.*)$/);
      if (!m) continue;
      const [, commit, filePath, lineno, content] = m;
      if (shouldSkipFile(filePath)) continue;
      if (isAllowlisted(content)) continue;
      const vm = content.match(rule.pattern);
      if (!vm) continue;
      const value = vm[1] || vm[0];
      findings.push({
        source: `${filePath} (commit ${commit.slice(0, 8)})`,
        line: parseInt(lineno, 10),
        rule: rule.name,
        severity: rule.severity,
        snippet: content.trim().slice(0, 120),
        masked: mask(value),
      });
    }
  }
  return findings;
}

function scanContent(content, sourceLabel) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (isAllowlisted(line)) return;
    for (const rule of RULES) {
      const m = line.match(rule.pattern);
      if (!m) continue;
      const value = m[1] || m[0];
      if (rule.entropy) {
        if (shannonEntropy(value) < rule.entropy) continue;
      }
      findings.push({
        source: sourceLabel,
        line: idx + 1,
        rule: rule.name,
        severity: rule.severity,
        snippet: line.trim().slice(0, 120),
        masked: mask(value),
      });
    }
  });
  return findings;
}

function scanFile(filePath, contentProvider) {
  try {
    const content = contentProvider(filePath);
    if (content == null) return [];
    return scanContent(content, filePath);
  } catch (e) {
    return [];
  }
}

function printAndExit(findings, mode, extra = '') {
  if (findings.length === 0) {
    console.log(`\n✅ 未发现疑似硬编码密钥（模式：${mode}${extra ? '，' + extra : ''}）`);
    process.exit(0);
  }

  console.log(`\n❌ 发现 ${findings.length} 处疑似密钥泄露（模式：${mode}）\n`);
  const grouped = {};
  for (const f of findings) {
    grouped[f.source] = grouped[f.source] || [];
    grouped[f.source].push(f);
  }
  for (const [source, list] of Object.entries(grouped)) {
    console.log(`\n[${source}]`);
    for (const f of list) {
      console.log(`  ${f.severity} | ${f.rule} | line ${f.line}`);
      console.log(`    snippet: ${f.snippet}`);
      console.log(`    value(masked): ${f.masked}`);
    }
  }

  console.log(`\n说明：若确认是误报，请将该行加入 ALLOWLIST_LINE 或改用环境变量/getConfig 读取。`);
  process.exit(1);
}

function main() {
  if (MODE === 'history') {
    const historyFindings = scanHistoryWithGitGrep();
    printAndExit(historyFindings, MODE);
    return;
  }

  let files;
  let contentProvider;

  if (MODE === 'staged') {
    files = getFilesFromStaged();
    contentProvider = (filePath) => runGit(`git show :${filePath}`);
  } else {
    files = getFilesFromWorkingTree();
    contentProvider = (filePath) => fs.readFileSync(path.join(ROOT, filePath), 'utf-8');
  }

  const allFindings = [];
  for (const f of files) {
    const findings = scanFile(f, contentProvider);
    allFindings.push(...findings);
  }

  printAndExit(allFindings, MODE, `扫描文件数：${files.length}`);
}

main();
