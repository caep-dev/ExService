import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import autoload from '@fastify/autoload'
import type { BusinessServices } from './business-services.js'
import { BusinessPluginLoadError, businessDirectoryPattern, businessPluginNamePattern, requireBusinessServices, type BusinessPluginStage } from './business-plugin-errors.js'

interface Candidate {
  stage: BusinessPluginStage
  root: string
  file: string
  location: string
  directory: string
  name: string
  dependencies: string[]
}
export interface BusinessPluginRoots { modules: string; domains: string; extension: 'ts' | 'js' }
const base = dirname(fileURLToPath(import.meta.url))
const defaultRoots: BusinessPluginRoots = {
  modules: join(base, 'modules'), domains: join(base, 'domains'),
  extension: extname(fileURLToPath(import.meta.url)) === '.ts' ? 'ts' : 'js',
}

async function stat(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** The only adapter for fastify-plugin@6 metadata; invalid structure fails closed. */
function metadata(namespace: Record<string, unknown>, candidate: Pick<Candidate, 'stage' | 'location'>) {
  const invalid = () => new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', candidate)
  const plugin = namespace.default
  if (typeof plugin !== 'function') throw invalid()
  const properties = plugin as unknown as Record<string | symbol, unknown>
  const meta = properties[Symbol.for('plugin-meta')] as Record<string, unknown> | undefined
  if (!meta || properties[Symbol.for('skip-override')] !== true ||
      typeof meta.name !== 'string' || !businessPluginNamePattern.test(meta.name)) throw invalid()
  for (const source of [namespace, properties]) {
    if (source.autoload === false || ['autoConfig', 'autoPrefix', 'prefixOverride'].some(key => source[key] !== undefined)) throw invalid()
  }
  const dependencies = meta.dependencies === undefined ? [] : meta.dependencies
  if (!Array.isArray(dependencies) || dependencies.some(value => typeof value !== 'string' || !businessPluginNamePattern.test(value))) throw invalid()
  return { name: meta.name, dependencies: dependencies as string[] }
}

async function discover(roots: BusinessPluginRoots): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (const stage of ['modules', 'domains'] as const) {
    const root = roots[stage]
    try {
      const rootStat = await stat(root)
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || await stat(join(root, 'package.json'))) {
        throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage })
      }
      const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        // Links are rejected before probing or traversing their targets.
        if (entry.isSymbolicLink()) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage })
        if (!entry.isDirectory()) continue
        const directory = entry.name
        const folder = join(root, directory)
        const ts = await stat(join(folder, 'plugin.ts')), js = await stat(join(folder, 'plugin.js'))
        if (!ts && !js) continue
        if (!businessDirectoryPattern.test(directory)) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage })
        const location = `${stage}/${directory}/plugin.${roots.extension}`
        if (ts && js) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_ENTRY_CONFLICT', { stage, location })
        const target = roots.extension === 'ts' ? ts : js
        if (!target) continue
        if (!target.isFile() || target.isSymbolicLink()) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage, location })
        const packagePath = join(folder, 'package.json'), packageStat = await stat(packagePath)
        if (packageStat) {
          if (!packageStat.isFile() || packageStat.isSymbolicLink()) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage, location })
          const packageInfo: unknown = JSON.parse(await readFile(packagePath, 'utf8'))
          if (!packageInfo || typeof packageInfo !== 'object' || Array.isArray(packageInfo) ||
              !('type' in packageInfo) || packageInfo.type !== 'module') throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage, location })
        }
        candidates.push({ stage, root, directory, file: join(folder, `plugin.${roots.extension}`), location, name: '', dependencies: [] })
      }
    } catch (error) {
      if (error instanceof BusinessPluginLoadError) throw error
      throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', { stage })
    }
  }
  return candidates
}

async function preflight(candidates: Candidate[]) {
  const byName = new Map<string, Candidate>()
  for (const candidate of candidates) {
    let namespace: Record<string, unknown>
    try { namespace = await import(pathToFileURL(candidate.file).href) } catch {
      throw new BusinessPluginLoadError('BUSINESS_PLUGIN_IMPORT_FAILED', candidate)
    }
    try { Object.assign(candidate, metadata(namespace, candidate)) } catch (error) {
      if (error instanceof BusinessPluginLoadError) throw error
      throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_ENTRY', candidate)
    }
    if (byName.has(candidate.name)) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_DUPLICATE_NAME', { ...candidate, pluginName: candidate.name })
    byName.set(candidate.name, candidate)
  }
  for (const candidate of candidates) for (const dependencyName of candidate.dependencies) {
    const dependency = byName.get(dependencyName)
    const context = { ...candidate, pluginName: candidate.name, dependencyName }
    if (!dependency) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_MISSING_DEPENDENCY', context)
    if (candidate.stage === 'modules' && dependency.stage === 'domains') throw new BusinessPluginLoadError('BUSINESS_PLUGIN_INVALID_DEPENDENCY_DIRECTION', context)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  function visit(candidate: Candidate) {
    if (visiting.has(candidate.name)) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_CYCLIC_DEPENDENCY', { ...candidate, pluginName: candidate.name })
    if (visited.has(candidate.name)) return
    visiting.add(candidate.name)
    for (const dependency of candidate.dependencies) visit(byName.get(dependency)!)
    visiting.delete(candidate.name); visited.add(candidate.name)
  }
  candidates.forEach(visit)
}

/** Paths are injectable only for owned test fixtures, never through CreateAppOptions. */
export async function loadBusinessPlugins(app: FastifyInstance, services: BusinessServices, roots: BusinessPluginRoots = defaultRoots): Promise<void> {
  const candidates = await discover(roots)
  await preflight(candidates)
  for (const stage of ['modules', 'domains'] as const) {
    const batch = candidates.filter(candidate => candidate.stage === stage)
    if (!batch.length) continue
    const accepted = new Set(batch.map(candidate => `/${candidate.directory}/plugin.${roots.extension}`))
    const directories = batch.map(candidate => candidate.directory).join('|')
    try {
      await app.register(autoload, {
        dir: roots[stage], maxDepth: 1, indexPattern: new RegExp(`^plugin\\.${roots.extension}$`),
        scriptPattern: new RegExp(`^plugin\\.${roots.extension}$`),
        matchFilter: path => accepted.has(path.replaceAll('\\', '/')),
        ignorePattern: new RegExp(`^(?!(?:${directories})(?:/|$))`),
        dirNameRoutePrefix: false, autoHooks: false, routeParams: false, forceESM: true, encapsulate: true,
        options: services,
      })
    } catch (error) {
      if (error instanceof BusinessPluginLoadError) throw error
      throw new BusinessPluginLoadError('BUSINESS_PLUGIN_BOOT_FAILED', { stage })
    }
  }
}

const businessPlugins: FastifyPluginAsync<BusinessServices> = async (app, services) => {
  requireBusinessServices('application-business-plugins', { identityLinkServices: services.identityLinkServices })
  await loadBusinessPlugins(app, services)
}
export default fp(businessPlugins, { name: 'application-business-plugins', fastify: '5.x' })
