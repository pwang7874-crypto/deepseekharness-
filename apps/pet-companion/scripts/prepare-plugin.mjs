import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = resolve(appDir, '../../packages/dsh-pet-plugin')
const resourcesDir = join(appDir, 'src-tauri/resources')
const target = join(resourcesDir, 'dsh-pet-plugin.tgz')
const pnpmCli = process.env.npm_execpath
const runPnpm = (args) => pnpmCli
  ? spawnSync(process.execPath, [pnpmCli, ...args], { cwd: pluginDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  : spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: pluginDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

mkdirSync(resourcesDir, { recursive: true })
rmSync(target, { force: true })
const build = runPnpm(['run', 'build'])
if (build.status !== 0) throw new Error(build.error?.message || build.stderr || build.stdout || '插件构建失败')

const result = runPnpm(['pack', '--pack-destination', resourcesDir])
if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || '插件打包失败')

const packed = readdirSync(resourcesDir)
  .filter((name) => name.endsWith('.tgz') && name !== 'dsh-pet-plugin.tgz')
  .sort()
  .at(-1)
if (!packed) throw new Error('pnpm pack 未生成插件归档')
renameSync(join(resourcesDir, packed), target)
console.log(`Embedded DSH plugin: ${target}`)
