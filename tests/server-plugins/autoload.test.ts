import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { loadBusinessPlugins, type BusinessPluginRoots } from '@server/src/business-plugins'
import { BusinessPluginLoadError, formatBusinessPluginError, requireBusinessServices } from '@server/src/business-plugin-errors'
import type { BusinessServices } from '@server/src/business-services'

const root = fileURLToPath(new URL('../../', import.meta.url))
const owned = join(root, 'apps/server/.local')
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url))
const Fastify = require('fastify'), fp = require('fastify-plugin')
const fpUrl = JSON.stringify(pathToFileURL(require.resolve('fastify-plugin')).href)
const apps: FastifyInstance[] = [], directories: string[] = []
// Generated probes only use object identity; they never call a service method.
const services = () => Object.freeze({ authServices: {}, profileServices: {}, joinServices: {}, identityLinkServices:{},registrationServices:{},communityServices:{},storageServices: {}, notifications: {} }) as BusinessServices

function fixture(extension: 'js' | 'ts' = 'js') {
  mkdirSync(owned, { recursive: true })
  const directory = mkdtempSync(join(owned, 'autoload-')); directories.push(directory)
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  const roots: BusinessPluginRoots = { modules: join(directory, 'modules'), domains: join(directory, 'domains'), extension }
  mkdirSync(roots.modules); mkdirSync(roots.domains)
  function entry(stage: 'modules' | 'domains', name: string, options: { metadata?: string; body?: string; extra?: string; plain?: boolean } = {}) {
    const folder = join(roots[stage], name); mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `plugin.${extension}`), options.plain
      ? 'export default async function (app) {}'
      : `import fp from ${fpUrl};\nconst plugin = fp(async (app, options) => { ${options.body ?? `app.decorate('${name}', options.authServices)`} }, ${options.metadata ?? `{name:'business-${name}'}`});\n${options.extra ?? ''}\nexport default plugin;`)
    return folder
  }
  return { directory, roots, entry }
}
function boot(roots: BusinessPluginRoots, injection = services()) {
  const app: FastifyInstance = Fastify(); apps.push(app)
  app.register(fp(async (scope: FastifyInstance) => loadBusinessPlugins(scope, injection, roots), { name: 'test-business' }))
  return app
}
async function rejects(roots: BusinessPluginRoots, code: string) {
  await expect(boot(roots).ready()).rejects.toMatchObject({ code })
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => {})
  for (const directory of directories.splice(0)) {
    if (resolve(directory, '..') !== resolve(owned)) throw new Error('invalid owned cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('discovers new entries, excludes scripts/API and no-entry packages, and sorts dependencies', async () => {
  const { roots, entry } = fixture()
  const consumer = entry('modules', 'a-consumer', { metadata: "{name:'business-consumer',dependencies:['business-provider'],decorators:{fastify:['provided']}}", body: "app.decorate('consumer', app.getDecorator('provided'))" })
  entry('modules', 'z-provider', { metadata: "{name:'business-provider'}", body: "app.decorate('provided', options.authServices)" })
  entry('domains', 'joined', { metadata: "{name:'business-joined',dependencies:['business-consumer']}", body: "app.decorate('joined',app.getDecorator('consumer'))" })
  for (const path of ['service.js', 'probe.test.js', 'plugin.d.ts', 'autohooks.js']) writeFileSync(join(consumer, path), "throw new Error('EXCLUDED_IMPORT_SENTINEL')")
  mkdirSync(join(consumer, 'api')); writeFileSync(join(consumer, 'api/plugin.js'), "throw new Error('API_IMPORT_SENTINEL')")
  mkdirSync(join(roots.modules, 'unfinished')); writeFileSync(join(roots.modules, 'unfinished/package.json'), '{broken')
  writeFileSync(join(roots.modules, 'root-script.js'), "throw new Error('ROOT_IMPORT_SENTINEL')")
  const injection = services(), app = boot(roots, injection)
  await app.ready()
  expect(app.getDecorator('joined')).toBe(injection.authServices)
})

it('keeps independent service identities across app instances and boots TS imports with aliases', async () => {
  const { roots, entry } = fixture('ts')
  entry('modules', 'probe', { extra: "import { requireBusinessServices } from '@server/src/business-plugin-errors.js';", body: "requireBusinessServices('business-probe',{authServices:options.authServices});app.decorate('probe',options.authServices)" })
  const first = services(), second = services(), a = boot(roots, first), b = boot(roots, second)
  await a.ready(); await b.ready()
  expect(a.getDecorator('probe')).toBe(first.authServices)
  expect(b.getDecorator('probe')).toBe(second.authServices)
  expect(a.getDecorator('probe')).not.toBe(b.getDecorator('probe'))
})

it('completes all preflight checks before any plugin initializes', async () => {
  const { roots, entry } = fixture()
  entry('modules', 'first', { body: "throw new Error('MUST_NOT_BOOT')" })
  entry('domains', 'last', { plain: true })
  await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
})

it.each([
  ["{name:'business-repeat'}", "{name:'business-repeat'}", 'BUSINESS_PLUGIN_DUPLICATE_NAME'],
  ["{name:'business-first',dependencies:['business-absent']}", "{name:'business-second'}", 'BUSINESS_PLUGIN_MISSING_DEPENDENCY'],
  ["{name:'business-first',dependencies:['business-second']}", "{name:'business-second',dependencies:['business-first']}", 'BUSINESS_PLUGIN_CYCLIC_DEPENDENCY'],
  ["{name:'business-first',dependencies: 'business-second'}", "{name:'business-second'}", 'BUSINESS_PLUGIN_INVALID_ENTRY'],
  ["{name:'business-first',dependencies: null}", "{name:'business-second'}", 'BUSINESS_PLUGIN_INVALID_ENTRY'],
  ["{name:'SECRET_SENTINEL'}", "{name:'business-second'}", 'BUSINESS_PLUGIN_INVALID_ENTRY'],
  ["{name:'business-first',encapsulate:true}", "{name:'business-second'}", 'BUSINESS_PLUGIN_INVALID_ENTRY'],
])('rejects invalid graph/metadata: %s', async (first, second, code) => {
  const { roots, entry } = fixture()
  entry('modules', 'first', { metadata: first }); entry('modules', 'second', { metadata: second })
  await rejects(roots, code)
})

it('rejects public-to-domain dependencies', async () => {
  const { roots, entry } = fixture()
  entry('modules', 'first', { metadata: "{name:'business-first',dependencies:['business-second']}" })
  entry('domains', 'second', { metadata: "{name:'business-second'}" })
  await rejects(roots, 'BUSINESS_PLUGIN_INVALID_DEPENDENCY_DIRECTION')
})

it('classifies throwing metadata accessors as invalid without leaking their error', async () => {
  const { roots, entry } = fixture()
  entry('modules', 'probe', { extra: "Object.defineProperty(plugin, 'autoConfig', { get() { throw new Error('SECRET_GETTER') } });" })
  await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
})

it.each(['autoload', 'autoConfig', 'autoPrefix', 'prefixOverride'])('rejects namespace and function %s configuration', async key => {
  for (const namespace of [true, false]) {
    const { roots, entry } = fixture()
    entry('modules', 'probe', { extra: namespace ? `export const ${key} = ${key === 'autoload' ? 'false' : "'SECRET_SENTINEL'"};` : `plugin.${key} = ${key === 'autoload' ? 'false' : "'SECRET_SENTINEL'"};` })
    await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
  }
})

it('rejects dual extensions, root package and candidate CommonJS packages', async () => {
  {
    const { roots, entry } = fixture(), folder = entry('modules', 'probe')
    writeFileSync(join(folder, 'plugin.ts'), '')
    await rejects(roots, 'BUSINESS_PLUGIN_ENTRY_CONFLICT')
  }
  {
    const { roots } = fixture(); writeFileSync(join(roots.modules, 'package.json'), '{}')
    await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
  }
  {
    const { roots, entry } = fixture(), folder = entry('modules', 'probe')
    writeFileSync(join(folder, 'package.json'), '{"type":"commonjs"}')
    await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
  }
})

it('does not fall back between source and compiled extensions', async () => {
  for (const extension of ['ts', 'js'] as const) {
    const { roots } = fixture(extension), folder = join(roots.modules, 'probe'); mkdirSync(folder)
    writeFileSync(join(folder, `plugin.${extension === 'js' ? 'ts' : 'js'}`), "throw new Error('WRONG_MODE')")
    await boot(roots).ready()
  }
})

it('rejects an untyped candidate package instead of accepting a CommonJS default function', async () => {
  const { roots, entry } = fixture(), folder = entry('modules', 'probe')
  writeFileSync(join(folder, 'package.json'), '{}')
  writeFileSync(join(folder, 'plugin.js'), `const fp = require(${JSON.stringify(require.resolve('fastify-plugin'))}); module.exports = fp(async () => {}, {name:'business-probe'});`)
  await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
})

it('rejects linked roots and candidate directories', async () => {
  const { roots, directory } = fixture()
  const outside = join(directory, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(roots.modules, 'linked'), 'junction')
  await rejects(roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
  const next = fixture(); rmSync(next.roots.modules, { recursive: true })
  symlinkSync(outside, next.roots.modules, 'junction')
  await rejects(next.roots, 'BUSINESS_PLUGIN_INVALID_ENTRY')
})

it('wraps import/boot errors without secret messages and retains safe missing-service diagnostics', async () => {
  const probe = fixture(); const folder = probe.entry('modules', 'probe')
  writeFileSync(join(folder, 'plugin.js'), "throw new Error('SECRET_IMPORT')")
  await rejects(probe.roots, 'BUSINESS_PLUGIN_IMPORT_FAILED')
  const failed = fixture(); failed.entry('modules', 'probe', { body: "throw new Error('SECRET_BOOT')" })
  try { await boot(failed.roots).ready(); throw new Error('expected rejection') } catch (error) {
    expect(error).toBeInstanceOf(BusinessPluginLoadError)
    expect(formatBusinessPluginError(error as BusinessPluginLoadError)).not.toContain('SECRET_BOOT')
    expect(error).toMatchObject({ code: 'BUSINESS_PLUGIN_BOOT_FAILED', context: { stage: 'modules' } })
  }
  expect(() => requireBusinessServices('business-probe', { authServices: undefined })).toThrow(BusinessPluginLoadError)
  const error = new BusinessPluginLoadError('BUSINESS_PLUGIN_BOOT_FAILED', { pluginName: 'SECRET_NAME', missingServiceFields: ['SECRET_FIELD', 'authServices'] as never })
  error.message = 'SECRET_MESSAGE'
  expect(formatBusinessPluginError(error)).toContain('authServices')
  expect(formatBusinessPluginError(error)).not.toContain('SECRET')
})

it('lets Fastify verify actual decorator dependencies after metadata preflight', async () => {
  const { roots, entry } = fixture()
  entry('modules', 'provider', { body: '' })
  entry('modules', 'consumer', { metadata: "{name:'business-consumer',dependencies:['business-provider'],decorators:{fastify:['absent']}}" })
  await rejects(roots, 'BUSINESS_PLUGIN_BOOT_FAILED')
})
