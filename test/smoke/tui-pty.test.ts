import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const builtCli = join(process.cwd(), "dist", "cli.js");
const python = process.platform === "win32"
  ? undefined
  : findExecutable(["python3"]);

// Node does not expose a PTY allocator. Python's POSIX stdlib keeps this smoke
// test dependency-free while still exercising the installed executable and a
// real terminal driver rather than the in-memory component test seam.
const PTY_DRIVER = String.raw`
import errno
import os
import pty
import select
import signal
import sys
import time

cli, workspace, data_dir = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.execv(cli, [
        cli,
        "--workspace", workspace,
        "--data-dir", data_dir,
        "--model", "deepseek/deepseek-v4-pro-0813",
        "--main-only",
    ])

output = bytearray()
marker = b'Try "inspect this project"'
awareness_marker = b'Nausicaa awareness'
exit_screen = b'\x1b[?1049l'
deadline = time.monotonic() + 5.0
sent_agents = False
sent_exit = False
status = None

while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
            if not sent_agents and marker in output:
                os.write(fd, b"/agents\r")
                sent_agents = True
            if sent_agents and not sent_exit and awareness_marker in output:
                os.write(fd, b"/exit\r")
                sent_exit = True

    waited_pid, waited_status = os.waitpid(pid, os.WNOHANG)
    if waited_pid == pid:
        status = waited_status
        break

if status is None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)

# The child may exit before the PTY master exposes its final restore sequence.
drain_deadline = time.monotonic() + 0.25
while time.monotonic() < drain_deadline:
    ready, _, _ = select.select([fd], [], [], 0.02)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        break
    if not chunk:
        break
    output.extend(chunk)

try:
    os.close(fd)
except OSError:
    pass

sys.stdout.buffer.write(output)
if marker not in output:
    sys.exit(124)
if awareness_marker not in output:
    sys.exit(125)
if not sent_exit or exit_screen not in output:
    sys.exit(126)
if os.waitstatus_to_exitcode(status) != 0:
    sys.exit(127)
`;

describe("built CLI PTY", () => {
  it.skipIf(python === undefined)(
    "renders and restores the interactive frame through a real POSIX PTY (requires Python)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nausicaa-built-pty-"));
      try {
        const { stdout, stderr } = await execFileAsync(
          python!,
          ["-c", PTY_DRIVER, builtCli, root, join(root, "state")],
          {
            cwd: process.cwd(),
            timeout: 8_000,
            maxBuffer: 2 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              TERM: "xterm-256color",
              COLUMNS: "100",
              LINES: "30",
              LANG: "en_US.UTF-8",
            },
          },
        );

        expect(stderr).toBe("");
        expect(stdout).toContain("\x1b[?1049h");
        expect(stdout).toContain("\x1b[?1049l");
        expect(stdout).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
        const plainStdout = stripTerminalSequences(stdout);
        expect(plainStdout).toContain("Nausicaa v0.1.0");
        expect(plainStdout).toContain("escape interrupt");
        expect(stdout).not.toContain("▄▄████");
        expect(plainStdout).not.toContain("version");
        expect(plainStdout).toContain("v0.1.0");
        // Setup diagnostics may still mention the configured model; the
        // startup header itself intentionally omits session metadata.
        const headerStart = plainStdout.indexOf("Nausicaa v0.1.0");
        const nextHeaderRow = plainStdout.indexOf("Nausicaa can explain", headerStart);
        const headerFrame = plainStdout.slice(headerStart, nextHeaderRow < 0 ? undefined : nextHeaderRow);
        expect(headerFrame).not.toContain("deepseek");
        expect(headerFrame).not.toContain("cwd");
        expect(plainStdout).not.toContain('Type a task, or "/help" for commands');
        expect(plainStdout).toContain('Try "inspect this project"');
        expect(plainStdout).toContain("Nausicaa awareness");
        expect(plainStdout).not.toContain("Agent awareness is unavailable");
        expect(plainStdout).toContain("main/new");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function findExecutable(names: readonly string[]): string | undefined {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    const candidates = name.includes("/")
      ? [name]
      : directories.map((directory) => join(directory, name));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking for an executable candidate later in PATH.
      }
    }
  }
  return undefined;
}
