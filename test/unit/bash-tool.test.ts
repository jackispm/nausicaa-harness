import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBashTool } from "../../src/tools/bash.js";

const temporaryDirectories: string[] = [];
const supportsProcessListing = process.platform !== "win32"
  && spawnSync("ps", ["-axo", "pid=,command="], {
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
const supportsPythonSetSid = supportsProcessListing
  && spawnSync("python3", ["-c", "import os; assert hasattr(os, 'setsid')"], {
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("bash tool", () => {
  it("uses the workspace as cwd and keeps stdout and stderr separate", async () => {
    const workspace = await temporaryDirectory();
    const result = await createBashTool().execute(
      { command: "printf '%s' \"$PWD\"; printf 'warning' >&2" },
      toolContext(workspace),
    );

    expect(result.isError).toBe(false);
    expect(parse(result)).toMatchObject({
      stdout: await realpath(workspace),
      stderr: "warning",
      exitCode: 0,
      truncated: false,
    });
  });

  it("executes Bash syntax and describes that boundary explicitly", async () => {
    const workspace = await temporaryDirectory();
    const tool = createBashTool();
    const result = await tool.execute(
      { command: "value=wind; printf '%s' \"$(printf \"$value\")\"" },
      toolContext(workspace),
    );

    expect(parse(result).stdout).toBe("wind");
    expect(tool.definition.description).toMatch(/interpreted by Bash/i);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_484])(
    "rejects invalid timeout %s",
    async (timeout) => {
      const workspace = await temporaryDirectory();
      const result = await createBashTool().execute(
        { command: "printf ok", timeout },
        toolContext(workspace),
      );

      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/timeout/i);
    },
  );

  it("marks a non-zero exit as an error without discarding output", async () => {
    const workspace = await temporaryDirectory();
    const result = await createBashTool().execute(
      { command: "printf before; printf problem >&2; exit 7" },
      toolContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      stdout: "before",
      stderr: "problem",
      exitCode: 7,
      error: "Command exited with code 7",
    });
  });

  it("keeps output tails within byte and line limits and reports truncation", async () => {
    const workspace = await temporaryDirectory();
    const result = await createBashTool().execute(
      { command: "node -e 'for(let i=0;i<3000;i++) process.stdout.write(`line-${i}\\n`)'" },
      toolContext(workspace),
    );
    const output = parse(result);

    expect(result.isError).toBe(false);
    expect(output.truncated).toBe(true);
    expect(output.truncation.stdout).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 3_000,
      outputLines: 2_000,
    });
    expect(output.stdout).not.toContain("line-0\n");
    expect(output.stdout).toContain("line-2999");
    expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  it("bounds stderr by bytes without cutting a UTF-8 character", async () => {
    const workspace = await temporaryDirectory();
    const result = await createBashTool().execute(
      { command: "node -e 'process.stderr.write(\"前\".repeat(30000) + \"终\")'" },
      toolContext(workspace),
    );
    const output = parse(result);

    expect(result.isError).toBe(false);
    expect(output.truncated).toBe(true);
    expect(output.truncation.stderr).toMatchObject({
      truncated: true,
      truncatedBy: "bytes",
    });
    expect(output.stderr).toMatch(/终$/u);
    expect(output.stderr).not.toContain("�");
    expect(Buffer.byteLength(output.stderr, "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  it("does not copy arbitrary parent secrets into the child environment", async () => {
    const workspace = await temporaryDirectory();
    const key = "NAUSICAA_BASH_TEST_SECRET";
    const previous = process.env[key];
    process.env[key] = "must-not-leak";
    try {
      const result = await createBashTool().execute(
        { command: `printf '%s' \"\${${key}-unset}\"` },
        toolContext(workspace),
      );
      expect(parse(result).stdout).toBe("unset");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("generates its cleanup marker instead of copying a parent value", async () => {
    const workspace = await temporaryDirectory();
    const key = "NAUSICAA_SHELL_EXECUTION_MARKER";
    const previous = process.env[key];
    process.env[key] = "parent-controlled";
    try {
      const result = await createBashTool().execute(
        { command: `test -n "\$${key}" && test "\$${key}" != parent-controlled && printf generated` },
        toolContext(workspace),
      );

      expect(result.isError).toBe(false);
      expect(parse(result).stdout).toBe("generated");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("times out and terminates descendants in the same process group", async () => {
    const workspace = await temporaryDirectory();
    const result = await createBashTool().execute(
      {
        command: "node -e 'setTimeout(()=>require(\"fs\").writeFileSync(\"escaped.txt\",\"bad\"),400)' & wait",
        timeout: 0.05,
      },
      toolContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ timedOut: true, error: expect.stringMatching(/timed out/i) });
    await delay(550);
    await expect(readFile(path.join(workspace, "escaped.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts and terminates descendants in the same process group", async () => {
    const workspace = await temporaryDirectory();
    const controller = new AbortController();
    const pending = createBashTool().execute(
      {
        command: "node -e 'setTimeout(()=>require(\"fs\").writeFileSync(\"escaped.txt\",\"bad\"),400)' & wait",
      },
      toolContext(workspace, controller.signal),
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ aborted: true, error: "Command aborted" });
    await delay(550);
    await expect(readFile(path.join(workspace, "escaped.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("does not leave detached background jobs running", async () => {
    const workspace = await temporaryDirectory();
    const result = await createBashTool().execute(
      {
        command: "node -e 'setTimeout(()=>require(\"fs\").writeFileSync(\"escaped.txt\",\"bad\"),400)' &",
      },
      toolContext(workspace),
    );

    expect(result.isError).toBe(false);
    await delay(550);
    await expect(readFile(path.join(workspace, "escaped.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "settles after a fixed grace period when a background job keeps writing",
    async () => {
      const workspace = await temporaryDirectory();
      const controller = new AbortController();
      const forcedAbort = setTimeout(() => controller.abort(), 1_500);
      try {
        const result = await createBashTool().execute(
          { command: "node -e 'while (true) process.stdout.write(\"x\")' &" },
          toolContext(workspace, controller.signal),
        );
        const output = parse(result);

        expect(result.isError).toBe(false);
        expect(output.aborted).toBe(false);
        expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(50 * 1024);
      } finally {
        clearTimeout(forcedAbort);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses a unique cleanup marker for concurrent executions",
    async () => {
      const workspace = await temporaryDirectory();
      const first = createBashTool().execute(
        { command: "node -e 'setTimeout(()=>{},500)' &" },
        toolContext(workspace),
      );
      const second = createBashTool().execute(
        { command: "sleep 0.3; printf alive" },
        toolContext(workspace),
      );
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.isError).toBe(false);
      expect(secondResult.isError).toBe(false);
      expect(parse(secondResult).stdout).toBe("alive");
    },
  );

  it.runIf(supportsPythonSetSid)(
    "terminates a descendant that escapes into a new session",
    async () => {
      const workspace = await temporaryDirectory();
      const marker = path.join(workspace, "escaped-session.txt");
      const python = [
        "import os,time",
        "os.setsid()",
        "time.sleep(0.5)",
        `open(${JSON.stringify(marker)}, \"w\").write(\"bad\")`,
      ].join("\n");
      const encoded = Buffer.from(python, "utf8").toString("base64");
      const result = await createBashTool().execute({
        command: `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))' & sleep 0.2`,
      }, toolContext(workspace));

      expect(result.isError).toBe(false);
      await delay(700);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("describes background cleanup as best-effort", () => {
    expect(createBashTool().definition.description).toMatch(/cleanup is best-effort/i);
  });
});

function parse(result: { content: string }): Record<string, any> {
  return JSON.parse(result.content) as Record<string, any>;
}

function toolContext(workspace: string, signal?: AbortSignal) {
  return {
    runId: "run-1",
    workspace,
    operationId: "operation-1",
    ...(signal === undefined ? {} : { signal }),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-bash-tool-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
