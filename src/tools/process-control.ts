import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  stopComfyUI,
  startComfyUI,
  restartComfyUI,
} from "../services/process-control.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The three ComfyUI process-lifecycle tools collapsed into one
 * action-parameterized `restart_comfyui` tool (0.50.0 surface consolidation,
 * slice 7).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: all three retired tools took NO parameters at all, so `action`
 * is not merely the only schema-required field, it is the only field. There is
 * consequently no per-action presence guard to write here — the handler's only
 * job is to dispatch. Each branch calls the same service function the old tool
 * called, with the same (empty) arguments, and returns the identical content
 * block: the service result as pretty-printed JSON.
 */
export function registerProcessControlTools(server: McpServer): void {
  server.tool(
    "restart_comfyui",
    "Control the lifecycle of the ComfyUI server process. Driven by the `action` parameter:\n" +
      '- action:"restart" — Restart ComfyUI: stops the running process (capturing its config), waits for the port to free, relaunches with the same arguments, and polls the API for bounded readiness. Also works against a REMOTE/tunnelled ComfyUI (via --comfyui-url) by rebooting through ComfyUI-Manager over HTTP and polling for it to come back (requires ComfyUI-Manager present and its security level permitting the reboot). When COMFYUI_RESTART_COMMAND is set, a LOCAL restart runs that command instead of kill+relaunch — the recovery path for an externally managed install (a container, a systemd unit, a launcher) whose launch path cannot be proven from here. This is the normal way to reload newly installed custom nodes, and the escalation when queue (action:"cancel") reports a job WEDGED. On Windows this process never relaunches ComfyUI itself: a local restart uses ComfyUI-Manager only for a verified ComfyUI Desktop supervisor or a verified EZi/CEI proxy backend, or runs COMFYUI_RESTART_COMMAND (keeping what that command starts outside the agent\'s process tree is up to the command); any restart that would need this process to relaunch ComfyUI is refused BEFORE anything is stopped.\n' +
      '- action:"start" — Start ComfyUI using process info saved from a previous action:"stop" call. Supports both Desktop app and manual Python installs on macOS/Linux. Polls the API for bounded readiness before reporting ready. Local installs only. NOT available on Windows: a process launched from here belongs to the agent\'s process tree and can be killed when the agent closes or updates, so start always refuses there (startup:"not-attempted") — start ComfyUI from the Desktop app or its own launcher.\n' +
      '- action:"stop" — Stop the running ComfyUI process. Captures process info so it can be restarted with action:"start". Kills the process tree and resets the WebSocket client. Local installs only. Anything queued or rendering is lost. On Windows the stop is one-way from this tool: action:"start" cannot bring it back (the result says has_restart_info:false), so only stop when ComfyUI should stay down until someone restarts it by hand; to cycle it use action:"restart", which refuses rather than leaving ComfyUI down when it cannot bring it back.',
    {
      action: z
        .enum(["restart", "start", "stop"])
        .describe(
          'Which process operation to perform. None of them takes any other parameter. "restart" stops and relaunches in one call (and is the only action that also works against a remote/tunnelled ComfyUI); "start" relaunches from the info a previous "stop" saved (never on Windows); "stop" kills the running process tree.',
        ),
    },
    async (args) => {
      try {
        const json = (value: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        });

        switch (args.action) {
          case "restart":
            return json(await restartComfyUI());
          case "start":
            return json(await startComfyUI());
          case "stop":
            return json(await stopComfyUI());
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown restart_comfyui action "${String(exhaustive)}". Expected one of: restart, start, stop.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
