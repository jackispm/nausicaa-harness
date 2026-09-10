import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";

import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import type { AnyEvent } from "../../src/domain/index.js";
import { persistedErrorText } from "../../src/runtime/redaction.js";
import { TopologyLiveModel } from "./topology-live-model.js";

// Preparation never opens a model session. The second command requires explicit opt-in.
// --prepare [workspace]; --run <report directory>; --capture <report directory> <before|after>.
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--prepare";
  if (mode === "--prepare") {
    const workspace = resolve(process.argv[3] ?? "../test1");
    const reportRoot = resolve(".local/flight-team-live");
    await mkdir(reportRoot, { recursive: true });
    const output = await mkdtemp(join(reportRoot, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-`));
    await mkdir(join(output, "before"));
    await copyFile(join(workspace, "index.html"), join(output, "before/index.html"));
    const manifest: PreparedRun = {
      workspace, preparedAt: new Date().toISOString(), beforeSha256: await fileHash(join(workspace, "index.html")),
    };
    await save(output, "prepared.json", manifest);
    const before = await captureBrowser(workspace, output, "before");
    await save(output, "before-browser.json", before);
    process.stdout.write(`${JSON.stringify({ output, ...manifest, browser: before })}\n`);
  } else if (mode === "--run") {
    if (process.env.NAUSICAA_FLIGHT_LIVE !== "1") throw new Error("Set NAUSICAA_FLIGHT_LIVE=1 to authorize the real Team run");
    if (!process.argv[3]) throw new Error("Supply the prepared report directory");
    const output = resolve(process.argv[3]);
    try { await runTeam(output); }
    catch (error) { await save(output, "launch-error.json", { error: persistedErrorText(error) }); throw error; }
  } else if (mode === "--capture") {
    if (!process.argv[3] || !["before", "after"].includes(process.argv[4] ?? "")) throw new Error("Supply a report directory and before or after");
    const output = resolve(process.argv[3]);
    const prepared = JSON.parse(await readFile(join(output, "prepared.json"), "utf8")) as PreparedRun;
    const phase = process.argv[4] as "before" | "after";
    if (phase === "before" && await fileHash(join(prepared.workspace, "index.html")) !== prepared.beforeSha256) {
      throw new Error("The artifact has changed; do not overwrite its before evidence");
    }
    const browser = await captureBrowser(prepared.workspace, output, phase);
    await save(output, `${phase}-browser.json`, browser);
    process.stdout.write(`${JSON.stringify(browser)}\n`);
  } else throw new Error("Unknown flight live mode");
}

interface PreparedRun { workspace: string; preparedAt: string; beforeSha256: string }

async function runTeam(output: string): Promise<void> {
  const prepared = JSON.parse(await readFile(join(output, "prepared.json"), "utf8")) as PreparedRun;
  if (await fileHash(join(prepared.workspace, "index.html")) !== prepared.beforeSha256) {
    throw new Error("index.html changed after preparation; prepare a new run instead of overwriting the evidence");
  }
  const { createModels } = await import("@earendil-works/pi-ai");
  const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
  const { createNausicaaCredentialStore } = await import("../../src/auth/index.js");
  const { createOpenRouterModelPort } = await import("../../src/model/index.js");
  const { SessionController } = await import("../../src/runtime/session-controller.js");
  const { runInteractive } = await import("../../src/cli/interactive.js");
  const { createWorkspaceTools } = await import("../../src/tools/index.js");
  const { inspectBetaRepository } = await import("../live/openrouter-beta-harness.js");
  const model = process.env.NAUSICAA_LIVE_MODEL?.trim();
  if (!model?.startsWith("openrouter:")) throw new Error("Set NAUSICAA_LIVE_MODEL=openrouter:<model>");
  const credentials = createNausicaaCredentialStore();
  if (!process.env.OPENROUTER_API_KEY?.trim()
    && !(await credentials.list()).some((entry) => entry.providerId === "openrouter")) throw new Error("No OpenRouter credential configured");
  const models = createModels({ credentials });
  models.setProvider(openrouterProvider());
  const price = models.getModel("openrouter", model.slice("openrouter:".length))?.cost;
  if (!price) throw new Error("Unknown model pricing");
  const live = new TopologyLiveModel(createOpenRouterModelPort({ models }), {
    budgetUsd: Number(process.env.NAUSICAA_FLIGHT_BUDGET_USD ?? "0.85"), maxRequests: 100,
    maxOutputTokens: 4096, timeoutMs: 120_000,
    inputPrice: Math.max(price.input, price.cacheRead, price.cacheWrite), outputPrice: price.output,
  });
  const repository = await inspectBetaRepository();
  const runId = `flight-team-${randomUUID()}`;
  const startedAt = Date.now();
  const events: AnyEvent[] = [];
  const states: Record<string, unknown>[] = [];
  const terminal = new MemoryTerminal(140, 44);
  const prompt = "你好，请创建一个团队，改进当前目录 index.html 这个已有的 Three.js 飞行游戏，重点把飞行器模型、机头和座舱外观做得更精致，有清晰的造型层次和材质细节，并改善第一人称的观感。保留现有飞行、键盘和鼠标操作、开始、暂停、继续、HUD、碰撞与边界功能，保持单文件 HTML，不要换成另一种游戏。开发和独立验收由不同团队成员负责；先让开发成员实际修改，再让验收成员检查修改后的文件与运行情况，发现问题交回原开发成员修复并复验。你负责组织和整合报告。修改范围限于 index.html，不修改其他既有文件；最后说明改了什么和验收结果。";
  await save(output, "started.json", { runId, model, prompt, startedAt: new Date(startedAt).toISOString() });
  process.stdout.write(`${JSON.stringify({ runId, output, model, prompt })}\n`);
  const session = await SessionController.open({
    workspace: prepared.workspace, dataDir: join(output, "state"), model,
    maxOutputTokens: 4096, allowWrite: true, allowShell: true, allowNetwork: false, workerEnabled: true,
    policy: { maxMainStepsPerActivation: 24, mainRequestTimeoutMs: 125_000,
      tetoEnabled: true, tetoActivation: "automatic", tetoMaxOutputTokens: 1024 },
  }, {
    mainModel: live, workerModel: live, tetoModel: live, createRunId: () => runId,
    tools: createWorkspaceTools({ allowWrite: true, allowShell: true, allowNetwork: false }),
  });
  session.subscribe((notification) => {
    if (notification.kind !== "event") return;
    const event = notification.event;
    events.push(event);
    if (["team.created", "team.member.added", "team.task.assigned", "team.run.reported", "team.presented",
      "turn.completed", "turn.failed", "turn.waiting", "turn.cancelled"].includes(event.type)) {
      process.stdout.write(`${JSON.stringify({ elapsedMs: Date.now() - startedAt, lane: event.laneId, event: event.type })}\n`);
    }
  });
  let tuiError: string | undefined;
  let stopped = false;
  let error: string | undefined;
  let timedOut = false;
  const running = runInteractive({ session, terminal, forceAltScreen: true })
    .catch((caught: unknown) => { tuiError = persistedErrorText(caught); return 1; })
    .finally(() => { stopped = true; });
  const timeout = setTimeout(() => {
    timedOut = true;
    void session.cancel("Flight live test wall-clock limit reached");
  }, 25 * 60_000);
  const snapshots = setInterval(() => {
    states.push({ elapsedMs: Date.now() - startedAt, snapshot: session.snapshot(), team: session.teamActivity(),
      terminalBytes: terminal.outputLength });
  }, 1_000);
  try {
    await terminal.started;
    await until(() => stripTerminalSequences(terminal.output).includes(model), 15_000);
    terminal.send(`\x1b[200~${prompt}\x1b[201~`);
    terminal.send("\r");
    await until(() => events.some((event) => event.type === "turn.started"), 15_000);
    await until(() => {
      if (timedOut || stopped || tuiError) return true;
      if (events.some((event) => event.laneId === "main" && ["turn.failed", "turn.waiting", "turn.cancelled"].includes(event.type))) return true;
      if (session.snapshot().status === "idle" && events.some((event) => event.type === "turn.completed")
        && !events.some((event) => event.type === "team.created")) return true;
      return events.some((event) => event.type === "team.presented") && session.snapshot().status === "idle";
    }, 25 * 60_000 + 10_000);
    await session.waitForIdle();
    if (timedOut) throw new Error("Flight live test timed out");
    if (tuiError) throw new Error(tuiError);
    const transcript = await session.transcript();
    const finalText = transcript.findLast((entry) => entry.role === "assistant")?.content ?? "";
    const checks = collaborationChecks(events, live);
    const afterHash = await fileHash(join(prepared.workspace, "index.html"));
    checks.artifactChanged = afterHash !== prepared.beforeSha256;
    const html = await readFile(join(prepared.workspace, "index.html"), "utf8");
    const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/giu)].map((match) => match[1] ?? "");
    for (const script of inlineScripts) new Script(script, { filename: "index.html:inline" });
    checks.javascriptParses = inlineScripts.some((script) => script.trim().length > 0);
    checks.tuiReceivedTeamActivity = states.some((state) => JSON.stringify(state.team).includes('"phase":"model"'))
      && stripTerminalSequences(terminal.output).includes("Team activity");
    checks.tuiReceivedGroupReport = stripTerminalSequences(terminal.output).includes("Team message");
    await save(output, "transcript.json", transcript);
    await save(output, "result.json", { checks, finalText, afterSha256: afterHash, snapshot: session.snapshot() });
    if (!Object.values(checks).every(Boolean)) error = "One or more Team evidence checks failed";
  } catch (caught) {
    error = persistedErrorText(caught);
  } finally {
    clearTimeout(timeout);
    clearInterval(snapshots);
    try {
      if (session.snapshot().status !== "idle") await session.cancel("Flight live test finished collecting evidence");
      terminal.type("/exit"); terminal.send("\r");
      await until(() => stopped, 15_000);
      await running;
    } catch (caught) { tuiError ??= persistedErrorText(caught); }
    await session.close();
    await mkdir(join(output, "after"), { recursive: true });
    await copyFile(join(prepared.workspace, "index.html"), join(output, "after/index.html"));
    await Promise.all([
      save(output, "events.json", events), save(output, "calls.json", live.calls), save(output, "states.json", states),
      writeFile(join(output, "tui.ansi"), terminal.output),
      writeFile(join(output, "tui.txt"), stripTerminalSequences(terminal.output)),
    ]);
    const browser = await captureBrowser(prepared.workspace, output, "after");
    await save(output, "after-browser.json", browser);
    const report = { prepared, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
      model, repository, runId, prompt, error, tuiError, requests: live.calls.length, usage: live.usage,
      knownCostUsd: live.knownCostUsd, costComplete: !live.uncertain, limits: live.limits,
      scope: "Natural user prompt submitted through production runInteractive and MemoryTerminal to a real SessionController. All lane model responses and tool decisions come from OpenRouter. Browser acceptance is an independent host check, not a claim that a model saw these screenshots.",
      intervention: "No synthetic tool responses, host-script model retries, forced resume, or host-written application changes.",
      browser, events: events.length, terminalBytes: terminal.outputLength };
    await save(output, "report.json", report);
    process.stdout.write(`${JSON.stringify({ output, error, tuiError, requests: live.calls.length,
      knownCostUsd: live.knownCostUsd, costComplete: !live.uncertain, browser })}\n`);
    if (error || tuiError || browser.error || browser.pageErrors.length > 0 || !Object.values(browser.checks).every(Boolean)) process.exitCode = 1;
  }
}

function collaborationChecks(events: AnyEvent[], live: TopologyLiveModel): Record<string, boolean> {
  const writes = events.filter((event) => event.type === "tool.succeeded" && ["write_file", "apply_patch", "edit", "edit_file"].includes(event.payload.name));
  const memberWrites = writes.filter((event) => event.laneId.startsWith("team:"));
  const writerLanes = new Set(memberWrites.map((event) => event.laneId));
  const teamCalls = live.calls.filter((call) => call.laneId.startsWith("team:"));
  const distinct = new Set(teamCalls.map((call) => call.laneId));
  const firstWrite = memberWrites[0];
  const reviewReads = events.filter((event) => event.type === "tool.succeeded" && event.payload.name === "read_file"
    && distinct.has(event.laneId) && !writerLanes.has(event.laneId) && firstWrite !== undefined && event.globalOffset > firstWrite.globalOffset);
  const reports = events.filter((event) => event.type === "team.message.sent" && distinct.has(event.payload.fromLane));
  const presented = events.findLast((event) => event.type === "team.presented" && event.payload.disposition === "accepted");
  return {
    teamCreated: events.some((event) => event.type === "team.created"), multipleRealMembers: distinct.size >= 2,
    actualMemberEdits: memberWrites.length > 0, leadDidNotReplaceDeveloper: !writes.some((event) => event.laneId === "main"),
    independentReviewerReadAfterEdit: reviewReads.length > 0,
    reviewerReported: reviewReads.some((read) => reports.some((report) => report.type === "team.message.sent"
      && report.payload.fromLane === read.laneId && report.globalOffset > read.globalOffset)),
    accepted: presented !== undefined,
    finalAfterAcceptance: presented !== undefined && events.some((event) => event.type === "turn.completed"
      && event.laneId === "main" && event.globalOffset > presented.globalOffset),
    noForcedPause: !events.some((event) => event.laneId === "main" && ["turn.failed", "turn.waiting", "turn.cancelled"].includes(event.type)),
  };
}

// Puppeteer is optional for this explicitly invoked local live script, not a package dependency.
interface BrowserPage {
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "console", handler: (message: { type(): string; text(): string }) => void): void;
  bringToFront(): Promise<void>;
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForFunction(source: string, options: { timeout: number }): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  click(selector: string): Promise<void>;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void>; press(key: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void> };
}
interface BrowserDriver { newPage(): Promise<BrowserPage>; close(): Promise<void> }

async function captureBrowser(workspace: string, output: string, phase: "before" | "after") {
  const pageErrors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const checkpoints: Record<string, unknown>[] = [];
  let browser: BrowserDriver | undefined;
  let lastPage: BrowserPage | undefined;
  let error: string | undefined;
  try {
    const puppeteer = createRequire(import.meta.url)("puppeteer") as { launch(options: Record<string, unknown>): Promise<BrowserDriver> };
    browser = await puppeteer.launch({
      executablePath: process.env.NAUSICAA_FLIGHT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: process.env.NAUSICAA_FLIGHT_HEADFUL !== "1", args: ["--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage();
    lastPage = page;
    page.on("pageerror", (caught) => pageErrors.push(persistedErrorText(caught)));
    page.on("console", (message) => {
      if (["warning", "warn", "error"].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() });
    });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(join(workspace, "index.html")).href, { waitUntil: "networkidle2", timeout: 45_000 });
    await page.waitForFunction("typeof THREE !== 'undefined' && document.querySelector('#c')?.width > 0", { timeout: 15_000 });
    const sample = async (stage: string): Promise<void> => {
      checkpoints.push({ stage, ...await browserState(page) });
    };
    await sample("menu");
    await page.screenshot({ path: join(output, `${phase}-menu.png`), fullPage: true });
    await page.bringToFront();
    await page.click("#btn-start");
    await page.waitForFunction("document.querySelector('#menu')?.classList.contains('hidden')", { timeout: 5_000 });
    await delay(1_000);
    await sample("flight");
    await page.screenshot({ path: join(output, `${phase}-flight.png`), fullPage: true });
    await page.keyboard.down("Space"); await delay(800); await page.keyboard.up("Space");
    await sample("thrust");
    await page.keyboard.down("KeyD"); await delay(500); await page.keyboard.up("KeyD");
    await sample("turn");
    await delay(500);
    await sample("beforeMouse");
    await page.mouse.move(820, 470, { steps: 10 }); await delay(500);
    await sample("mouse");
    await page.keyboard.press("Escape");
    await page.waitForFunction("!document.querySelector('#menu')?.classList.contains('hidden')", { timeout: 5_000 });
    await sample("paused");
    await page.click("#btn-start");
    await page.waitForFunction("document.querySelector('#menu')?.classList.contains('hidden')", { timeout: 5_000 });
    await sample("resumed");
  } catch (caught) {
    error = persistedErrorText(caught);
    if (lastPage !== undefined) {
      const state = await browserState(lastPage).catch(() => undefined);
      if (state !== undefined) checkpoints.push({ stage: "failure", ...state });
      await lastPage.screenshot({ path: join(output, `${phase}-failure.png`), fullPage: true }).catch(() => undefined);
    }
  } finally { await browser?.close(); }
  const at = (stage: string) => checkpoints.find((checkpoint) => checkpoint.stage === stage);
  const numeric = (stage: string, key: string) => Number(String(at(stage)?.[key] ?? "").replace(/[^\d.-]/g, ""));
  const checks = {
    renderedWebgl: at("menu")?.webgl === true,
    startsPlaying: at("flight")?.menuHidden === true && at("flight")?.hudHidden === false,
    thrustChangesSpeed: at("thrust") !== undefined && numeric("thrust", "speed") > numeric("flight", "speed"),
    steeringChangesHeading: at("turn") !== undefined && at("turn")?.heading !== at("thrust")?.heading,
    mouseChangesHeading: at("mouse")?.pointerLocked === true && at("mouse")?.heading !== at("beforeMouse")?.heading,
    pauses: at("paused")?.menuHidden === false && at("paused")?.hudHidden === false,
    resumes: at("resumed")?.menuHidden === true,
    noPageErrors: pageErrors.length === 0,
    noConsoleErrors: consoleMessages.every((message) => message.type !== "error"),
  };
  return { error, pageErrors, consoleMessages, checkpoints, checks, headless: process.env.NAUSICAA_FLIGHT_HEADFUL !== "1",
    scope: "Real Chrome file load, rendered screenshots, keyboard thrust/turn, pointer-locked mouse motion, pause and resume. This smoke does not exhaust collision, flight physics, or visual quality." };
}

async function browserState(page: BrowserPage): Promise<Record<string, unknown>> {
  const state = await page.evaluate("JSON.stringify({ title: document.title, menuHidden: document.querySelector('#menu')?.classList.contains('hidden'), hudHidden: document.querySelector('#hud')?.classList.contains('hidden'), speed: document.querySelector('#speed-val')?.textContent, altitude: document.querySelector('#alt-val')?.textContent, heading: document.querySelector('#compass-heading')?.textContent, pointerLocked: !!document.pointerLockElement, focused: document.hasFocus(), canvasWidth: document.querySelector('#c')?.width, canvasHeight: document.querySelector('#c')?.height, webgl: !!document.querySelector('#c')?.getContext('webgl2') })");
  return JSON.parse(String(state)) as Record<string, unknown>;
}

class MemoryTerminal implements Terminal {
  private readonly chunks: string[] = [];
  private input?: (data: string) => void;
  private resolveStarted?: () => void;
  readonly started = new Promise<void>((resolveStarted) => { this.resolveStarted = resolveStarted; });
  readonly kittyProtocolActive = false;
  outputLength = 0;
  constructor(readonly columns: number, readonly rows: number) {}
  get output(): string { return this.chunks.join(""); }
  start(onInput: (data: string) => void): void { this.input = onInput; this.resolveStarted?.(); }
  send(data: string): void { this.input?.(data); }
  type(value: string): void { for (const character of value) this.send(character); }
  write(data: string): void { this.chunks.push(data); this.outputLength += Buffer.byteLength(data); }
  stop(): void {}
  async drainInput(): Promise<void> {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Flight live wait exceeded ${timeoutMs}ms`);
    await delay(100);
  }
}

async function fileHash(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function save(output: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
}

await main();
