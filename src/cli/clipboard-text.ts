import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MAX_OSC52_BYTES = 75_000;

export type ClipboardTextWriter = (text: string) => Promise<void>;

/** Small platform adapter for the Prime-style `/copy` command. */
export const copyToClipboard: ClipboardTextWriter = async (text) => {
  if (text.length === 0) throw new Error("No assistant message to copy yet.");

  if (process.platform !== "linux") {
    try {
      const native = require("@mariozechner/clipboard") as {
        setText?: (value: string) => Promise<void>;
      };
      if (typeof native.setText === "function") {
        await native.setText(text);
        return;
      }
    } catch {
      // Fall through to the platform command.
    }
  }

  const commands = process.platform === "darwin"
    ? [["pbcopy", []] as const]
    : process.platform === "win32"
      ? [["clip", []] as const]
      : process.env.WAYLAND_DISPLAY
        ? [["wl-copy", []] as const, ["xclip", ["-selection", "clipboard"]] as const]
        : [["xclip", ["-selection", "clipboard"]] as const, ["xsel", ["--clipboard", "--input"]] as const];

  for (const [command, args] of commands) {
    try {
      await writeToCommand(command, args, text);
      return;
    } catch {
      // Try the next platform command, then OSC 52 for remote terminals.
    }
  }

  if (Buffer.byteLength(text, "utf8") <= MAX_OSC52_BYTES) {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return;
  }
  throw new Error("Failed to copy to clipboard");
};

function writeToCommand(command: string, args: readonly string[], text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? "unknown status"}`));
    });
    child.stdin.once("error", fail);
    child.stdin.end(text);
  });
}
