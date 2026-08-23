import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = resolve(appDir, '../../packages/dsh-pet-plugin')
const resourcesDir = join(appDir, 'src-tauri/resources')
const target = join(resourcesDir, 'dsh-pet-plugin.tgz')
const pnpmCli = process.env.npm_execpath
const runPnpm = (args, cwd = pluginDir) => pnpmCli
  ? spawnSync(process.execPath, [pnpmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  : spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

mkdirSync(resourcesDir, { recursive: true })
rmSync(target, { force: true })
const build = runPnpm(['run', 'build'])
if (build.status !== 0) throw new Error(build.error?.message || build.stderr || build.stdout || '插件构建失败')

// `pnpm pack` only embeds bundledDependencies with a hoisted node_modules.
// Keep the workspace isolated, but stage a production-only hoisted install so
// the desktop installer can work without reaching npm on the user's machine.
const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-pet-plugin-pack-'))
const stagingDir = join(stagingRoot, 'package')
try {
  cpSync(pluginDir, stagingDir, {
    recursive: true,
    filter: (source) => !source.includes(`${join(pluginDir, 'node_modules')}`),
  })
  const install = runPnpm([
    'install',
    '--prod',
    '--no-lockfile',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
  ], stagingDir)
  if (install.status !== 0) throw new Error(install.error?.message || install.stderr || install.stdout || '插件离线依赖准备失败')

  const result = runPnpm([
    'pack',
    '--config.node-linker=hoisted',
    '--pack-destination',
    resourcesDir,
  ], stagingDir)
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || '插件打包失败')
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}

const packed = readdirSync(resourcesDir)
  .filter((name) => name.endsWith('.tgz') && name !== 'dsh-pet-plugin.tgz')
  .sort()
  .at(-1)
if (!packed) throw new Error('pnpm pack 未生成插件归档')
renameSync(join(resourcesDir, packed), target)
console.log(`Embedded DSH plugin: ${target}`)
