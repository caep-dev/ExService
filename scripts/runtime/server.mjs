import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { root } from './shared.mjs'
import { LocalError } from './local-config.mjs'
import { readRuntimeConfiguration } from './settings.mjs'

export function serverSpecification(action, args = [], { workspace = root, inherited = process.env } = {}) {
  const entries = { dev: 'src/server.ts', start: 'dist/server.js', 'db:migrate': 'src/db/migrate.ts', 'db:reset': 'src/db/reset.ts',
    'db:registration-inventory': 'src/db/public-registration-inventory-cli.ts',
    'sso:create': 'src/cli/sso-create.ts', 'sso:inspect': 'src/cli/sso-inspect.ts', 'auth:disable': 'src/cli/auth-disable.ts',
    'auth:enable': 'src/cli/auth-enable.ts', 'integration:check': 'src/cli/integration-check.ts', 'support-feedback': 'src/cli/support-feedback.ts' }
  if (!Object.hasOwn(entries, action)) throw new LocalError('RUNTIME_SERVER_ACTION_INVALID')
  // Only the root adapter's explicit service snapshot bypasses configuration loading.
  const environment = inherited.RUNTIME_ENV_INJECTED === 'true'
    ? inherited : readRuntimeConfiguration({ workspace, inherited }).environments.server
  const compiled = action !== 'dev' && environment.NODE_ENV === 'production'
  const entry = compiled ? entries[action].replace(/^src\//, 'dist/').replace(/\.ts$/, '.js') : entries[action]
  return { command: process.execPath, cwd: join(workspace, 'apps/server'), environment,
    args: [...(action === 'start' || compiled ? [] : ['--import', 'tsx']), ...(action === 'dev' ? ['--watch'] : []), entry, ...(args[0] === '--' ? args.slice(1) : args)] }
}
export async function main(action = process.argv[2], args = process.argv.slice(3)) {
  if (action === 'dev') {
    const { generate } = await import('../api/generate.mjs')
    await generate('generate')
  }
  const spec = serverSpecification(action, args), child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.environment, stdio: 'inherit', shell: false, windowsHide: true })
  const relay = signal => { if (!child.killed) child.kill(signal) }
  const interrupt = () => relay('SIGINT'), terminate = () => relay('SIGTERM')
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  try {
    const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept(code ?? (signal ? 1 : 0))) })
    process.exitCode = result
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error(error instanceof LocalError ? error.message : 'RUNTIME_SERVER_FAILED'); process.exitCode = 1 }
}
