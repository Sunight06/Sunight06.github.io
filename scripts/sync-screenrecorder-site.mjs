// 把「小白录制」官网（VitePress，源码在 screenrecorder/）的构建产物
// 同步到 Astro 的 public/screenrecorder/。
//
// 目标目录必须与 screenrecorder/.vitepress/config.mts 里的 base 一致：
// Astro 构建时会把 public/ 原样复制进 dist/，官网因此挂在
// https://sunight06.github.io/screenrecorder/ 下，与博客（根路径）互不影响。
// 只清理 public/screenrecorder/ 这一个小目录，不动 public/ 里的其它文件。
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = join(root, 'screenrecorder', '.vitepress', 'dist')
const to = join(root, 'public', 'screenrecorder')

if (!existsSync(from)) {
  console.error(`找不到官网构建产物：${from}\n先执行 pnpm site:build`)
  process.exit(1)
}

await rm(to, { recursive: true, force: true })
await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
console.log(`官网已同步：${from} -> ${to}`)
