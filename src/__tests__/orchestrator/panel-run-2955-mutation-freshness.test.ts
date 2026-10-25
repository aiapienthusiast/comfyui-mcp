// #2955 — panel_run captured the PREVIOUS prompt/filename right after two
// panel_set_widget calls that both reported success. History showed the old
// SaveImage prefix; nothing errored.
//
// Root cause, in this repository's seam: the per-tab graph lane releases a
// targeted mutation (and graph_run) as soon as its frame is written (#2559),
// and the frontend's graph_set_widget awaits /object_info work before it
// applies the value. A graph_run that reaches the panel while an earlier write
// is still unacknowledged — or while that write's handler is still in its
// orchestrator-side preflight and has not sent the frame at all — serializes
// the old value. The write then acks `set` and panel_run reports queued.
//
// The panel below models exactly that: graph_set_widget applies only when the
// test releases it, and graph_run snapshots the widget values at the moment
// its frame ARRIVES. Every case drives the shipped tool defs against a real
// UiBridge; no live canvas is involved.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import {
  __panelToolsTestHooks,
  buildPanelToolDefs,
  makePanelToolCtx,
  RETRY_TOKEN_CMDS,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const TAB = "wf:workflows/chizu_scout.json";
const WORKFLOW_UUID = "22222222-2222-4222-8222-222222222222";
const PROMPT_NODE = 6;
const SAVE_NODE = 9;
const OLD = { text: "scout 03 full body", filename_prefix: "Chizu_V02_Scout_03_FullBody_NoRating" };
const NEW = { text: "scout 04 full body safe", filename_prefix: "Chizu_V02_Scout_04_FullBody_Safe" };

let bridge: UiBridge;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

async function startBridge(): Promise<void> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) {
      bridge.setTabWorkflowUuidResolver(() => WORKFLOW_UUID);
      // Production installs this in orchestrator/index.ts; it is what makes a
      // delivered mutation visible to the bridge at all.
      bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
      return;
    }
    lastErr = `bind to ${port} lost a close→rebind race`;
    await bridge.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function connectPanel(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: TAB,
          title: "chizu_scout",
          tab_session_id: "browser-tab-2955",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          enforces_expected_node_type_at_write: true,
          enforces_expected_node_identity_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function viewing() {
  return {
    scope: "root",
    kind: "root",
    workflow: "chizu_scout.json",
    workflow_uuid: WORKFLOW_UUID,
    graph_identity: "graph:root-2955",
  };
}

type Widgets = { text: string; filename_prefix: string };
type HeldWrite = { msg: Record<string, unknown>; release: (opts?: { ok?: boolean }) => void };

type ScriptedPanel = {
  readonly values: Widgets;
  /** One entry per graph_run frame that reached the panel: what it serialized. */
  readonly runs: Array<{ rid: string; serialized: Widgets }>;
  readonly writes: HeldWrite[];
  /** Resolves once `n` graph_set_widget frames have reached the panel. */
  writesArrived(n: number): Promise<void>;
  /** Resolves when the first graph_run frame reaches the panel. */
  runArrived(): Promise<void>;
};

function nodeRow(id: unknown, values: Widgets) {
  const isSave = String(id) === String(SAVE_NODE);
  return {
    id: isSave ? SAVE_NODE : PROMPT_NODE,
    type: isSave ? "SaveImage" : "CLIPTextEncode",
    is_subgraph: false,
    node_identity: `node:${isSave ? SAVE_NODE : PROMPT_NODE}`,
    widgets: isSave ? { filename_prefix: values.filename_prefix } : { text: values.text },
  };
}

/**
 * graph_set_widget is HELD until the test releases it (the frontend's
 * /object_info await before applyWidgetWrite), then applied and acked.
 * graph_run serializes the values present when its frame arrives.
 */
function attachPanel(sock: WebSocket): ScriptedPanel {
  const values: Widgets = { ...OLD };
  const runs: Array<{ rid: string; serialized: Widgets }> = [];
  const writes: HeldWrite[] = [];
  const arrivalWaiters: Array<{ n: number; resolve: () => void }> = [];
  const runWaiters: Array<() => void> = [];
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
    if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
    const rid = msg.rid;
    if (msg.cmd === "graph_set_widget") {
      let done = false;
      writes.push({
        msg,
        release: (opts) => {
          if (done) return;
          done = true;
          if (opts?.ok === false) {
            sock.send(JSON.stringify({ rid, ok: false, error: "widget write refused by the panel" }));
            return;
          }
          const widget = msg.widget as keyof Widgets;
          const previous = values[widget];
          values[widget] = String(msg.value);
          sock.send(
            JSON.stringify({
              rid,
              ok: true,
              result: { set: { node_id: msg.node_id, widget, previous, value: msg.value } },
            }),
          );
        },
      });
      for (const w of arrivalWaiters.splice(0)) {
        if (writes.length >= w.n) w.resolve();
        else arrivalWaiters.push(w);
      }
      return;
    }
    if (msg.cmd === "graph_run") {
      runs.push({ rid, serialized: { ...values } });
      for (const resolve of runWaiters.splice(0)) resolve();
      sock.send(
        JSON.stringify({ rid, ok: true, result: { queued: true, prompt_id: `p-2955-${runs.length}` } }),
      );
      return;
    }
    const ids = Array.isArray(msg.ids) ? msg.ids : [msg.node_id ?? PROMPT_NODE];
    const result =
      msg.cmd === "graph_query" || msg.cmd === "graph_get_subgraph"
        ? { viewing: viewing(), truncated: false, nodes: ids.map((id) => nodeRow(id, values)), node_count: ids.length }
        : { ok: true };
    sock.send(JSON.stringify({ rid, ok: true, result }));
  });
  return {
    get values() {
      return values;
    },
    runs,
    writes,
    writesArrived(n: number) {
      if (writes.length >= n) return Promise.resolve();
      return new Promise((resolve) => arrivalWaiters.push({ n, resolve }));
    },
    runArrived() {
      if (runs.length > 0) return Promise.resolve();
      return new Promise((resolve) => runWaiters.push(resolve));
    },
  };
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function newCtx(): PanelToolCtx {
  return makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
}

async function connected(): Promise<ScriptedPanel> {
  const sock = await connectPanel();
  const panel = attachPanel(sock);
  await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
  return panel;
}

function setWidget(ctx: PanelToolCtx, nodeId: number, widget: keyof Widgets, value: string) {
  return defByName("panel_set_widget").handler({ node_id: nodeId, widget, value } as never, ctx);
}

function panelRun(ctx: PanelToolCtx, args: Record<string, unknown> = {}) {
  return defByName("panel_run").handler(args as never, ctx);
}

type BarrierSnapshot = { intents: number; awaited: number; timedOut: number };

/** Every barrier wait panel_run enters from now on, in order. */
function observeBarrier(): { calls: BarrierSnapshot[]; next: () => Promise<BarrierSnapshot> } {
  const calls: BarrierSnapshot[] = [];
  const waiters: Array<(s: BarrierSnapshot) => void> = [];
  __panelToolsTestHooks.setRunFreshnessWaitObserver((snapshot) => {
    calls.push(snapshot);
    waiters.shift()?.(snapshot);
  });
  return {
    calls,
    next: () => {
      const seen = calls[calls.length - 1];
      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * Which happened first: panel_run entering its freshness wait, or its graph_run
 * frame reaching the panel. Ordered against the barrier itself, never a clock:
 * a run that skipped the wait shows up here as "run".
 */
async function firstOf(
  barrier: { next: () => Promise<BarrierSnapshot> },
  panel: ScriptedPanel,
): Promise<{ kind: "barrier"; snapshot: BarrierSnapshot } | { kind: "run" }> {
  return Promise.race([
    barrier.next().then((snapshot) => ({ kind: "barrier" as const, snapshot })),
    panel.runArrived().then(() => ({ kind: "run" as const })),
  ]);
}

/** True once `p` has settled, without awaiting it. */
function tracked<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const promise = p.finally(() => {
    done = true;
  });
  return { promise, settled: () => done };
}

beforeEach(async () => {
  RunCompletions.reset();
  __panelToolsTestHooks.setRetrySettleMs(0);
  await startBridge();
});

afterEach(async () => {
  __panelToolsTestHooks.setRunFreshnessBarrierMs(null);
  __panelToolsTestHooks.setRunFreshnessWaitObserver(null);
  __panelToolsTestHooks.setOutstandingMutationReadSettleMs(null);
  __panelToolsTestHooks.setRetrySettleMs(null);
  RunCompletions.reset();
  await bridge.stop();
});

describe("panel_run observes earlier acknowledged mutations before serialization (#2955)", () => {
  it("reproduction: set prompt + set filename + run issued together serializes the NEW values", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const barrier = observeBarrier();
    const text = setWidget(ctx, PROMPT_NODE, "text", NEW.text);
    const prefix = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const run = tracked(panelRun(ctx));

    const first = await firstOf(barrier, panel);
    expect(first.kind, "graph_run reached the serializer before the earlier writes").toBe("barrier");
    expect(first.kind === "barrier" && first.snapshot.intents).toBe(2);
    await panel.writesArrived(2);
    // Both write frames are on the panel and unacknowledged: the run must not
    // have reached the serializer yet.
    expect(panel.runs).toHaveLength(0);
    for (const w of panel.writes) w.release();

    const [textRes, prefixRes, runRes] = await Promise.all([text, prefix, run.promise]);
    expect(textRes.isError, textOf(textRes)).not.toBe(true);
    expect(prefixRes.isError, textOf(prefixRes)).not.toBe(true);
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual(NEW);
    expect(RunCompletions.ticketFor("p-2955-1")).toBeDefined();
  });

  it("waits for a write still in its orchestrator-side preflight (frame not yet sent)", async () => {
    const panel = await connected();
    const ctx = newCtx();

    // Same tick: the write's preflight reads have not even been answered yet.
    const barrier = observeBarrier();
    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const run = tracked(panelRun(ctx));

    const first = await firstOf(barrier, panel);
    expect(first.kind, "graph_run overtook a write still in its preflight").toBe("barrier");
    // No frame is on the wire yet — only the call registry can see this write.
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 1, awaited: 0, timedOut: 0 });
    await panel.writesArrived(1);
    expect(panel.runs, "graph_run overtook a write the caller issued first").toHaveLength(0);
    expect(run.settled()).toBe(false);
    panel.writes[0]?.release();

    const [writeRes, runRes] = await Promise.all([write, run.promise]);
    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it("waits for a frame another session delivered to the same tab (bridge-level receipt)", async () => {
    const panel = await connected();
    // A second conversation on the same canvas writes through the bridge
    // directly; this session's tool registry knows nothing about it.
    const foreign = bridge.send(
      { cmd: "graph_set_widget", node_id: PROMPT_NODE, widget: "text", value: NEW.text },
      { tabId: TAB, timeoutMs: 5000 },
    );
    await panel.writesArrived(1);
    expect(bridge.listAwaitedMutations(TAB)).toHaveLength(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(newCtx()));
    const first = await firstOf(barrier, panel);
    expect(first.kind, "graph_run overtook another session's unacknowledged write").toBe("barrier");
    // This session has no call of its own in flight — only the bridge receipt.
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 0, awaited: 1, timedOut: 0 });
    expect(panel.runs).toHaveLength(0);
    panel.writes[0]?.release();

    await foreign;
    const runRes = await run.promise;
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.text).toBe(NEW.text);
  });

  it("refuses BEFORE dispatch when an earlier write stays unacknowledged, then a re-run queues exactly once", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const refused = await panelRun(ctx);
    const text = textOf(refused);

    expect(refused.isError).toBe(true);
    expect(panel.runs, "a refused run must never reach the panel").toHaveLength(0);
    expect(text).toMatch(/panel_run was NOT dispatched/);
    expect(text).toMatch(/nothing was queued/i);
    expect(text).toContain("panel_set_widget");
    expect(text).toMatch(/do NOT pass retry_of/);
    expect(text).not.toMatch(/retry_of:"/);
    expect(RunCompletions.ticketFor("p-2955-1")).toBeUndefined();

    panel.writes[0]?.release();
    const writeRes = await write;
    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);

    const rerun = await panelRun(ctx);
    expect(rerun.isError, textOf(rerun)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it("does NOT wait for writes issued after the run started (no absorbing the next cell)", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const cell04 = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    const first = await firstOf(barrier, panel);
    expect(first.kind).toBe("barrier");
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 1, awaited: 1, timedOut: 0 });
    // The next cell's write starts while the run is waiting on cell 04.
    const cell05 = setWidget(ctx, PROMPT_NODE, "text", "scout 05 portrait");
    await panel.writesArrived(2);

    panel.writes[0]?.release();
    const runRes = await run.promise;
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual({ ...OLD, filename_prefix: NEW.filename_prefix });
    // The later write is still unacknowledged: the run did not wait for it.
    expect(panel.values.text).toBe(OLD.text);

    panel.writes[1]?.release();
    expect((await cell04).isError).not.toBe(true);
    expect((await cell05).isError).not.toBe(true);
  });

  it("refuses without rebinding when the session's target switches while waiting", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");
    ctx.tabId = "wf:workflows/another_canvas.json";
    panel.writes[0]?.release();

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(res)).toMatch(/target changed/i);
    expect(textOf(res)).toContain(TAB);
    expect(textOf(res)).toContain("wf:workflows/another_canvas.json");
    expect(ctx.tabId, "the barrier must never rebind the session").toBe("wf:workflows/another_canvas.json");
    expect(panel.runs).toHaveLength(0);
    await write;
  });

  it("a write the panel REFUSED settles the barrier; the run proceeds once with the unchanged graph", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");
    panel.writes[0]?.release({ ok: false });

    const writeRes = await write;
    expect(writeRes.isError).toBe(true);
    const runRes = await run.promise;
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual(OLD);
  });

  it("an earlier TIMED-OUT write: waits for its late settle, else queues with an OUTCOME UNKNOWN disclosure", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(60);
    const panel = await connected();

    const timedOut = await bridge
      .send(
        { cmd: "graph_set_widget", node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix },
        { tabId: TAB, timeoutMs: 40 },
      )
      .then(
        () => "acked",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    expect(timedOut).toMatch(/did not reply to "graph_set_widget"/);
    expect(bridge.listOutstandingMutations(TAB)).toHaveLength(1);
    const rid = bridge.listOutstandingMutations(TAB)[0]?.rid;
    expect(bridge.listAwaitedMutations(TAB), "a timed-out write is no longer awaited").toHaveLength(0);
    const barrier = observeBarrier();

    const res = await panelRun(newCtx());
    expect(barrier.calls).toEqual([{ intents: 0, awaited: 0, timedOut: 1 }]);
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual(OLD);
    expect(textOf(res)).toMatch(/OUTCOME UNKNOWN/);
    expect(textOf(res)).toContain(`retry_of:"${rid}"`);
    expect(textOf(res)).toMatch(/may not include/);

    // The late apply lands; the next run sees it and carries no disclosure.
    panel.writes[0]?.release();
    await waitFor(() => expect(bridge.listOutstandingMutations(TAB)).toHaveLength(0));
    const next = await panelRun(newCtx());
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(2);
    expect(panel.runs[1]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
    expect(textOf(next)).not.toMatch(/OUTCOME UNKNOWN/);
  });

  it("concurrent runs do not wait on each other's graph_run acknowledgement", async () => {
    const sock = await connectPanel();
    const runFrames: string[] = [];
    let firstRid: string | undefined;
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
      if (msg.cmd !== "graph_run") {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { ok: true } }));
        return;
      }
      runFrames.push(msg.rid);
      // Hold the FIRST run's ack; answer the second at once.
      if (!firstRid) {
        firstRid = msg.rid;
        return;
      }
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { queued: true, prompt_id: "p-second" } }));
    });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const ctx = newCtx();
    const barrier = observeBarrier();

    const first = tracked(panelRun(ctx));
    await waitFor(() => expect(runFrames).toHaveLength(1));
    const second = await panelRun(ctx, { allow_duplicate: true });
    expect(second.isError, textOf(second)).not.toBe(true);
    expect(runFrames).toHaveLength(2);
    expect(first.settled()).toBe(false);
    expect(barrier.calls, "an in-flight graph_run must not hold the next run").toEqual([]);

    sock.send(JSON.stringify({ rid: firstRid, ok: true, result: { queued: true, prompt_id: "p-first" } }));
    expect((await first.promise).isError).not.toBe(true);
  });

  it("a sequential write-then-run has nothing outstanding and carries no freshness note", async () => {
    const panel = await connected();
    const ctx = newCtx();
    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    panel.writes[0]?.release();
    expect((await write).isError).not.toBe(true);
    expect(bridge.listAwaitedMutations(TAB)).toHaveLength(0);
    const barrier = observeBarrier();

    const res = await panelRun(ctx);
    expect(barrier.calls, "nothing outstanding: no wait at all").toEqual([]);
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
    expect(textOf(res)).not.toMatch(/OUTCOME UNKNOWN|NOT dispatched/);
  });
});
