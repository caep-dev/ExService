import { defineConfig } from 'vitest/config'
import base from '../../vitest.config.ts'
export default defineConfig({ ...base, test: { ...base.test, include: ['tests/cfx/live-runner.ts'], maxWorkers: 1 } })
