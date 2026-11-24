#!/usr/bin/env node
/**
 * 一条命令：构建 → 同步到 DSH profile → 校验字节数。
 *
 *   node scripts/deploy.mjs               构建 + 同步 desktop profile
 *   node scripts/deploy.mjs --skip-build  只同步（lib/ 已是新的）
 *   node scripts/deploy.mjs --check       只校验，不写盘
 *   node scripts/deploy.mjs --profile=名字或绝对路径
 *
 * 环境变量：DSH_PROFILE / DSH_NODE_DIR / DSH_PNPM_MJS
 *
 * 背景：profile 里的 node_modules/dsh-trading-panel 是实拷贝（不是软链），
 * 重新构建后不会自动生效，必须把 lib/ 拷过去，否则页面还是旧版本。
 * 拷完要重启 DSH —— client bundle 在宿主启动时装配。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT = path.resolve(import.meta.dirname, '..');
const PKG = 'dsh-trading-panel';
const ARTIFACTS = ['client.js', 'client.js.map', 'index.mjs'];

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);
const getOpt = (n, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : dflt;
};

// 默认用「正在跑本脚本的那个 node」所在目录；DSH 桌面端自带的运行时是同构的。
const NODE_DIR = process.env.DSH_NODE_DIR || path.dirname(process.execPath);
const PNPM_MJS =
  process.env.DSH_PNPM_MJS || path.join(NODE_DIR, '..', 'pnpm', 'bin', 'pnpm.mjs');

const fmt = (n) => n.toLocaleString('en-US');

function resolveProfile() {
  const p = getOpt('profile', process.env.DSH_PROFILE || 'desktop');
  return path.isAbsolute(p) ? p : path.join(os.homedir(), '.dsh', 'profiles', p);
}

function build() {
  // pnpm 会 spawn "node"，所以必须把 node 的 bin 目录塞进 PATH
  const env = { ...process.env, PATH: NODE_DIR + path.delimiter + (process.env.PATH ?? '') };
  let cmd;
  let cmdArgs;
  if (fs.existsSync(PNPM_MJS)) {
    cmd = process.execPath;
    cmdArgs = [PNPM_MJS, 'run', 'build'];
  } else {
    cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    cmdArgs = ['run', 'build'];
  }
  console.log('▸ 构建：pnpm run build');
  execFileSync(cmd, cmdArgs, { cwd: PROJECT, env, stdio: 'inherit' });
}

function sync(profile) {
  const srcDir = path.join(PROJECT, 'lib');
  const dstDir = path.join(profile, 'node_modules', PKG, 'lib');

  if (!fs.existsSync(srcDir)) {
    throw new Error(`没有构建产物：${srcDir}（先跑一次 build）`);
  }
  if (!fs.existsSync(dstDir)) {
    throw new Error(
      `profile 里没有 ${PKG}：${dstDir}\n` +
        `  先在该 profile 装一次（~/.dsh/profiles/${path.basename(profile)}/package.json 的 dependencies 里要有它），` +
        `或用 --profile= 指到正确的 profile`,
    );
  }

  // 万一哪天变成软链，写进去等于写自己，直接跳过
  if (fs.realpathSync(dstDir) === fs.realpathSync(srcDir)) {
    console.log('▸ 同步：profile 里的 lib 就是源目录（软链/同一路径），跳过拷贝');
    return { mode: 'linked', rows: [] };
  }

  if (hasFlag('check')) {
    console.log('▸ 同步：--check 只校验不写盘');
  } else {
    console.log(`▸ 同步：lib/ → ${dstDir}`);
  }

  const rows = [];
  for (const name of ARTIFACTS) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) {
      rows.push({ name, src: '-', dst: '-', state: '源文件不存在，跳过' });
      continue;
    }
    const dst = path.join(dstDir, name);
    const srcSize = fs.statSync(src).size;
    if (!hasFlag('check')) fs.copyFileSync(src, dst);
    const dstSize = fs.existsSync(dst) ? fs.statSync(dst).size : -1;
    rows.push({
      name,
      src: fmt(srcSize),
      dst: dstSize < 0 ? '-' : fmt(dstSize),
      state: dstSize === srcSize ? 'ok' : '不一致',
    });
  }
  return { mode: 'copied', rows };
}

function warnBundles(profile) {
  const pkgPath = path.join(profile, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bundles = pkg.dsh?.profile?.bundles ?? pkg.dsh?.bundles ?? [];
    if (!Array.isArray(bundles) || !bundles.includes(PKG)) {
      console.warn(`⚠ ${pkgPath} 的 bundles 里没有 "${PKG}"，插件不会被加载`);
    }
  } catch {
    /* package.json 读不动就不管，不影响主流程 */
  }
}

function main() {
  const profile = resolveProfile();
  console.log(`profile: ${profile}`);

  if (!hasFlag('skip-build') && !hasFlag('check')) build();

  const { mode, rows } = sync(profile);

  if (rows.length) {
    const w = Math.max(...rows.map((r) => r.name.length), 8);
    console.log(`\n${'文件'.padEnd(w)}  ${'源'.padStart(10)}  ${'profile'.padStart(10)}  状态`);
    for (const r of rows) {
      console.log(`${r.name.padEnd(w)}  ${r.src.padStart(10)}  ${r.dst.padStart(10)}  ${r.state}`);
    }
    if (rows.some((r) => r.state === '不一致')) {
      throw new Error('同步后字节数不一致，profile 可能没写成功');
    }
  }

  warnBundles(profile);

  if (hasFlag('check')) {
    console.log('\n✓ 校验完成（未写盘）');
    return;
  }
  if (mode === 'linked') return;
  console.log('\n✓ 同步完成 —— 现在重启 DSH，再刷新页面验收（client bundle 在宿主启动时装配）');
}

try {
  main();
} catch (err) {
  console.error('\n✗ ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
