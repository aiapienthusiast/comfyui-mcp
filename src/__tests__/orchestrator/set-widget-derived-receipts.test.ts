// #2918 / #2931 / #2933 — panel_set_widget returned applied:true for writes that
// never took effect:
//   - DenoLocalLLMRefiner `system_prompt`: the pack's setupNode() re-applies the
//     widget values it captured at load, so the next panel_query_graph showed the
//     old prompt (#2918).
//   - MiniMaxH3Easy `prompt`: the pack's prompt editor copies its own document back
//     over the widget on serialize / queue (#2933).
//   - Lora Loader (LoraManager) `text`: the write sticks and reads back equal, but
//     the backend ignores `text` and applies only the DOM-owned `loras` list (#2931).
//
// Drives the shipped panel_set_widget through makePanelToolCtx with the live
// protocol shapes (viewing.graph_identity, node_identity, expected_node_* fences).
// The mock panel applies a write on receive; a "frontend overwrite" is modelled as
// node code that runs on a later macrotask, exactly the window between the panel's
// in-envelope verification and the next command it serves.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import type { TabPromotedScopeRead, TabWorkflowUuidRead } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "wf:workflows/derived-receipts.json";
const WORKFLOW_UUID = "29330000-0000-4000-8000-000000000000";
const GRAPH_ID = "graph:root-2933";
const NODE_ID = 2;
const NODE_IDENTITY = "node:2:original";
const MUTATION_RID = "rid-set-widget-2933";
const OLD_PROMPT = "The girl in <Picture 1> is staying mostly still and periodically blinks.";
const NEW_PROMPT = "The girl in <Picture 1> is standing still and breathing deeply and slowly.";

type Sent = { cmd: string; payload: Record<string, unknown> };

type Harness = {
  nodeType?: string;
  widgets?: Record<string, unknown>;
  /** Node code that runs on a later macrotask after a write lands. */
  overwriteAfterWrite?: (live: Record<string, unknown>) => void;
  /** Override what the post-write graph read reports. */
  readback?: {
    graphIdentity?: string;
    nodeIdentity?: string;
    value?: unknown;
    error?: boolean;
    duplicate?: boolean;
    reconnectDuring?: boolean;
  };
  /** Omit the receiver's per-object node incarnation (older panel). */
  noNodeIdentity?: boolean;
  /** A forwarding-only context with no capability API (no ordinary plan). */
  legacy?: boolean;
  setReplyExtras?: Record<string, unknown>;
};

let sent: Sent[] = [];
let dispatchedWrites = 0;

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");

const cmds = (): string[] => sent.map((s) => s.cmd);

function makeBridge(h: Harness): PanelToolCtx["bridge"] {
  const live: Record<string, unknown> = { ...(h.widgets ?? { text: OLD_PROMPT }) };
  const nodeType = h.nodeType ?? "CLIPTextEncode";
  let wrote = false;
  let generation = 1;
  const viewing = (graphIdentity = GRAPH_ID) => ({
    scope: "root",
    kind: "root",
    workflow: "derived-receipts.json",
    workflow_uuid: WORKFLOW_UUID,
    graph_identity: graphIdentity,
  });
  const row = (widgets: Record<string, unknown>, nodeIdentity = NODE_IDENTITY) => ({
    id: NODE_ID,
    type: nodeType,
    is_subgraph: false,
    ...(h.noNodeIdentity ? {} : { node_identity: nodeIdentity }),
    widgets,
    inputs: [],
  });

  const shape = {
    send: async (
      cmd: Record<string, unknown>,
      o?: { beforeDispatch?: () => void; onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push({ cmd: String(cmd.cmd), payload: cmd });
      if (cmd.cmd === "graph_set_widget") {
        o?.beforeDispatch?.();
        o?.onDispatchedRid?.(MUTATION_RID);
        dispatchedWrites += 1;
        const widget = String(cmd.widget);
        const previous = live[widget];
        live[widget] = cmd.value;
        wrote = true;
        if (h.overwriteAfterWrite) setTimeout(() => h.overwriteAfterWrite!(live), 0);
        return {
          set: { node_id: cmd.node_id, widget, previous, value: cmd.value },
          ...(h.setReplyExtras ?? {}),
        };
      }
      if (cmd.cmd === "graph_query") {
        if (wrote && h.readback) {
          // Let node code scheduled by the write run first, as it would on the page.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (h.readback.reconnectDuring) generation = 2;
          if (h.readback.error) throw new Error("graph_query failed: tab busy");
          const widgets = {
            ...live,
            ...("value" in h.readback ? { [Object.keys(live)[0]!]: h.readback.value } : {}),
          };
          return {
            viewing: viewing(h.readback.graphIdentity),
            truncated: false,
            nodes: [
              {
                ...row(widgets, h.readback.nodeIdentity),
                ...(h.readback.duplicate
                  ? { duplicate_widgets: { [Object.keys(live)[0]!]: [{ index: 0 }, { index: 1 }] } }
                  : {}),
              },
            ],
            node_count: 1,
          };
        }
        if (wrote) await new Promise((resolve) => setTimeout(resolve, 5));
        return { viewing: viewing(), truncated: false, nodes: [row({ ...live })], node_count: 1 };
      }
      if (cmd.cmd === "graph_get_subgraph") {
        throw new Error(`Node ${NODE_ID} (${nodeType}) is not a subgraph`);
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "derived-receipts", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: (): TabWorkflowUuidRead => ({ known: true, uuid: WORKFLOW_UUID }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => ({ generation, tabSessionId: "browser-tab-2933" }),
    promotedScopeFor: (): TabPromotedScopeRead => ({
      known: true,
      scope: "root",
      ownerNodeId: null,
      workflowUuid: WORKFLOW_UUID,
      graphIdentity: GRAPH_ID,
    }),
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
  } as Partial<PanelToolCtx["bridge"]>;
  if (h.legacy) {
    delete shape.tabPromotedTerminalWitnessCapability;
  }
  return shape as PanelToolCtx["bridge"];
}

async function setWidget(h: Harness, args: Record<string, unknown>) {
  const ctx = makePanelToolCtx(makeBridge(h), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  const text = textOf(res);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { res, text, json, isError: res.isError === true };
}

beforeEach(() => {
  sent = [];
  dispatchedWrites = 0;
});

describe("known frontend-owned widgets are refused before dispatch (#2931, #2933)", () => {
  it.each([
    "Lora Loader (LoraManager)",
    "Lora Stacker (LoraManager)",
    "WanVideo Lora Select (LoraManager)",
    "Create Hook LoRA (LoraManager)",
  ])("refuses `text` on %s even though it would read back equal", async (nodeType) => {
    const out = await setWidget(
      { nodeType, widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "text", value: "<lora:VIA_Breast_Anima:0.8>" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "text" on ${nodeType}`);
    expect(out.text).toMatch(/applies only the DOM-backed "loras" list/);
    expect(out.text).toMatch(/No graph_set_widget was dispatched/);
    expect(out.text).toMatch(/Do not retry panel_set_widget on this widget/);
    expect(cmds()).not.toContain("graph_set_widget");
    expect(dispatchedWrites).toBe(0);
  });

  it("names the pack's text-driven loader and a backend STRING producer for Lora Loader", async () => {
    const out = await setWidget(
      { nodeType: "Lora Loader (LoraManager)", widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "loras", value: "[]" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "loras" on Lora Loader (LoraManager)`);
    expect(out.text).toContain(`Use "LoRA Text Loader (LoraManager)" instead`);
    expect(out.text).toMatch(/PrimitiveStringMultiline, set its STRING widget, then panel_connect that STRING output to "lora_syntax"/);
    expect(dispatchedWrites).toBe(0);
  });

  it("names the WanVideo text variant for WanVideo Lora Select", async () => {
    const out = await setWidget(
      { nodeType: "WanVideo Lora Select (LoraManager)", widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "text", value: "<lora:a:1>" },
    );

    expect(out.text).toContain(`"WanVideo Lora Select From Text (LoraManager)"`);
    expect(dispatchedWrites).toBe(0);
  });

  it.each([
    ["MiniMaxH3Easy", "prompt"],
    ["MiniMaxH3Easy", "h3_prompt_mentions"],
    ["MiniMaxH3EasyContextSegments", "prompt"],
    ["MiniMaxH3EasySelectedVideoContext", "prompt"],
  ])("refuses %s.%s with the link remedy", async (nodeType, widget) => {
    const out = await setWidget(
      { nodeType, widgets: { prompt: OLD_PROMPT, h3_prompt_mentions: OLD_PROMPT } },
      { node_id: NODE_ID, widget, value: NEW_PROMPT },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "${widget}" on ${nodeType}`);
    expect(out.text).toMatch(/panel_connect that STRING output to "prompt"/);
    expect(out.text).not.toMatch(/PrimitiveNode\b/);
    expect(dispatchedWrites).toBe(0);
  });

  it.each([
    ["CLIPTextEncode", "text"],
    ["PrimitiveStringMultiline", "value"],
    ["MiniMaxH3Easy", "seed"],
    ["Lora Loader (LoraManager)", "strength_model"],
    ["SomeOtherNode", "prompt"],
  ])("keeps the plain setter path for %s.%s", async (nodeType, widget) => {
    const out = await setWidget(
      { nodeType, widgets: { [widget]: "old" } },
      { node_id: NODE_ID, widget, value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.set).toMatchObject({ node_id: NODE_ID, widget, value: "new" });
    expect(dispatchedWrites).toBe(1);
  });

  it("fences the refusal on the PROVEN type: no extra probe on the ordinary path", async () => {
    await setWidget(
      { nodeType: "MiniMaxH3Easy", widgets: { prompt: OLD_PROMPT } },
      { node_id: NODE_ID, widget: "prompt", value: NEW_PROMPT },
    );
    // One preflight scope read; the refusal reuses its type.
    expect(cmds()).toEqual(["graph_query"]);
  });

  it("probes an untyped (legacy) write only for the pack-specific names", async () => {
    const loras = await setWidget(
      { legacy: true, nodeType: "Lora Loader (LoraManager)", widgets: { loras: [] } },
      { node_id: NODE_ID, widget: "loras", value: "[]" },
    );
    expect(loras.isError).toBe(true);
    expect(loras.text).toContain(`cannot set "loras" on Lora Loader (LoraManager)`);
    expect(dispatchedWrites).toBe(0);

    sent = [];
    // Documented limit: an untyped `text` write keeps its one hop rather than
    // probing every CLIPTextEncode write on a context that proves no type.
    const text = await setWidget(
      { legacy: true, nodeType: "Lora Loader (LoraManager)", widgets: { text: "" } },
      { node_id: NODE_ID, widget: "text", value: "<lora:a:1>" },
    );
    expect(text.isError).toBe(false);
    expect(cmds().filter((c) => c === "graph_set_widget")).toHaveLength(1);
  });
});

describe("one fenced read after an acknowledged string write (#2918, #2933)", () => {
  it("#2918: reports applied:false when node code puts the previous value back, without replaying", async () => {
    const out = await setWidget(
      {
        nodeType: "DenoLocalLLMRefiner",
        widgets: { system_prompt: "OLD planner prompt" },
        // setupNode() re-applies the values captured at load.
        overwriteAfterWrite: (live) => {
          live.system_prompt = "OLD planner prompt";
        },
      },
      { node_id: NODE_ID, widget: "system_prompt", value: "NEW planner prompt" },
    );

    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({
      applied: false,
      overwritten: true,
      acknowledged: true,
      mutation_id: MUTATION_RID,
      requested: { node_id: NODE_ID, widget: "system_prompt", value: "NEW planner prompt" },
      previous: "OLD planner prompt",
      observed: "OLD planner prompt",
      confirmed_by: "graph read after write",
    });
    expect(String(out.json?.note)).toMatch(/PREVIOUS value again/);
    expect(String(out.json?.note)).toMatch(/Re-issuing the same write will not change that/);
    expect(String(out.json?.note)).toMatch(/PrimitiveStringMultiline/);
    expect(cmds()).toEqual(["graph_query", "graph_set_widget", "graph_query"]);
    expect(dispatchedWrites).toBe(1);
    expect(sent[2]?.payload).toMatchObject({
      cmd: "graph_query",
      ids: [NODE_ID],
      fields: "detail",
      limit: 1,
    });
  });

  it("names a DIFFERENT observed value as such", async () => {
    const out = await setWidget(
      {
        widgets: { text: "old" },
        overwriteAfterWrite: (live) => {
          live.text = "something else entirely";
        },
      },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ applied: false, observed: "something else entirely" });
    expect(String(out.json?.note)).toMatch(/a DIFFERENT value than this call wrote/);
  });

  it("marks a write the read shows held as matched, and says what that does not prove", async () => {
    const out = await setWidget(
      { widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      set: { node_id: NODE_ID, widget: "text", previous: "old", value: "new" },
      post_write_readback: { status: "matched" },
    });
    expect(String((out.json?.post_write_readback as Record<string, unknown>).note)).toMatch(
      /cannot see a later overwrite/,
    );
    expect(cmds()).toEqual(["graph_query", "graph_set_widget", "graph_query"]);
  });

  it("does not wait for, or claim to see, an overwrite that lands after the read", async () => {
    const out = await setWidget(
      {
        widgets: { text: "old" },
        overwriteAfterWrite: (live) => {
          setTimeout(() => {
            live.text = "old";
          }, 50);
        },
      },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect((out.json?.post_write_readback as Record<string, unknown>).status).toBe("matched");
  });

  it.each([
    ["the graph read fails", { error: true }, /graph read failed/],
    ["the graph view changed", { graphIdentity: "graph:other" }, /same graph view/],
    ["the node id is a new incarnation", { nodeIdentity: "node:2:replacement" }, /different node incarnation/],
    ["the connection changed during the read", { reconnectDuring: true }, /connection changed during the read-back/],
    ["several widgets share the name", { duplicate: true }, /several widgets on the node are named/],
  ] as const)("keeps the success but marks it unverified when %s", async (_label, readback, reason) => {
    const out = await setWidget(
      { widgets: { text: "old" }, readback: { ...readback, value: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.set).toMatchObject({ value: "new" });
    const readbackField = out.json?.post_write_readback as Record<string, unknown>;
    expect(readbackField.status).toBe("unverified");
    expect(String(readbackField.reason)).toMatch(reason);
    expect(dispatchedWrites).toBe(1);
  });

  it("does not read back when the panel published no node incarnation", async () => {
    const out = await setWidget(
      { widgets: { text: "old" }, noNodeIdentity: true },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.post_write_readback).toMatchObject({ status: "unverified" });
    expect(cmds().filter((c) => c === "graph_query")).toHaveLength(1);
  });

  it("treats a value clipped by the panel's cap as unverified, not as a revert", async () => {
    const long = `clip-${"x".repeat(2200)}`;
    const out = await setWidget(
      {
        widgets: { text: "old" },
        readback: {
          value:
            "clip-" +
            "x".repeat(100) +
            "…(+2100 chars cut at the 2048-char per-widget cap, which `max_chars` does not raise)",
        },
      },
      { node_id: NODE_ID, widget: "text", value: long },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.post_write_readback).toMatchObject({ status: "unverified" });
    // The long value asks the pinpoint read for the full widget.
    expect(sent[2]?.payload.widget_max_chars).toBeGreaterThanOrEqual(long.length);
  });

  it("summarizes long values in an overwrite verdict unless echo:full", async () => {
    const long = `prompt-${"y".repeat(1500)}`;
    const harness: Harness = {
      widgets: { text: OLD_PROMPT },
      overwriteAfterWrite: (live) => {
        live.text = OLD_PROMPT;
      },
    };
    const summary = await setWidget(harness, { node_id: NODE_ID, widget: "text", value: long });
    expect(summary.json?.requested).toMatchObject({ value: { chars: long.length } });

    sent = [];
    const full = await setWidget(harness, {
      node_id: NODE_ID,
      widget: "text",
      value: long,
      echo: "full",
    });
    expect(full.json?.requested).toMatchObject({ value: long });
  });

  it("does not read back numeric, deferred, or refresh-pending writes", async () => {
    await setWidget({ widgets: { steps: 20 } }, { node_id: NODE_ID, widget: "steps", value: 30 });
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);

    sent = [];
    await setWidget(
      { widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new", defer_until_idle: true, expected_value: "old" },
    );
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);

    sent = [];
    await setWidget(
      { widgets: { text: "old" }, setReplyExtras: { refresh_pending: true } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);
  });
});
