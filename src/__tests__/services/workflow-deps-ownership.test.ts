import { describe, expect, it, vi } from "vitest";
import {
  extractWorkflowDependencies,
  installWorkflowDependencies,
  type NodeDependency,
  type WorkflowDepsDeps,
} from "../../services/workflow-deps.js";
import type { ComfyUINodeDef, ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";

/**
 * #2765 — extract_deps named DemonGatanjieu/Anomalous_Model_Browser as the owner of
 * `Power Lora Loader (rgthree)`, `Switch latent [Crystools]`, `Krea2EditGroundedEncode`
 * and `Krea2EditModelPatch`: three real packs collapsed onto one unrelated repository.
 *
 * Every catalogue entry below is copied verbatim (trimmed lists only) from
 * Comfy-Org/ComfyUI-Manager `extension-node-map.json`. Two snapshots matter:
 *
 *  - ISSUE-ERA: Anomalous_Model_Browser published `nodename_pattern: ".*"` and listed no
 *    class at all (quoted on the issue), so it matched every name the catalogue did not
 *    list exactly — and first-pattern-wins handed it all four.
 *  - CURRENT (fetched 2026-10-24): the `.*` is gone, but the same repository now EXACTLY
 *    lists `Power Lora Loader (rgthree)` (alongside core `KSampler` and other packs'
 *    nodes), while `lbouaraba/comfyui-krea2edit` lists both Krea2 nodes.
 *
 * Hermetic: no network, no ComfyUI. `/object_info` and the Manager mappings are fixtures.
 */

const ANOMALOUS = "https://github.com/DemonGatanjieu/Anomalous_Model_Browser";
const RGTHREE = "https://github.com/rgthree/rgthree-comfy";
const CRYSTOOLS = "https://github.com/crystian/ComfyUI-Crystools";
const KREA2EDIT = "https://github.com/lbouaraba/comfyui-krea2edit";

type Mappings = Record<string, [string[], Record<string, unknown>]>;

const RGTHREE_ENTRY: [string[], Record<string, unknown>] = [
  ["RgthreeAnySwitch", "RgthreePowerLoraLoader", "RgthreeSeed"],
  {
    author: "rgthree",
    nickname: "rgthree",
    nodename_pattern: " \\(rgthree\\)$",
    title: "Comfy Nodes",
    title_aux: "rgthree's ComfyUI Nodes",
  },
];
const CRYSTOOLS_ENTRY: [string[], Record<string, unknown>] = [
  [],
  {
    author: "Crystian",
    nickname: "Crystools",
    nodename_pattern: " \\[Crystools\\]$",
    title: "Crystools",
    title_aux: "Crystools",
  },
];

/** Key order follows the real file (sorted), which puts the catch-all FIRST. */
const ISSUE_ERA: Mappings = {
  [ANOMALOUS]: [[], { nodename_pattern: ".*", title_aux: "Anomalous Model Browser" }],
  [CRYSTOOLS]: CRYSTOOLS_ENTRY,
  [RGTHREE]: RGTHREE_ENTRY,
};

const CURRENT: Mappings = {
  [ANOMALOUS]: [
    ["AnomalousTTS_CharacterSpeech", "DetailerForEach", "Power Lora Loader (rgthree)", "easy seed"],
    { title_aux: "Anomalous Model Browser" },
  ],
  [CRYSTOOLS]: CRYSTOOLS_ENTRY,
  [KREA2EDIT]: [["Krea2EditGroundedEncode", "Krea2EditModelPatch"], { title_aux: "Krea 2 Identity Edit" }],
  [RGTHREE]: RGTHREE_ENTRY,
};

const REPORTED = [
  "Krea2EditGroundedEncode",
  "Krea2EditModelPatch",
  "Power Lora Loader (rgthree)",
  "Switch latent [Crystools]",
];

function def(name: string, pythonModule?: string): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name,
    display_name: name,
    description: "",
    category: "",
    output_node: false,
    ...(pythonModule === undefined ? {} : { python_module: pythonModule }),
  };
}

function wf(...classTypes: string[]): WorkflowJSON {
  return Object.fromEntries(classTypes.map((c, i) => [String(i + 1), { class_type: c, inputs: {} }]));
}

function deps(mappings: Mappings, objectInfo: ObjectInfo = {}): WorkflowDepsDeps {
  return {
    fetchObjectInfo: vi.fn(async () => objectInfo),
    fetchManagerMappings: vi.fn(async () => mappings as never),
    fetchManagerList: vi.fn(async () => ({ packs: [], directInstall: true })),
    queueInstall: vi.fn(async () => undefined),
    resetQueue: vi.fn(async () => undefined),
    startQueue: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => ({})),
  };
}

function byType(deps: NodeDependency[]): Record<string, NodeDependency> {
  return Object.fromEntries(deps.map((d) => [d.class_type, d]));
}

describe("#2765 issue-era catalogue: a catch-all pattern owns nothing", () => {
  it("resolves the reported nodes to their naming-convention owners, not the catch-all", async () => {
    const result = await extractWorkflowDependencies(wf(...REPORTED), deps(ISSUE_ERA));
    const d = byType(result.dependencies);

    expect(d["Power Lora Loader (rgthree)"]).toMatchObject({
      pack: "Comfy Nodes",
      installed: false,
      source: "manager_pattern",
    });
    expect(d["Switch latent [Crystools]"]).toMatchObject({
      pack: "Crystools",
      installed: false,
      source: "manager_pattern",
    });
    // No exact claim, no bounded pattern: the catalogue does not know them, and saying
    // so is the honest answer.
    expect(d["Krea2EditGroundedEncode"]).toMatchObject({ pack: null, source: "unresolved" });
    expect(d["Krea2EditModelPatch"]).toMatchObject({ pack: null, source: "unresolved" });

    expect(result.missingPacks).toEqual(["Comfy Nodes", "Crystools"]);
    expect(result.unresolved).toEqual(["Krea2EditGroundedEncode", "Krea2EditModelPatch"]);
    expect(JSON.stringify(result)).not.toContain("Anomalous");
  });

  it("leaves a class matched ONLY by the catch-all unresolved", async () => {
    const result = await extractWorkflowDependencies(wf("ImageCropToMask"), deps(ISSUE_ERA));
    expect(result.dependencies[0]).toMatchObject({ pack: null, source: "unresolved" });
    expect(result.unresolved).toEqual(["ImageCropToMask"]);
    expect(result.requiredPacks).toEqual([]);
  });

  it("control: an exact listing still resolves, labelled as an exact mapping", async () => {
    const result = await extractWorkflowDependencies(wf("RgthreeSeed"), deps(ISSUE_ERA));
    expect(result.dependencies[0]).toMatchObject({
      pack: "Comfy Nodes",
      source: "manager_mappings",
    });
  });

  it("installed nodes are owned by their /object_info python_module, never by a catalogue pattern", async () => {
    const objectInfo: ObjectInfo = {
      "Power Lora Loader (rgthree)": def("Power Lora Loader (rgthree)", "custom_nodes.rgthree-comfy"),
      "Switch latent [Crystools]": def("Switch latent [Crystools]", "custom_nodes.ComfyUI-Crystools.nodes"),
      Krea2EditGroundedEncode: def("Krea2EditGroundedEncode", "custom_nodes.comfyui-krea2edit"),
      Krea2EditModelPatch: def("Krea2EditModelPatch", "custom_nodes.comfyui-krea2edit"),
    };
    const result = await extractWorkflowDependencies(wf(...REPORTED), deps(ISSUE_ERA, objectInfo));
    const d = byType(result.dependencies);

    // The Manager title is kept only where the loaded directory corroborates it.
    expect(d["Power Lora Loader (rgthree)"]).toMatchObject({ pack: "Comfy Nodes", installed: true, source: "object_info" });
    expect(d["Switch latent [Crystools]"]).toMatchObject({ pack: "Crystools", installed: true, source: "object_info" });
    expect(d["Krea2EditGroundedEncode"]).toMatchObject({ pack: "comfyui-krea2edit", source: "object_info" });
    expect(result.requiredPacks).toEqual(["Comfy Nodes", "Crystools", "comfyui-krea2edit"]);
    expect(result.missingPacks).toEqual([]);
  });
});

describe("#2765 current catalogue: an exact listing that contradicts a naming convention", () => {
  it("refuses to pick between the two claimants and installs neither", async () => {
    const result = await extractWorkflowDependencies(wf(...REPORTED), deps(CURRENT));
    const d = byType(result.dependencies);

    expect(d["Power Lora Loader (rgthree)"]).toMatchObject({
      pack: null,
      installed: false,
      source: "unresolved",
      claimants: [ANOMALOUS, RGTHREE],
    });
    expect(result.ambiguous).toEqual([
      { class_type: "Power Lora Loader (rgthree)", claimants: [ANOMALOUS, RGTHREE] },
    ]);
    expect(result.unresolved).toEqual(["Power Lora Loader (rgthree)"]);
    expect(result.missingPacks).not.toContain("Anomalous Model Browser");
    expect(result.missingPacks).not.toContain(ANOMALOUS);

    // Independent catalogue evidence for Krea2 now exists, as an exact listing.
    expect(d["Krea2EditGroundedEncode"]).toMatchObject({ pack: KREA2EDIT, source: "manager_mappings" });
    expect(d["Krea2EditModelPatch"]).toMatchObject({ pack: KREA2EDIT, source: "manager_mappings" });
    expect(d["Switch latent [Crystools]"]).toMatchObject({ pack: "Crystools", source: "manager_pattern" });
  });

  it("install_deps queues the resolved packs and carries the ambiguous claim without queuing it", async () => {
    const d = deps(CURRENT);
    const result = await installWorkflowDependencies(wf(...REPORTED), d);
    const queued = vi.mocked(d.queueInstall).mock.calls.map(([p]) => p.id);
    expect(queued.sort()).toEqual(["Crystools", KREA2EDIT]);
    expect(queued).not.toContain(ANOMALOUS);
    expect(queued).not.toContain("Anomalous Model Browser");
    expect(result.unresolved).toEqual(["Power Lora Loader (rgthree)"]);
    expect(result.ambiguous).toEqual([
      { class_type: "Power Lora Loader (rgthree)", claimants: [ANOMALOUS, RGTHREE] },
    ]);
  });

  it("an installed node keeps the loaded directory's owner whatever the catalogue claims", async () => {
    const objectInfo: ObjectInfo = {
      "Power Lora Loader (rgthree)": def("Power Lora Loader (rgthree)", "custom_nodes.rgthree-comfy"),
    };
    const result = await extractWorkflowDependencies(wf("Power Lora Loader (rgthree)"), deps(CURRENT, objectInfo));
    expect(result.dependencies[0]).toMatchObject({ pack: "Comfy Nodes", installed: true, source: "object_info" });
    expect(result.ambiguous).toBeUndefined();
  });

  it("an installed node with an unrelated exact claimant is named by its directory", async () => {
    // The 34-node shape measured on #2765: KJNodes' ColorMatch listed by another pack.
    const mappings: Mappings = {
      "https://github.com/aining2022/ComfyUI_Swwan": [["ColorMatch"], { title_aux: "ComfyUI_Swwan" }],
    };
    const objectInfo: ObjectInfo = { ColorMatch: def("ColorMatch", "custom_nodes.comfyui-kjnodes") };
    const result = await extractWorkflowDependencies(wf("ColorMatch"), deps(mappings, objectInfo));
    expect(result.dependencies[0]).toMatchObject({ pack: "comfyui-kjnodes", source: "object_info" });
  });

  it("an installed def WITHOUT python_module does not collapse an ambiguous claim into an owner", async () => {
    const objectInfo: ObjectInfo = { "Power Lora Loader (rgthree)": def("Power Lora Loader (rgthree)") };
    const result = await extractWorkflowDependencies(wf("Power Lora Loader (rgthree)"), deps(CURRENT, objectInfo));
    expect(result.dependencies[0]).toMatchObject({
      pack: null,
      installed: true,
      claimants: [ANOMALOUS, RGTHREE],
    });
    expect(result.requiredPacks).toEqual([]);
  });
});

describe("#2765 pattern inference is bounded", () => {
  const HUNYUAN3D = "https://github.com/exedesign/Hunyuan-3D-v3";
  const HUNYUAN_WORLD = "https://github.com/A043-studios/ComfyUI_HunyuanWorldnode";
  const HUNYUAN_IMAGE3 = "https://github.com/EricRollei/Comfy_HunyuanImage3";
  const HUNYUAN: Mappings = {
    [HUNYUAN_WORLD]: [["HunyuanWorldImageTo3D", "HunyuanWorldModelLoader"], { title_aux: "HunyuanWorld" }],
    [HUNYUAN_IMAGE3]: [["HunyuanEmptyLatent"], { title_aux: "HunyuanImage3" }],
    [HUNYUAN3D]: [["HunyuanImageTo3D", "HunyuanTextTo3D"], { nodename_pattern: "Hunyuan", title_aux: "ComfyUI-Hunyuan3D-v3" }],
  };

  it("a pattern that matches other repositories' listed classes does not own an unlisted name", async () => {
    const result = await extractWorkflowDependencies(wf("HunyuanVideoSomethingNew"), deps(HUNYUAN));
    expect(result.dependencies[0]).toMatchObject({ pack: null, source: "unresolved" });
  });

  it("the over-broad pattern does not dispute the classes other repositories list", async () => {
    const result = await extractWorkflowDependencies(wf("HunyuanEmptyLatent", "HunyuanTextTo3D"), deps(HUNYUAN));
    const d = byType(result.dependencies);
    expect(d.HunyuanEmptyLatent).toMatchObject({ pack: HUNYUAN_IMAGE3, source: "manager_mappings" });
    expect(d.HunyuanTextTo3D).toMatchObject({ pack: HUNYUAN3D, source: "manager_mappings" });
    expect(result.ambiguous).toBeUndefined();
  });

  const FLEXTOOLS = "https://github.com/ostris/ComfyUI-FlexTools";
  const OSTRIS_NODES = "https://github.com/ostris/ostris_nodes_comfyui";
  const OSTRIS: Mappings = {
    [FLEXTOOLS]: [["Flex2Conditioner", "FlexGuidance"], { nodename_pattern: "- Ostris$", title_aux: "Flex.1 tools" }],
    [OSTRIS_NODES]: [["One Seed - Ostris", "Text Box - Ostris"], { nodename_pattern: "- Ostris$", title_aux: "Ostris Nodes ComfyUI" }],
  };

  it("two packs publishing one pattern: the pack that lists the class owns it", async () => {
    const result = await extractWorkflowDependencies(wf("One Seed - Ostris"), deps(OSTRIS));
    expect(result.dependencies[0]).toMatchObject({ pack: OSTRIS_NODES, source: "manager_mappings" });
  });

  it("two packs publishing one pattern: an unlisted match is ambiguous, not first-wins", async () => {
    const result = await extractWorkflowDependencies(wf("Brand New - Ostris"), deps(OSTRIS));
    expect(result.dependencies[0]).toMatchObject({
      pack: null,
      source: "unresolved",
      claimants: [FLEXTOOLS, OSTRIS_NODES],
    });
    expect(result.unresolved).toEqual(["Brand New - Ostris"]);
  });

  it("a class listed by several repositories is ambiguous, not first-wins", async () => {
    const mappings: Mappings = {
      "https://github.com/MarkoCa1/ComfyUI-Text": [["ReplaceText", "ShowText"], { title_aux: "ComfyUI-Text" }],
      "https://github.com/fairy-root/ComfyUI-Show-Text": [["ShowText"], { title_aux: "ComfyUI-Show-Text" }],
    };
    const result = await extractWorkflowDependencies(wf("ShowText", "ReplaceText"), deps(mappings));
    const d = byType(result.dependencies);
    expect(d.ShowText).toMatchObject({
      pack: null,
      source: "unresolved",
      claimants: ["https://github.com/MarkoCa1/ComfyUI-Text", "https://github.com/fairy-root/ComfyUI-Show-Text"],
    });
    expect(d.ReplaceText).toMatchObject({ pack: "https://github.com/MarkoCa1/ComfyUI-Text" });
  });

  it("a catch-all catalogue with nothing else is reported as carrying no usable entries", async () => {
    const result = await extractWorkflowDependencies(
      wf("Anything"),
      deps({ [ANOMALOUS]: [[], { nodename_pattern: ".*", title_aux: "Anomalous Model Browser" }] }),
    );
    expect(result.unresolved).toEqual(["Anything"]);
    expect(result.mappings_unavailable).toContain("no usable entries");
  });
});
