/**
 * #2931 / #2933 — node-keyed `panel_set_widget` refusals for widgets whose
 * frontend code owns the value that actually executes.
 *
 * - ComfyUI-Lora-Manager (#2931): the loader nodes declare BOTH an
 *   `AUTOCOMPLETE_TEXT_LORAS` `text` widget and a DOM-backed `LORAS` `loras`
 *   widget. Python deletes or ignores `text` and applies only `loras`, which the
 *   pack's own editor fills from typed text. A programmatic `text` write reads
 *   back equal and still loads no LoRA, so a read-back cannot certify it — this
 *   is a refusal, not a receipt.
 * - ComfyUI-MiniMaxH3-Easy (#2933): `web/minimax_h3_easy_ui.js` installs a
 *   prompt editor on three node types and copies its own editor document over
 *   widget `prompt` from `onSerialize` and its `graphToPrompt` hook.
 *   `h3_prompt_mentions` is that editor's `serialize: false` DOM widget and never
 *   reaches the backend. A linked `prompt` input is honoured at queue time.
 *
 * Keyed on the proven node TYPE plus widget name only; an unknown type is never
 * refused here.
 */

import { backendStringProducerConnectAdvice } from "./primitive-force-input-connect.js";

type DerivedWidgetRule = {
  widgets: ReadonlySet<string>;
  reason: (type: string, widget: string) => string;
  remedy: (type: string) => string;
};

const LORA_MANAGER_WIDGETS: ReadonlySet<string> = new Set(["text", "loras"]);

/** Text-driven replacement per LoraManager widget node, where the pack has one. */
const LORA_MANAGER_TEXT_LOADER: Readonly<Record<string, string>> = {
  "Lora Loader (LoraManager)": "LoRA Text Loader (LoraManager)",
  "WanVideo Lora Select (LoraManager)": "WanVideo Lora Select From Text (LoraManager)",
};

const LORA_MANAGER_RULE: DerivedWidgetRule = {
  widgets: LORA_MANAGER_WIDGETS,
  reason: (type, widget) =>
    widget === "text"
      ? `${type} ignores "text" at execution — the backend applies only the DOM-backed ` +
        `"loras" list, which the node's own editor fills from typed text. A "text" write ` +
        `would read back as set and still load no LoRA.`
      : `"loras" on ${type} is owned by the node's custom LoRA-list widget; a programmatic ` +
        `write does not stick, and the backend executes whatever that widget holds.`,
  remedy: (type) => {
    const textLoader = LORA_MANAGER_TEXT_LOADER[type];
    return textLoader
      ? `Use "${textLoader}" instead: its lora_syntax input is a forceInput STRING. ` +
          `${backendStringProducerConnectAdvice("lora_syntax")} ` +
          `Or edit the LoRA rows in this node's UI.`
      : `Edit the LoRA rows in this node's UI.`;
  },
};

const MINIMAX_H3_EASY_WIDGETS: ReadonlySet<string> = new Set(["prompt", "h3_prompt_mentions"]);

const MINIMAX_H3_EASY_RULE: DerivedWidgetRule = {
  widgets: MINIMAX_H3_EASY_WIDGETS,
  reason: (type, widget) =>
    widget === "prompt"
      ? `${type}'s prompt editor copies its own document over widget "prompt" whenever the ` +
        `graph is serialized or queued, so the write would be reverted after a success echo.`
      : `"h3_prompt_mentions" on ${type} is the prompt editor's frontend-only DOM widget ` +
        `(serialize: false); it is never sent to the backend.`,
  remedy: () =>
    `Drive the prompt by link: ${backendStringProducerConnectAdvice("prompt")} A linked ` +
    `prompt input is what executes and makes the editor read-only. Or type the text in the ` +
    `node's own prompt editor.`,
};

const DERIVED_WIDGET_RULES: ReadonlyMap<string, DerivedWidgetRule> = new Map([
  ["Lora Loader (LoraManager)", LORA_MANAGER_RULE],
  ["Lora Stacker (LoraManager)", LORA_MANAGER_RULE],
  ["WanVideo Lora Select (LoraManager)", LORA_MANAGER_RULE],
  ["Create Hook LoRA (LoraManager)", LORA_MANAGER_RULE],
  ["MiniMaxH3Easy", MINIMAX_H3_EASY_RULE],
  ["MiniMaxH3EasyContextSegments", MINIMAX_H3_EASY_RULE],
  ["MiniMaxH3EasySelectedVideoContext", MINIMAX_H3_EASY_RULE],
]);

/** Names only these packs use. `text` and `prompt` are on nearly every text node,
 *  so a write that carries no proven type is NOT probed for them: ordinary writes
 *  stay one hop, and the type-keyed check covers them wherever a plan proved a type. */
const DISTINCTIVE_DERIVED_WIDGET_NAMES: ReadonlySet<string> = new Set([
  "loras",
  "h3_prompt_mentions",
]);

/** True when an untyped write to this name is worth one identity probe. */
export function isDistinctiveDerivedWidgetName(widget: string): boolean {
  return DISTINCTIVE_DERIVED_WIDGET_NAMES.has(widget);
}

/** The refusal text for a proven `nodeType` + `widget`, or null when the pair is
 *  not a known derived write. */
export function knownDerivedWidgetRefusalText(nodeType: string, widget: string): string | null {
  const rule = DERIVED_WIDGET_RULES.get(nodeType);
  if (!rule || !rule.widgets.has(widget)) return null;
  return (
    `panel_set_widget cannot set "${widget}" on ${nodeType}. ${rule.reason(nodeType, widget)} ` +
    `No graph_set_widget was dispatched. ${rule.remedy(nodeType)} ` +
    `Do not retry panel_set_widget on this widget.`
  );
}
