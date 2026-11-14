/**
 * ZCode agent runtime setup (C2b): materializes and maintains, in
 * ~/.local/state/voicecast/zcode-runtime/, the built CLI of the open source
 * (U1) + its own auto-curated data-dir (U2) — making the headless goal
 * unlock durable.
 *
 * Root cause of the block (BUILD.md, U2 section): the standalone synthesis of
 * account providers REQUIRES the credential key
 * `account-provider:<providerId>:identity`, which the desktop does NOT write. Without it
 * the provider comes out `entitled: false` and `-p` dies at "Select a model before
 * continuing". The setup copies credentials.json from ~/.zcode/v2/ (READ
 * ONLY) into its own data-dir and injects the identity keys (idempotent;
 * re-copies if the original's mtime changed = self-heal if the desktop rotates it).
 *
 * Envs the runner receives from here:
 * - ZCODE_DATA_BASE_DIR  → <runtimeDir>/zcode-data (credentials at .zcode/v2/)
 * - ZCODE_BUILTIN_PROVIDER_CONFIG_FILE → <runtimeDir>/provider/zcode-builtin.json
 * - ZCODE_PERSONAL_PROVIDER_CONFIG_FILE → ~/.zcode/v2/provider_config.json (if it exists)
 *
 * Telemetry: counter voicecast_agent_runtime_setup_total{resultado}
 * (ok | stale | sem-build | sem-credencial). NEVER logs secrets — the module
 * prints nothing; only counts/paths.
 *
 * Pure Node (no electron) — testable on any OS with explicit paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { counter } from "../telemetry";

const M_SETUP = counter(
  "voicecast_agent_runtime_setup_total",
  "agent runtime setup by outcome (ok|stale|sem-build|sem-credencial)",
);

/** Distinct exit code for a missing prerequisite (no U1 build / no credentials). */
export const RUNTIME_SETUP_EXIT_MISSING_PREREQ = 87;

export type RuntimeSetupResultado = "ok" | "stale" | "sem-build" | "sem-credencial";

export interface RuntimePaths {
  /** Open source CLI build (U1): contains zcode, node24/, and provider/. */
  buildDir: string;
  /** Materialized runtime directory (persistent — don't use /tmp). */
  runtimeDir: string;
  /** Desktop credentials (read-only). */
  credentialsSrc: string;
  /** Desktop personal provider config (read-only; optional). */
  personalProviderSrc: string;
}

export interface RuntimeSetupResult {
  resultado: RuntimeSetupResultado;
  nodeBin: string;
  agentBin: string;
  providerConfigFile: string;
  dataBaseDir: string;
  /** Envs ready for the goal spawn. */
  env: Record<string, string>;
}

export class RuntimeSetupError extends Error {
  constructor(
    readonly code: "SEM_BUILD" | "SEM_CREDENCIAL",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSetupError";
  }
}

/** api-key key written by the desktop → identity key required by the standalone synthesis (U2). */
const API_KEY_KEY = /^account-provider:coding-plan:(account:[^:]+):account:([^:]+):api-key$/;

/**
 * Injects the identity keys into the credentials map (PURE — mutates the object).
 * Value = the UUID that already appears in the api-key key NAME (account
 * identifier, not a request secret). Idempotent: only adds if absent.
 * @returns how many keys were added.
 */
export function injectIdentityKeys(data: Record<string, unknown>): number {
  let added = 0;
  for (const k of Object.keys(data)) {
    const m = API_KEY_KEY.exec(k);
    if (!m) continue;
    const identityKey = `account-provider:${m[1]}:identity`;
    if (!Object.prototype.hasOwnProperty.call(data, identityKey)) {
      data[identityKey] = m[2];
      added++;
    }
  }
  return added;
}

export function defaultRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const home = os.homedir();
  return {
    buildDir: env.VOICECAST_ZCODE_BUILD_DIR || "/tmp/zcode-cli-build",
    runtimeDir: env.VOICECAST_RUNTIME_DIR || path.join(home, ".local", "state", "voicecast", "zcode-runtime"),
    credentialsSrc: path.join(home, ".zcode", "v2", "credentials.json"),
    personalProviderSrc: path.join(home, ".zcode", "v2", "provider_config.json"),
  };
}

async function statIf(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await statIf(p)) !== null;
}

/** Copies `src` → `dst` (file) if dst is absent or src is newer/size differs. @returns true if re-copied over an existing dst. */
async function copyIfStale(src: string, dst: string, mode?: number): Promise<boolean> {
  const s = await statIf(src);
  const d = await statIf(dst);
  if (!d) {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    if (mode !== undefined) await fs.promises.chmod(dst, mode);
    return false; // new provisioning
  }
  if (s && (s.mtimeMs > d.mtimeMs || s.size !== d.size)) {
    await fs.promises.copyFile(src, dst);
    if (mode !== undefined) await fs.promises.chmod(dst, mode);
    return true; // refresh over existing material
  }
  return false;
}

/**
 * Ensures the complete runtime (binaries + provider + auto-curated credentials).
 * Idempotent and mtime self-heal. DURABLE: if the runtime is already complete,
 * buildDir is not required (it only serves to materialize/refresh).
 * Errors: RuntimeSetupError SEM_BUILD (missing U1 prerequisite) /
 * SEM_CREDENCIAL (user without desktop login). Never prints secrets.
 */
export async function ensureRuntime(paths: RuntimePaths = defaultRuntimePaths()): Promise<RuntimeSetupResult> {
  const { buildDir, runtimeDir, credentialsSrc, personalProviderSrc } = paths;
  const srcZcode = path.join(buildDir, "zcode");
  const srcNode = path.join(buildDir, "node24", "bin", "node");
  const srcProvider = path.join(buildDir, "provider", "zcode-builtin.json");
  const dstZcode = path.join(runtimeDir, "zcode");
  const dstNode = path.join(runtimeDir, "node24", "bin", "node");
  const dstProvider = path.join(runtimeDir, "provider", "zcode-builtin.json");

  const semBuild = (what: string): never => {
    M_SETUP?.add(1, { resultado: "sem-build" });
    throw new RuntimeSetupError(
      "SEM_BUILD",
      `incomplete agent runtime (${what}); materialize the U1 build at ${buildDir} ` +
        `(missing-prerequisite exit code: ${RUNTIME_SETUP_EXIT_MISSING_PREREQ}) — see docs/wp/U1-build-cli.md`,
    );
  };

  let refreshed = false;

  // 1. zcode binary (esbuild for node 24)
  if (!(await exists(dstZcode))) {
    if (!(await exists(srcZcode))) semBuild("zcode binary missing");
    if (await copyIfStale(srcZcode, dstZcode, 0o755)) refreshed = true;
  } else {
    const s = await statIf(srcZcode);
    const d = (await statIf(dstZcode))!;
    if (s && (s.mtimeMs > d.mtimeMs || s.size !== d.size)) {
      await fs.promises.copyFile(srcZcode, dstZcode);
      await fs.promises.chmod(dstZcode, 0o755);
      refreshed = true;
    }
  }

  // 2. node24/ (the binary is esbuild — spawn ALWAYS with this node, never the system one)
  if (!(await exists(dstNode))) {
    if (!(await exists(srcNode))) semBuild("node24 runtime missing");
    await fs.promises.rm(path.join(runtimeDir, "node24"), { recursive: true, force: true });
    await fs.promises.cp(path.join(buildDir, "node24"), path.join(runtimeDir, "node24"), { recursive: true });
  } else {
    const s = await statIf(srcNode);
    const d = (await statIf(dstNode))!;
    if (s && s.mtimeMs > d.mtimeMs) {
      await fs.promises.rm(path.join(runtimeDir, "node24"), { recursive: true, force: true });
      await fs.promises.cp(path.join(buildDir, "node24"), path.join(runtimeDir, "node24"), { recursive: true });
      refreshed = true;
    }
  }

  // 3. bundled provider config (CLI fallback/early-return — BUILD.md U1)
  if (!(await exists(dstProvider))) {
    if (!(await exists(srcProvider))) semBuild("provider/zcode-builtin.json missing");
    if (await copyIfStale(srcProvider, dstProvider)) refreshed = true;
  } else {
    const s = await statIf(srcProvider);
    const d = (await statIf(dstProvider))!;
    if (s && (s.mtimeMs > d.mtimeMs || s.size !== d.size)) {
      await fs.promises.copyFile(srcProvider, dstProvider);
      refreshed = true;
    }
  }

  // 4. own data-dir with auto-curated credentials (U2) — ~/.zcode read-only
  const dataBaseDir = path.join(runtimeDir, "zcode-data");
  const dstCred = path.join(dataBaseDir, ".zcode", "v2", "credentials.json");
  if (!(await exists(credentialsSrc))) {
    M_SETUP?.add(1, { resultado: "sem-credencial" });
    throw new RuntimeSetupError(
      "SEM_CREDENCIAL",
      `credentials missing at ${credentialsSrc} — log in to the zcode desktop before running goals`,
    );
  }
  let credStale = false;
  const dstCredStat = await statIf(dstCred);
  const srcCredStat = (await statIf(credentialsSrc))!;
  if (!dstCredStat || srcCredStat.mtimeMs > dstCredStat.mtimeMs) {
    // NEVER log content — reads, injects identity keys, and writes with 600.
    const data = JSON.parse(await fs.promises.readFile(credentialsSrc, "utf8")) as Record<string, unknown>;
    injectIdentityKeys(data);
    await fs.promises.mkdir(path.dirname(dstCred), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(dstCred, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.chmod(dstCred, 0o600);
    for (const dir of [dataBaseDir, path.join(dataBaseDir, ".zcode"), path.dirname(dstCred)]) {
      await fs.promises.chmod(dir, 0o700).catch(() => {});
    }
    credStale = dstCredStat !== null; // re-copy over existing material = self-heal
  }

  const resultado: RuntimeSetupResultado = refreshed || credStale ? "stale" : "ok";
  const env: Record<string, string> = {
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: dstProvider,
  };
  if (await exists(personalProviderSrc)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalProviderSrc;
  M_SETUP?.add(1, { resultado });
  return { resultado, nodeBin: dstNode, agentBin: dstZcode, providerConfigFile: dstProvider, dataBaseDir, env };
}

// --- Per-process cache: self-heal runs once per bridge start ("each start") ---

let cached: Promise<RuntimeSetupResult> | null = null;

/** ensureRuntime with per-process cache (failure isn't cached — retry on the next goal). */
export function ensureRuntimeCached(paths: RuntimePaths = defaultRuntimePaths()): Promise<RuntimeSetupResult> {
  if (!cached) {
    cached = ensureRuntime(paths).catch((e) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

/** For tests only: clears the per-process cache. */
export function resetRuntimeCache(): void {
  cached = null;
}

/**
 * Same credentials sync logic, as a standalone program (CommonJS,
 * no imports) for the SELF-HEAL inside WSL on the Windows spawn: the sh script
 * runs `node24 -e $VOICECAST_SETUP_JS <credentials-src> <data-base-dir>`.
 * Parity with injectIdentityKeys guaranteed by test (same output).
 */
export const SETUP_CREDENTIALS_JS = `
const fs = require("fs"), path = require("path");
const src = process.argv[1], base = process.argv[2];
if (!src || !base) { console.error("usage: node -e <script> <credentials-src> <data-base-dir>"); process.exit(64); }
if (!fs.existsSync(src)) { console.error("voicecast-agent: credentials missing: " + src); process.exit(87); }
const dstDir = path.join(base, ".zcode", "v2");
const dst = path.join(dstDir, "credentials.json");
fs.mkdirSync(dstDir, { recursive: true });
if (fs.existsSync(dst) && fs.statSync(src).mtimeMs <= fs.statSync(dst).mtimeMs) process.exit(0);
const data = JSON.parse(fs.readFileSync(src, "utf8"));
let added = 0;
for (const k of Object.keys(data)) {
  const m = /^account-provider:coding-plan:(account:[^:]+):account:([^:]+):api-key$/.exec(String(k));
  if (m && !Object.prototype.hasOwnProperty.call(data, "account-provider:" + m[1] + ":identity")) {
    data["account-provider:" + m[1] + ":identity"] = m[2];
    added += 1;
  }
}
fs.writeFileSync(dst, JSON.stringify(data, null, 2) + "\\n", { mode: 0o600 });
fs.chmodSync(dst, 0o600);
console.log("voicecast-agent: credentials synced (identity+" + added + ")");
`.trim();
