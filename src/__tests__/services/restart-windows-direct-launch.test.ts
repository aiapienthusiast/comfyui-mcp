// ON WINDOWS, NOTHING HERE LAUNCHES COMFYUI ITSELF (#2947, #2948).
//
// A process this server spawns is a descendant of the agent's process tree, and
// agent teardown kills that tree: Codex's AppServerClient.close ends with
// `taskkill /PID <wrapper> /T /F`, and an orchestrator self-update does the same.
// `detached: true` + `unref()` do not take a child out of the tree, so a ComfyUI
// launched by restart_comfyui (action:"start") died with the agent.
//
// The containment: every direct spawn is refused on Windows, and every restart
// that would depend on one refuses BEFORE stopping anything. What still works is
// what never spawned from here — a verified Desktop supervisor cycling its own
// backend through ComfyUI-Manager, and the user's COMFYUI_RESTART_COMMAND. An
// explicit stop still stops, and says plainly that action:"start" cannot undo it.
//
// PLATFORM-PINNED to win32 so every CI leg runs the Windows branch. Paths are
// absolute Windows paths, which process-control handles separator-agnostically,
// and node:fs is mocked, so the host's own path rules never decide an outcome.
// No real process is spawned or killed: child_process is mocked throughout.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
  pid: number | undefined = 9999;
}

const hoisted = vi.hoisted(() => ({
  config: {
    resolvedPort: 8188,
    comfyuiPath: undefined as string | undefined,
    comfyuiRestartCommand: undefined as string | undefined,
  },
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  getSystemStats: vi.fn(),
  existsSync: vi.fn((_p: string) => false),
  findComfyuiPython: vi.fn(),
  resolveBase: vi.fn<[], string | undefined>(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "win32" as NodeJS.Platform };
});

vi.mock("../../config.js", () => ({
  config: hoisted.config,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  exec: hoisted.exec,
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
}));

vi.mock("node:fs", () => ({
  existsSync: hoisted.existsSync,
  lstatSync: vi.fn((p: string) => {
    if (!hoisted.existsSync(String(p))) throw new Error("ENOENT");
    return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
  }),
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("not in test"), { code: "ENOENT" });
  }),
  readdirSync: vi.fn(() => {
    throw Object.assign(new Error("not in test"), { code: "ENOENT" });
  }),
  statSync: vi.fn((p: string) => {
    if (!hoisted.existsSync(String(p))) throw new Error("ENOENT");
    return { isFile: () => true, isDirectory: () => false };
  }),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: hoisted.findComfyuiPython,
}));

vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: hoisted.resolveBase,
  liveRootFromArgv: vi.fn(() => undefined),
  resolveLiveServerRoot: vi.fn(() => ({ source: "unresolved" })),
  markLocalComfyUILaunched: vi.fn(),
  resetLocalComfyUILaunchState: vi.fn(),
}));

vi.mock("../../services/instance-witness.js", async () => ({
  ...(await vi.importActual("../../services/instance-witness.js")),
  acquireInstanceWitness: async () => undefined,
}));

import {
  __processControlTestHooks,
  preflightLocalRestart,
  restartComfyUI,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

const ROOT = "C:\\ComfyUI_windows_portable";
const PY = `${ROOT}\\python_embeded\\python.exe`;
const MAIN = `${ROOT}\\ComfyUI\\main.py`;
const SERVER_ARGV = [MAIN, "--port", "8188"];
const DESKTOP_SHELL = "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe";
const DESKTOP_MODELS = "C:\\Users\\u\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml";
const DESKTOP_ARGV = [
  MAIN,
  "--enable-manager",
  "--extra-model-paths-config",
  DESKTOP_MODELS,
  "--port",
  "8188",
];

const REFUSAL = /does not launch ComfyUI itself/i;
const ORIGINAL_ENV = { ...process.env };

/** A live listener (PID 4321) on 8188 until a kill is issued, then a free port. */
function livePortThenFree(pid = 4321): void {
  let killed = false;
  hoisted.execSync.mockImplementation((cmd: string) => {
    if (/taskkill|\bkill\b/i.test(cmd)) {
      killed = true;
      return "";
    }
    if (/netstat/i.test(cmd)) {
      return killed ? "" : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${pid}`;
    }
    return "";
  });
}

function killsIssued(): string[] {
  return hoisted.execSync.mock.calls
    .map((c) => String(c[0]))
    .filter((cmd) => /taskkill|\bkill\b/i.test(cmd));
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ system: { argv: SERVER_ARGV } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function rebootsSent(fetchSpy: ReturnType<typeof vi.fn>): string[] {
  return fetchSpy.mock.calls.map((c) => String(c[0])).filter((url) => /reboot/i.test(url));
}

/** An ordinary portable install whose relaunch command validates on disk. */
function pythonInstall(): void {
  hoisted.getSystemStats.mockResolvedValue({ system: { argv: SERVER_ARGV } });
  livePortThenFree();
  __processControlTestHooks.setProcessIdentityResolver((pid) =>
    pid === 4321
      ? {
          startedAt: "stable-stamp",
          executablePath: PY,
          commandLine: `"${PY}" ${SERVER_ARGV.join(" ")}`,
          argv: [PY, ...SERVER_ARGV],
          argvFidelity: "exact" as const,
        }
      : undefined,
  );
  __processControlTestHooks.setProcessExistsProbe(() => true);
}

/** A Desktop backend on 8188 whose parent is PID 300. */
function desktopServer(): void {
  hoisted.getSystemStats.mockResolvedValue({ system: { argv: DESKTOP_ARGV } });
  livePortThenFree();
  __processControlTestHooks.setParentPidResolver((pid) => (pid === 4321 ? 300 : undefined));
  __processControlTestHooks.setProcessExistsProbe(() => true);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  process.env.COMFYUI_PORT_FREE_TIMEOUT_S = "1";
  // Crash supervision ON, so a refusal cannot hide behind "auto-restart disabled".
  process.env.COMFYUI_ALWAYS_RESTART = "1";
  hoisted.config.comfyuiPath = undefined;
  hoisted.config.comfyuiRestartCommand = undefined;
  hoisted.execSync.mockImplementation(() => "");
  hoisted.spawn.mockImplementation(() => new FakeChild());
  hoisted.findComfyuiPython.mockReturnValue(PY);
  hoisted.resolveBase.mockReturnValue(`${ROOT}\\ComfyUI`);
  hoisted.existsSync.mockImplementation((p: string) => [PY, MAIN, DESKTOP_SHELL].includes(String(p)));
  __processControlTestHooks.reset();
  __processControlTestHooks.setRemoteRebootTimingForTests({ settleMs: 0, budgetMs: 40, intervalMs: 10 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

describe('restart_comfyui (action:"start") on Windows refuses every direct launch (#2947)', () => {
  it("does not spawn the Desktop launcher saved by a previous stop", async () => {
    __processControlTestHooks.setLastProcessInfo({
      pid: 4321,
      port: 8188,
      argv: DESKTOP_ARGV,
      isDesktopApp: true,
      desktopExePath: DESKTOP_SHELL,
    });

    const res = await startComfyUI();

    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(res.started).toBe(false);
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(REFUSAL);
    expect(res.message).toMatch(/Desktop app, its own launcher/i);
  });

  it("does not spawn a saved Python relaunch, and hands over what to run by hand", async () => {
    __processControlTestHooks.setLastProcessInfo({
      pid: 4321,
      port: 8188,
      argv: SERVER_ARGV,
      isDesktopApp: false,
    });

    const res = await startComfyUI();

    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(REFUSAL);
    expect(res.message).toContain(MAIN);
    expect(res.auto_restart?.supported).toBe(false);
  });

  it("does not spawn a #1847 self-relaunch record either", async () => {
    __processControlTestHooks.setLastProcessInfo({
      pid: 4321,
      port: 8188,
      argv: DESKTOP_ARGV,
      isDesktopApp: true,
      selfRelaunch: true,
      selfRelaunchParentPid: 300,
    });

    const res = await startComfyUI({ port: 8188, probeUrl: "http://127.0.0.1:8188/system_stats" });

    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(REFUSAL);
  });

  it("still reports an already-running server truthfully instead of refusing", async () => {
    livePortThenFree(5555);

    const res = await startComfyUI();

    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(/already running on port 8188 \(PID 5555\)/);
  });
});

describe('restart_comfyui (action:"restart") on Windows never stops what it cannot bring back (#2947)', () => {
  it("refuses the headless kill+relaunch BEFORE killing anything", async () => {
    pythonInstall();
    const fetchSpy = stubFetch();

    const res = await restartComfyUI();

    expect(killsIssued()).toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(rebootsSent(fetchSpy)).toEqual([]);
    expect(res.stopped).toBe(false);
    expect(res.started).toBe(false);
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(/^Refusing to restart:/);
    expect(res.message).toMatch(REFUSAL);
    expect(res.message).toMatch(/left running \(not stopped\)/i);
    expect(res.restart_hint?.server_argv).toEqual(SERVER_ARGV);
  });

  it("refuses an unsupervised Desktop self-relaunch BEFORE the Manager stop (#1847)", async () => {
    // Parent alive but unidentifiable, every launch file proven on disk: off
    // Windows this Manager-stops and then spawns the proven command itself.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321 ? { startedAt: "5000", parentPid: 300 } : undefined,
    );
    hoisted.existsSync.mockImplementation((p: string) =>
      [PY, MAIN, DESKTOP_MODELS].includes(String(p)),
    );
    const fetchSpy = stubFetch();

    const res = await restartComfyUI();

    expect(rebootsSent(fetchSpy)).toEqual([]);
    expect(killsIssued()).toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(res.stopped).toBe(false);
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(/exists but what it is running could not be read/i);
    expect(res.message).toMatch(REFUSAL);
    expect(res.message).toMatch(/left running \(not stopped\)/i);
  });

  it("the panel's read-only preflight refuses the same self-relaunch shape", async () => {
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321 ? { startedAt: "5000", parentPid: 300 } : undefined,
    );
    hoisted.existsSync.mockImplementation((p: string) =>
      [PY, MAIN, DESKTOP_MODELS].includes(String(p)),
    );
    const fetchSpy = stubFetch();

    const pre = await preflightLocalRestart();

    expect(pre.ok).toBe(false);
    expect(pre.selfRelaunch).toBeUndefined();
    expect(pre.reason).toMatch(REFUSAL);
    expect(rebootsSent(fetchSpy)).toEqual([]);
    expect(killsIssued()).toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });

  it("KEEPS the verified-supervisor Desktop restart: Manager reboot, no kill, no spawn", async () => {
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          commandLine: `"${DESKTOP_SHELL}"`,
          argv: [DESKTOP_SHELL],
          executablePath: DESKTOP_SHELL,
          startedAt: "2000",
        };
      }
      return undefined;
    });
    const fetchSpy = stubFetch();

    const pre = await preflightLocalRestart();
    const res = await restartComfyUI();

    expect(pre.ok).toBe(true);
    expect(rebootsSent(fetchSpy).length).toBeGreaterThan(0);
    expect(res.message).not.toMatch(/refusing to restart/i);
    expect(res.message).not.toMatch(REFUSAL);
    expect(killsIssued()).toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });

  it("KEEPS COMFYUI_RESTART_COMMAND: the user's command runs, nothing is spawned or killed here", async () => {
    hoisted.config.comfyuiRestartCommand = "sc.exe stop ComfyUI && sc.exe start ComfyUI";
    hoisted.exec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: (err: Error | null, out: unknown) => void) =>
        cb(null, { stdout: "", stderr: "" }),
    );
    stubFetch();

    const res = await restartComfyUI();

    expect(hoisted.exec).toHaveBeenCalledTimes(1);
    expect(String(hoisted.exec.mock.calls[0]?.[0])).toBe(
      "sc.exe stop ComfyUI && sc.exe start ComfyUI",
    );
    expect(res.stopped).toBe(true);
    expect(res.ready).toBe(true);
    expect(killsIssued()).toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });
});

describe('restart_comfyui (action:"stop") on Windows stays an explicit, truthful stop (#2948)', () => {
  it("stops, but says action:\"start\" cannot bring it back — in the fields and the sentence", async () => {
    pythonInstall();
    stubFetch();

    const res = await stopComfyUI();

    expect(res.stopped).toBe(true);
    expect(killsIssued().some((cmd) => /taskkill \/PID 4321 \/T \/F/.test(cmd))).toBe(true);
    expect(res.has_restart_info).toBe(false);
    expect(res.relaunch_blocked).toMatch(REFUSAL);
    expect(res.message).toMatch(/will NOT be able to bring this back/);
    expect(res.message).toMatch(REFUSAL);
    expect(res.restart_hint?.server_argv).toEqual(SERVER_ARGV);
    expect(res.message).toContain(MAIN);
    expect(res.auto_restart?.supported).toBe(false);
    expect(hoisted.spawn).not.toHaveBeenCalled();

    // …and the start that follows does exactly what the stop said it would.
    const start = await startComfyUI();
    expect(start.startup).toBe("not-attempted");
    expect(start.message).toMatch(REFUSAL);
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });

  it("finds the listener PID even on non-English Windows (#449, moved from process-control.test.ts)", async () => {
    // Realistic German netstat -ano blob: state column is 'ABHÖREN', not
    // 'LISTENING'. The mock emulates the actual shell pipeline — a chained
    // `findstr LISTENING` (the OLD detector) would filter every line out,
    // reproducing the false 'no process on port' failure. The current detector
    // parses `netstat -ano` directly and must still map the port to PID 6789.
    const GERMAN_BLOB = [
      "Aktive Verbindungen",
      "",
      "  Proto  Lokale Adresse     Remoteadresse      Status      PID",
      "  TCP    0.0.0.0:8188       0.0.0.0:0          ABHÖREN     6789",
      "  TCP    [::]:8188          [::]:0             ABHÖREN     6789",
      "  TCP    127.0.0.1:54210    127.0.0.1:8188     HERGESTELLT 4444",
    ].join("\n");
    let killed = false;
    hoisted.execSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (cmd.includes("netstat")) {
        if (killed) return ""; // port freed after kill → waitForPortFree resolves
        // Emulate the shell: a chained `findstr LISTENING` filters by that word.
        if (/findstr\s+LISTENING/i.test(cmd)) {
          return GERMAN_BLOB.split("\n")
            .filter((l) => l.includes("LISTENING"))
            .join("\n");
        }
        return GERMAN_BLOB;
      }
      return ""; // tasklist / powershell fallback / `if exist` → nothing
    });
    hoisted.getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 6789 ? { startedAt: "stable-stamp" } : undefined,
    );

    const result = await stopComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.message).toContain("6789");
    expect(killsIssued().some((cmd) => /taskkill/i.test(cmd))).toBe(true);
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });

  it("auto-restart reports itself unsupported for a Python install, and says why", () => {
    const out = __processControlTestHooks.supervisorResult({ isDesktopApp: false } as never);
    expect(out.enabled).toBe(true);
    expect(out.supported).toBe(false);
    expect(out.message).toMatch(REFUSAL);
  });
});
