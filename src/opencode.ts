import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureSession } from "./capture.js";

const entrypoint = fileURLToPath(new URL("../bin/terraform-axi-ctx.js", import.meta.url));
type ContextEvent = { sessionID: string; system: { type: string; text: string }[] };
type ToolEvent = { sessionID: string; input?: unknown; args?: unknown };
type Event = {
  type: string;
  properties?: { sessionID?: string; info?: { id?: string } };
  data?: { sessionID?: string };
  location?: { directory?: string };
};
function integrations(resolveDirectory: (sessionID: string) => Promise<string | undefined>) {
  const cache = new Map<string, Promise<string>>();
  const directories = new Map<string, string>();
  const commands = new Map<string, Record<string, number>>();
  return {
    async context(sessionID: string): Promise<string> {
      const directory = await resolveDirectory(sessionID);
      if (!directory) return "";
      directories.set(sessionID, directory);
      const key = `${sessionID}\0${directory}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = new Promise((resolve) => {
          const child = execFile(
            process.execPath,
            [entrypoint],
            { cwd: directory, timeout: 3000, maxBuffer: 64 * 1024 },
            (error, stdout) => resolve(error ? "" : `## AXI ambient context: terraform-axi\n${stdout.trim()}`),
          );
          child.stdin?.end(JSON.stringify({ session_id: sessionID }));
        });
        cache.set(key, pending);
      }
      return pending;
    },
    tool(event: ToolEvent): void {
      const input = event.input ?? event.args;
      if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") return;
      const summary = commands.get(event.sessionID) ?? {};
      for (const match of input.command.matchAll(/\bterraform-axi\s+(plan|drift|lint|diagnose|doctor|state|setup)\b/g))
        summary[match[1]!] = (summary[match[1]!] ?? 0) + 1;
      commands.set(event.sessionID, summary);
    },
    async event(event: Event): Promise<void> {
      if (event.type !== "session.idle" && event.type !== "session.deleted") return;
      const sessionID = event.data?.sessionID ?? event.properties?.sessionID ?? event.properties?.info?.id;
      if (!sessionID) return;
      const directory =
        event.location?.directory ??
        (event.type === "session.deleted" ? directories.get(sessionID) : await resolveDirectory(sessionID));
      if (directory) {
        try {
          captureSession({ session_id: sessionID, cwd: directory, commands: commands.get(sessionID) ?? {} });
        } catch {
          /* optional memory must not break OpenCode */
        }
      }
      for (const key of cache.keys()) if (key.startsWith(`${sessionID}\0`)) cache.delete(key);
      if (event.type === "session.deleted") {
        commands.delete(sessionID);
        directories.delete(sessionID);
      }
    },
  };
}
export default {
  id: "axi-terraform-axi",
  async server({ directory }: { directory: string }) {
    const integration = integrations(async () => directory);
    return {
      "experimental.chat.system.transform": async (input: { sessionID: string }, output: { system: string[] }) => {
        const text = await integration.context(input.sessionID);
        if (text) output.system.push(text);
      },
      "tool.execute.after": async (input: ToolEvent) => integration.tool(input),
      event: async ({ event }: { event: Event }) => integration.event(event),
    };
  },
  async setup(ctx: {
    location: { directory: string };
    session: {
      hook(name: "context", callback: (event: ContextEvent) => Promise<void>): Promise<unknown>;
      get(input: { sessionID: string }): Promise<unknown>;
    };
    tool: { hook(name: "execute.after", callback: (event: ToolEvent) => void): Promise<unknown> };
    event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<Event> };
  }) {
    const integration = integrations(async (sessionID) => {
      try {
        const response = await ctx.session.get({ sessionID });
        if (!response || typeof response !== "object" || !("data" in response)) return undefined;
        const info = response.data;
        if (!info || typeof info !== "object" || !("location" in info)) return undefined;
        const location = info.location;
        return location &&
          typeof location === "object" &&
          "directory" in location &&
          typeof location.directory === "string"
          ? location.directory
          : undefined;
      } catch {
        return undefined;
      }
    });
    await ctx.session.hook("context", async (event) => {
      const text = await integration.context(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });
    await ctx.tool.hook("execute.after", (event) => integration.tool(event));
    const controller = new AbortController();
    const monitor = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) await integration.event(event);
      } catch {
        /* optional lifecycle memory must not break the host */
      }
    })();
    return () => {
      controller.abort();
      void monitor;
    };
  },
};
