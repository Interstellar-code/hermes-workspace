import { URL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import os from 'node:os'

// devtools removed
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// nitro plugin removed (tanstackStart handles server runtime)
import { defineConfig, loadEnv } from 'vite'
import mkcert from 'vite-plugin-mkcert'

// ---------------------------------------------------------------------------
// Hermes Agent auto-start helpers
// ---------------------------------------------------------------------------

/** Resolve the hermes-agent directory using a priority-ordered fallback chain:
 *  1. CLAUDE_AGENT_PATH env var (explicit override)
 *  2. ../hermes-agent  — sibling clone (standard README setup)
 *  3. ../../hermes-agent — one level up (monorepo / nested workspace)
 *  Returns null if none found.
 */
function resolveClaudeAgentDir(env: Record<string, string>): string | null {
  const candidates: string[] = []

  if (env.CLAUDE_AGENT_PATH?.trim()) {
    candidates.push(env.CLAUDE_AGENT_PATH.trim())
  }

  // Resolve relative to the workspace root (parent of hermes-switchui/)
  const workspaceRoot = dirname(resolve('.'))
  candidates.push(
    resolve(workspaceRoot, 'hermes-agent'), // sibling (old README)
    resolve(workspaceRoot, '..', 'hermes-agent'), // one level up
    resolve(os.homedir(), '.claude', 'hermes-agent'), // Nous installer default
    resolve(os.homedir(), 'hermes-agent'), // ~/hermes-agent
  )

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'webapi'))) return candidate
  }
  return null
}

/** Find the Hermes CLI binary used to start the local gateway. */
function resolveClaudeBinary(): string | null {
  const candidates = [
    process.env.HERMES_CLI_BIN || '',
    resolve(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
    resolve(os.homedir(), '.claude', 'bin', 'claude'),
    resolve(os.homedir(), '.local', 'bin', 'claude'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Resolve the Python executable to use for Hermes backend startup.
 *  Prefers .venv/bin/python inside agentDir, falls back to system python3.
 */
function resolveClaudePython(agentDir: string): string {
  const venvPython = resolve(agentDir, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  // uv creates 'venv' not '.venv' sometimes
  const uvVenv = resolve(agentDir, 'venv', 'bin', 'python')
  if (existsSync(uvVenv)) return uvVenv
  return 'python3'
}

/** Check if hermes-agent health endpoint is responding */
async function isClaudeAgentHealthy(port = 8642): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return r.ok
  } catch {
    return false
  }
}

const config = defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const claudeApiUrl = env.CLAUDE_API_URL?.trim() || 'http://127.0.0.1:8642'
  // /api/connection-status is handled by the real route file at
  // src/routes/api/connection-status.ts; the dev server no longer
  // intercepts that path with a slim shortcut. See #285.

  // Hermes Agent auto-start state
  let claudeAgentChild: ChildProcess | null = null
  let claudeAgentStarted = false

  const startClaudeAgent = async () => {
    if (claudeAgentStarted) return
    // Skip auto-start when CLAUDE_API_URL is explicitly set to a non-local endpoint
    const explicitUrl =
      env.CLAUDE_API_URL || process.env.CLAUDE_API_URL || claudeApiUrl || ''
    if (
      explicitUrl &&
      explicitUrl !== 'http://127.0.0.1:8642' &&
      explicitUrl !== 'http://localhost:8642'
    ) {
      console.log(
        `[hermes-agent] Skipping auto-start — using external API: ${explicitUrl}`,
      )
      claudeAgentStarted = true
      return
    }
    if (await isClaudeAgentHealthy()) {
      console.log('[hermes-agent] Already running — reusing existing process')
      claudeAgentStarted = true
      return
    }

    const claudeBin = resolveClaudeBinary()
    const agentDir = resolveClaudeAgentDir(env)

    // Prefer the `hermes gateway run` binary path (Nous installer's canonical
    // entrypoint). Fall back to launching uvicorn against the source tree if
    // only a directory is present (dev / cloned-in-place setups).
    let launchCmd: string
    let commandArgs: string[]
    let launchCwd: string | undefined

    if (claudeBin) {
      launchCmd = claudeBin
      commandArgs = ['gateway', 'run']
      launchCwd = agentDir ?? undefined
      console.log(`[hermes-agent] Starting ${claudeBin} gateway run`)
    } else if (agentDir) {
      launchCmd = resolveClaudePython(agentDir)
      const useGatewayRun = existsSync(resolve(agentDir, 'gateway', 'run.py'))
      commandArgs = useGatewayRun
        ? ['-m', 'gateway.run']
        : [
            '-m',
            'uvicorn',
            'webapi.app:app',
            '--host',
            '0.0.0.0',
            '--port',
            '8642',
          ]
      launchCwd = agentDir
      console.log(
        `[hermes-agent] Starting from ${agentDir} using ${launchCmd} (${useGatewayRun ? 'gateway.run' : 'uvicorn'})`,
      )
    } else {
      console.warn(
        '[hermes-agent] Could not find hermes-agent installation.\n' +
          '  Run the installer:\n' +
          '    curl -fsSL https://hermes-switchui.com/install.sh | bash\n' +
          '  Or set CLAUDE_AGENT_PATH in .env to point at your hermes-agent clone.',
      )
      return
    }

    const child = spawn(launchCmd, commandArgs, {
      cwd: launchCwd,
      detached: false, // keep tied to vite process — stops when dev server stops
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: [
          resolve(os.homedir(), '.claude', 'bin'),
          resolve(os.homedir(), '.local', 'bin'),
          agentDir ? resolve(agentDir, '.venv', 'bin') : '',
          agentDir ? resolve(agentDir, 'venv', 'bin') : '',
          process.env.PATH || '',
        ]
          .filter(Boolean)
          .join(':'),
      },
    })

    claudeAgentChild = child
    claudeAgentStarted = true

    child.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log(`[hermes-agent] ${line}`)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log(`[hermes-agent] ${line}`)
    })

    child.on('exit', (code) => {
      claudeAgentChild = null
      claudeAgentStarted = false
      if (code !== 0 && code !== null) {
        console.warn(`[hermes-agent] Exited with code ${code}`)
      }
    })

    // Wait for healthy with bounded backoff (≈15s total, faster first probes).
    const intervals = [500, 500, 750, 1000, 1500, 2000, 2500, 3000, 3250]
    for (const wait of intervals) {
      await new Promise((r) => setTimeout(r, wait))
      if (await isClaudeAgentHealthy()) {
        console.log('[hermes-agent] ✓ Ready on http://127.0.0.1:8642')
        return
      }
    }
    console.warn(
      '[hermes-agent] Started but health check timed out — may still be loading',
    )
  }

  // Allow access from Tailscale, LAN, or custom domains via env var
  // e.g. CLAUDE_ALLOWED_HOSTS=my-server.tail1234.ts.net,192.168.1.50
  const _allowedHosts: string[] | true = env.CLAUDE_ALLOWED_HOSTS?.trim()
    ? env
        .CLAUDE_ALLOWED_HOSTS!.split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    : ['.ts.net'] // allow all Tailscale hostnames by default
  let proxyTarget = 'http://127.0.0.1:18789'

  try {
    const parsed = new URL(claudeApiUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = ''
    proxyTarget = parsed.toString().replace(/\/$/, '')
  } catch {
    // fallback
  }

  return {
    build: {
      // Vite 8 defaults CSS minification to Lightning CSS, which rejects
      // this app's existing layered Matrix CSS keyframes. Keep the previous
      // esbuild minifier until those stylesheet layers are normalized.
      cssMinify: 'esbuild',
    },
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/skills-bundle/**',
        '**/.{idea,git,cache,output,temp}/**',
        'e2e/**',
        '**/*.skip.test.ts',
      ],
      // Same escape hatch the build uses (package.json `build`). Without it
      // every vitest worker that imports gateway-capabilities starts a real
      // gateway probe + plugin-sync heartbeat: live I/O, timers that outlive
      // the environment, and an unhandled rejection that flips the exit code
      // on an otherwise-passing suite. Tests that want the probe set it back.
      env: {
        HERMES_SKIP_GATEWAY_BOOT: '1',
      },
      // Force vitest to run React through its own transform pipeline so ESM
      // `import` and CJS `require('react')` share a single module instance.
      // Without this, react-dom sets the dispatcher on its CJS React copy while
      // components call hooks on the ESM React copy → null dispatcher → crash.
      deps: {
        inline: [
          'react',
          'react-dom',
          '@testing-library/react',
          '@testing-library/dom',
        ],
      },
      server: {
        deps: {
          external: ['better-sqlite3'],
        },
      },
      // Native .node addons (better-sqlite3) cannot load in worker_threads.
      // Run workflow-engine tests in a forked Node process instead.
      poolMatchGlobs: [
        ['**/workflow-engine/**', 'forks'],
      ],
    },
    define: {
      // Note: Do NOT set 'process.env': {} here — TanStack Start uses environment-based
      // builds where isSsrBuild is unreliable. Blanket process.env replacement breaks
      // server-side code in Docker (kills runtime env var access).
      // Client-side process.env is handled per-environment below.
      __APP_VERSION__: JSON.stringify(
        (JSON.parse(
          readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
        ) as { version: string }).version,
      ),
    },
    resolve: {
      // Base UI's optimized CommonJS modules must share the application's React
      // instance. Without deduping, hooks can resolve to a null dispatcher.
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        'next/image': fileURLToPath(new URL('./src/shims/next-image.tsx', import.meta.url)),
      },
      tsconfigPaths: true,
    },
    ssr: {
      external: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    optimizeDeps: {
      exclude: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    server: {
      // Force IPv4 — 'localhost' resolves to ::1 (IPv6) on Windows, breaking connectivity
      host: '0.0.0.0',
      // Port precedence:
      //   1. --port CLI flag (wins, but we no longer hardcode it in package.json)
      //   2. $PORT env var (for containers, reverse proxies, WhatsApp bridge collisions, etc. — see #96)
      //   3. default 3000 (matches README/docs/docker-compose expectations)
      port: process.env.PORT ? Number(process.env.PORT) : 3000,
      strictPort: false, // allow fallback if port is taken, but log clearly
      allowedHosts: true,
      watch: {
        ignored: [
          // NOTE: the generated TanStack route tree must NOT be added to this
          // ignore list — doing so causes route changes to require a full
          // dev-server restart. See src/router-route-resolution.test.ts.
          // Real fix for HMR thrash on the generated tree is to ensure only
          // ONE vite dev server runs against this source tree at a time.
          // Local portable session store, rewritten on every chat send.
          // Without this, the watcher fires on every message → spurious
          // server-side reload events / test churn during development.
          '**/.runtime/**',
          // Internal TanStack Start state cache.
          '**/.tanstack/**',
          // Local plan/notes/scratch state used by OMC tooling — never
          // imported by the module graph, but file events still spam logs.
          '**/.omc/**',
          '**/.omx/**',
          // Build artifacts.
          '**/dist/**',
          '**/.output/**',
          // Test/coverage outputs.
          '**/coverage/**',
          '**/playwright-report/**',
          '**/test-results/**',
          // Editor / agent metadata.
          '**/.vscode/**',
          '**/.claude/**',
          '**/.cursor/**',
          // Loose log files.
          '**/*.log',
        ],
      },
      proxy: {
        // REST API proxy: API proxy for Hermes backend
        '/api/claude-proxy': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/claude-proxy/, ''),
        },
      },
    },
    plugins: [
      // Local HTTPS for the Userback widget (screen capture + annotation APIs
      // require a secure context). vite-plugin-mkcert auto-installs the local
      // CA on first run and generates a trusted cert for localhost + LAN IPs.
      // List this first so its `configureServer` hook switches the dev server
      // to HTTPS before the proxy/HMR plugins attach.
      ...(command === 'serve' && mode !== 'production'
        ? [
            mkcert({
              // Default hosts cover `localhost` and auto-discovered LAN IPs.
              // Add a Tailscale hostname here (e.g. 'mac.tail1234.ts.net') if Chrome
              // complains about cert mismatch when accessing over Tailscale.
            }),
          ]
        : []),
      // Restart dev server when package.json changes so __APP_VERSION__
      // (computed once at config load via `define`) re-evaluates and the
      // sidebar version chip stays in sync with `pnpm version` bumps.
      {
        name: 'restart-on-package-json',
        configureServer(server) {
          const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url))
          server.watcher.add(pkgPath)
          server.watcher.on('change', (file) => {
            if (file === pkgPath) {
              server.restart()
            }
          })
        },
      },
      // devtools(),
      tailwindcss(),
      tanstackStart({ spa: { enabled: true, maskPath: '/settings' } }),
      viteReact(),
      {
        name: 'workspace-daemon',
        buildStart() {
          if (command !== 'serve') return
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const requestPath = req.url?.split('?')[0]
            if (req.method === 'GET' && requestPath === '/api/healthcheck') {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            // /api/connection-status is handled by the real route file at
            // src/routes/api/connection-status.ts — it returns the full
            // ConnectionStatus payload including capabilities and chatMode
            // that downstream feature gates depend on. Earlier versions
            // had an inline shortcut handler here that returned a slim
            // body ({ok, mode, backend}) which silently broke things like
            // useFeatureCapability/useFeatureAvailable in dev mode. See #285.

            next()
          })

          // Dev-only: disable Node's default 5-minute request timeout so
          // long-running SSE streams (agent runs that go silent for minutes
          // during heavy reasoning / tool calls) don't get killed mid-stream
          // by the HTTP layer. Heartbeats handle keep-alive at the application
          // layer. Production servers should keep their default timeouts to
          // avoid slowloris exposure.
          if (command === 'serve' && server.httpServer) {
            const httpServer = server.httpServer as unknown as {
              requestTimeout?: number
              headersTimeout?: number
              timeout?: number
            }
            httpServer.requestTimeout = 0
            httpServer.headersTimeout = 0
            httpServer.timeout = 0
          }

          // Auto-start hermes-agent when dev server launches.
          // Vitest also runs as `command === 'serve'`, so without the VITEST
          // guard a test run probes the gateway and — on a machine with none
          // running, i.e. CI — spawns a real hermes-agent process.
          if (command === 'serve' && !process.env.VITEST) {
            void startClaudeAgent()
          }

          // Shutdown hermes-agent when dev server stops
          server.httpServer?.on('close', () => {
            if (claudeAgentChild) {
              console.log('[hermes-agent] Stopping...')
              claudeAgentChild.kill('SIGTERM')
              claudeAgentChild = null
              claudeAgentStarted = false
            }
          })
        },
      },
      // Client-only: replace process.env references in client bundles
      // Server bundles must keep real process.env for Docker runtime env vars
      {
        name: 'client-process-env',
        enforce: 'pre',
        transform(code, _id) {
          const envName = this.environment?.name
          if (envName !== 'client') return null
          if (
            !code.includes('process.env') &&
            !code.includes('process.platform')
          )
            return null

          // Replace specific env vars first, then the generic fallback
          let result = code
          result = result.replace(
            /process\.env\.CLAUDE_API_URL/g,
            JSON.stringify(claudeApiUrl),
          )
          result = result.replace(
            /process\.env\.CLAUDE_API_TOKEN/g,
            JSON.stringify(env.CLAUDE_API_TOKEN || ''),
          )
          result = result.replace(
            /process\.env\.NODE_ENV/g,
            JSON.stringify(mode),
          )
          result = result.replace(/process\.env/g, '{}')
          result = result.replace(/process\.platform/g, '"browser"')
          return result
        },
      },
      // Copy pty-helper.py into the server assets directory after build
      {
        name: 'copy-pty-helper',
        closeBundle() {
          const src = resolve('src/server/pty-helper.py')
          const destDir = resolve('dist/server/assets')
          const dest = resolve(destDir, 'pty-helper.py')
          if (existsSync(src)) {
            mkdirSync(destDir, { recursive: true })
            copyFileSync(src, dest)
          }
        },
      },
    ],
  }
})

export default config
