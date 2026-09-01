#!/usr/bin/env node

import { resolve } from "node:path";

import { CliUsageError, parseCliArgs, usage } from "./cli/args.js";
import { selectNewRecoveryFailures } from "./cli/daemon-recovery-reporting.js";
import { processImageInputs } from "./cli/image-input.js";
import { runInteractive } from "./cli/interactive.js";
import {
  projectConfiguredEdgeStatus,
  projectRuntimeEdgeStatus,
  type EdgeStatusProjection,
} from "./cli/edge-status.js";
import {
  createConfiguredEdgeComposition,
  loadSettings,
  resolveSettings,
  SettingsError,
  type ConfiguredEdgeComposition,
  type EdgeAdapterConstructors,
  type Settings,
  type ResolvedSettings,
} from "./config/index.js";
import type { AnyEvent } from "./domain/events.js";
import { DEFAULT_MAIN_OUTPUT_TOKENS } from "./domain/types.js";
import {
  DaemonControlServer,
  DaemonRunObserver,
  DaemonRemoteAttachment,
  DaemonRemoteSession,
  executeRun,
  FileDaemonRunEventSource,
  findLatestRunId,
  openDaemonRuntime,
  SessionController,
  type DaemonRunDiscoveryFailure,
} from "./runtime/index.js";
import {
  createRegistryEdgeTurnSnapshotProvider,
  edgeStatusFromProvider,
  type EdgeTurnSnapshotProvider,
} from "./runtime/edge-runtime.js";
import { renderAgentTopologyFromSource } from "./cli/agent-topology.js";
import { readWorkspaceAgentAwareness } from "./cli/agent-topology-source.js";
import {
  persistedErrorText,
  stringifyRedactedJson,
} from "./runtime/redaction.js";
import { UnknownToolOperationError } from "./runtime/recovery.js";
import { createMcpEdgeAdapter } from "./mowe/edges/mcp.js";
import { createSkillsEdgeAdapter } from "./mowe/edges/skills.js";
import { runRemoteAttach } from "./cli/remote-attach.js";
import {
  nonInteractiveGuidance,
  inspectCredential,
  readAvailableBoundedStdinTask,
  readBoundedStdinTask,
  startupGuidance,
  UNCONFIGURED_MODEL,
} from "./cli/onboarding.js";
import { createOpenRouterModelPort } from "./model/index.js";
import {
  createEdgeSelectionController,
  type EdgeSelectionController,
} from "./cli/edge-selection.js";

const VERSION = "0.1.0";

const main = async (): Promise<number> => {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2), process.cwd());
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${usage}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (
    !options.modeExplicit
    && !options.daemon
    && (!process.stdin.isTTY || !process.stdout.isTTY)
  ) {
    process.stderr.write(
      `Interactive mode requires a TTY. Use -p/--print or --json for non-TTY output.\n\n` +
      `${nonInteractiveGuidance(options.model)}\n\n${usage}`,
    );
    return 2;
  }

  const workspace = resolve(options.workspace);
  let resolvedDataDir = resolve(workspace, options.dataDir ?? ".nausicaa");
  let resolvedModel: string | undefined;
  let resolvedMaxOutputTokens = DEFAULT_MAIN_OUTPUT_TOKENS;
  let resolvedAllowWrite = false;
  let resolvedAllowShell = false;
  let resolvedAllowNetwork = false;
  let activeRunId = options.resume;
  let openedEdgeComposition: ConfiguredEdgeComposition | undefined;
  try {
    const settings = await loadSettings(workspace);
    if (options.topology) {
      // Topology inspection is deliberately independent of model/provider
      // configuration. It only reads committed Run JSONL files.
      const topologyDataDir = resolve(
        workspace,
        options.dataDir ?? settings.dataDir ?? ".nausicaa",
      );
      const source = await readWorkspaceAgentAwareness(topologyDataDir, workspace);
      process.stdout.write(`${renderAgentTopologyFromSource(
        source,
        options.mode === "json" ? "json" : "text",
      )}\n`);
      return 0;
    }
    let stdinMessage: string | undefined;
    if (
      (options.mode === "print" || options.mode === "json")
      && !process.stdin.isTTY
      && options.resume === undefined
      && (!options.continue || options.message !== undefined)
    ) {
      try {
        stdinMessage = options.message === undefined
          ? await readBoundedStdinTask(process.stdin)
          : await readAvailableBoundedStdinTask(process.stdin);
      } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      }
      if (stdinMessage !== undefined && options.message !== undefined) {
        process.stderr.write(
          "Task input was provided both positionally and on stdin; use one source.\n",
        );
        return 2;
      }
      if (
        stdinMessage === undefined
        && options.message === undefined
        && options.fileArgs.length === 0
        && options.resume === undefined
        && !options.continue
      ) {
        const message = "A non-interactive Run requires a task on stdin, a positional task, or an image.";
        if (options.mode === "json") {
          writeJson({
            kind: "error",
            error: {
              type: "input.task-missing",
              message,
            },
          });
        } else {
          process.stderr.write(`${message}\n`);
        }
        return 2;
      }
    }
    const overrides: Settings = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.tetoModel === undefined ? {} : { tetoModel: options.tetoModel }),
      ...(options.tetoEnabled === undefined ? {} : { tetoEnabled: options.tetoEnabled }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.allowWrite === undefined ? {} : { allowWrite: options.allowWrite }),
      ...(options.allowShell === undefined ? {} : { allowShell: options.allowShell }),
      ...(options.allowNetwork === undefined ? {} : { allowNetwork: options.allowNetwork }),
      ...(options.edges === undefined ? {} : { edges: options.edges }),
      ...(options.fukaiCompaction === undefined
        ? {}
        : { fukaiCompaction: options.fukaiCompaction }),
    };
    let startupModelMissing = false;
    let resolvedSettings: ResolvedSettings;
    try {
      resolvedSettings = resolveSettings(workspace, settings, overrides);
    } catch (error: unknown) {
      const canKeepEmptyTtySession = options.mode === "interactive"
        && process.stdin.isTTY
        && options.resume === undefined
        && !options.continue
        && error instanceof SettingsError
        && error.message === "No model configured. Pass --model or set NAUSICAA_MODEL.";
      if (!canKeepEmptyTtySession) throw error;
      startupModelMissing = true;
      resolvedSettings = resolveSettings(workspace, settings, {
        ...overrides,
        model: UNCONFIGURED_MODEL,
      });
    }
    if (options.attach !== undefined) {
      const socketPath = resolve(
        workspace,
        options.daemonSocket ?? resolve(resolvedSettings.dataDir, "daemon", "control.sock"),
      );
      const attachment = await DaemonRemoteAttachment.open({
        socketPath,
        runId: options.attach,
      });
      let session: DaemonRemoteSession | undefined;
      try {
        session = await DaemonRemoteSession.open({
          attachment,
          workspace,
          dataDir: resolvedSettings.dataDir,
          model: resolvedSettings.model,
        });
        return await runRemoteAttach({ session });
      } finally {
        if (session === undefined) await attachment.close().catch(() => undefined);
        else await session.close().catch(() => undefined);
      }
    }
    const mainModel = createOpenRouterModelPort();
    const modelCatalog = mainModel.catalog();
    const credentialStatus = inspectCredential(resolvedSettings.model, modelCatalog);
    const selectedRunId = options.continue
      ? await findLatestRunId(resolvedSettings.dataDir, workspace)
      : options.resume;
    activeRunId = selectedRunId;
    // `--continue` resumes only when lookup found a Run. With no candidate it
    // becomes a new invocation and must pass the same local startup gate.
    const isNewRun = !options.daemon
      && selectedRunId === undefined
      && options.resume === undefined;
    const localModelPreflightFailed = startupModelMissing
      || !credentialStatus.selectorRecognized
      || credentialStatus.catalogKnown === false
      || (
        credentialStatus.credentialEnv !== undefined
        && !credentialStatus.credentialPresent
      );
    if (
      options.mode !== "interactive"
      && isNewRun
      && (
        !credentialStatus.selectorRecognized
        || credentialStatus.catalogKnown === false
      )
    ) {
      const malformed = !credentialStatus.selectorRecognized;
      const message = malformed
        ? `Model selector is not recognized locally: ${resolvedSettings.model}. Use a provider:model selector.`
        : `Model is not present in the local catalog: ${resolvedSettings.model}. `
          + "No provider request or edge refresh was started; availability remains unverified.";
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: malformed ? "configuration.model-invalid" : "configuration.model-unknown",
            message,
            model: resolvedSettings.model,
            authStatus: credentialStatus.authStatus,
            nextStep: nonInteractiveGuidance(resolvedSettings.model),
          },
        });
      } else {
        process.stderr.write(`${message}\n${nonInteractiveGuidance(resolvedSettings.model)}\n`);
      }
      return 2;
    }
    if (
      options.mode !== "interactive"
      && isNewRun
      && credentialStatus.credentialEnv !== undefined
      && !credentialStatus.credentialPresent
    ) {
      const message = `Credential not detected: ${credentialStatus.credentialEnv}. `
        + "No provider request or edge refresh was started; auth remains unverified.";
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: "configuration.credential-missing",
            message,
            provider: credentialStatus.provider,
            source: credentialStatus.credentialEnv,
            authStatus: credentialStatus.authStatus,
            nextStep: nonInteractiveGuidance(resolvedSettings.model),
          },
        });
      } else {
        process.stderr.write(`${message}\n${nonInteractiveGuidance(resolvedSettings.model)}\n`);
      }
      return 2;
    }
    const edgeRuntime = await openCliEdgeRuntime(
      workspace,
      resolvedSettings,
      options.refreshEdges === true,
      !(isNewRun && localModelPreflightFailed),
    );
    openedEdgeComposition = edgeRuntime.composition;
    // Keep resume semantics explicit: when neither the settings file nor the
    // CLI mentions Fukai, omit the field so a persisted Run policy wins.
    const fukaiCompaction = settings.fukaiCompaction === undefined
      && options.fukaiCompaction === undefined
      ? undefined
      : resolvedSettings.fukaiCompaction;
    resolvedDataDir = resolvedSettings.dataDir;
    resolvedModel = resolvedSettings.model;
    resolvedMaxOutputTokens = resolvedSettings.maxOutputTokens;
    resolvedAllowWrite = resolvedSettings.allowWrite;
    resolvedAllowShell = resolvedSettings.allowShell;
    resolvedAllowNetwork = resolvedSettings.allowNetwork;
    if (options.daemon) {
      return await runDaemonMode({
        workspace,
        settings: resolvedSettings,
        edgeRuntime,
        ...(fukaiCompaction === undefined ? {} : { fukaiCompaction }),
        ...(options.workerEnabled === undefined
          ? {}
          : { workerEnabled: options.workerEnabled }),
        ...(options.daemonSocket === undefined ? {} : { socketPath: options.daemonSocket }),
        ...(options.daemonWorkerCommand === undefined
          ? {}
          : {
            workerCommand: options.daemonWorkerCommand,
            workerArgs: options.daemonWorkerArgs ?? [],
          }),
      });
    }
    const showStartupSetup = startupModelMissing
      || !credentialStatus.selectorRecognized
      || credentialStatus.catalogKnown === false
      || (
        credentialStatus.credentialEnv !== undefined
        && !credentialStatus.credentialPresent
      );
    const modelChoices = modelCatalog.map((entry) => ({
      value: entry.selector,
      label: entry.selector,
      description: `${entry.name} · context ${entry.contextWindowTokens} · `
        + `max ${entry.maxOutputTokens} · ${entry.imageInput ? "images" : "text only"} · `
        + "tools unverified · auth unverified",
      contextWindowTokens: entry.contextWindowTokens,
      imageInput: entry.imageInput,
      toolUse: entry.toolUse,
      authStatus: entry.authStatus,
    }));
    const processedImages = await processImageInputs(options.fileArgs, {
      workspace,
      protectedPaths: [resolvedSettings.dataDir],
    });
    const initialMessage = combineInitialMessage(
      processedImages.text,
      options.message ?? stdinMessage,
    );
    if (
      options.mode !== "interactive"
      && selectedRunId === undefined
      && options.resume === undefined
      && initialMessage === undefined
      && processedImages.images.length === 0
    ) {
      const message = "A non-interactive Run requires a task on stdin, a positional task, or an image.";
      if (options.mode === "json") {
        writeJson({ kind: "error", error: { type: "input.task-missing", message } });
      } else {
        process.stderr.write(`${message}\n`);
      }
      await edgeRuntime.composition.close().catch(() => undefined);
      return 2;
    }
    if (options.mode === "interactive") {
      try {
        const session = await SessionController.open({
          workspace,
          dataDir: resolvedSettings.dataDir,
          model: resolvedSettings.model,
          tetoModel: resolvedSettings.tetoModel,
          ...(fukaiCompaction === undefined ? {} : { fukaiCompaction }),
          ...(options.workerEnabled === undefined
            ? {}
            : { workerEnabled: options.workerEnabled }),
          maxOutputTokens: resolvedSettings.maxOutputTokens,
          policy: {
            maxMainStepsPerActivation: resolvedSettings.maxSteps,
            maxModelTokens: resolvedSettings.maxModelTokens,
            tetoEnabled: resolvedSettings.tetoEnabled,
            tetoMaxOutputTokens: 64,
            tetoTokenRatio: 0.1,
          },
          allowWrite: resolvedSettings.allowWrite,
          allowShell: resolvedSettings.allowShell,
          allowNetwork: resolvedSettings.allowNetwork,
          edgeSnapshotProvider: edgeRuntime.provider,
          ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
        }, { mainModel, modelCatalog });
        if (options.resolveOperation !== undefined) {
          await session.resolveOperation(options.resolveOperation);
        }
        return await runInteractive({
          session,
          edgeStatus: edgeRuntime.status,
          edgeSelection: edgeRuntime.selection,
          modelChoices,
          credentialStatus: () => inspectCredential(
            session.model === UNCONFIGURED_MODEL ? undefined : session.model,
            modelCatalog,
          ),
          startupModelMissing,
          showStartupSetup,
          startupNotice: () => startupGuidance({
            model: session.model === UNCONFIGURED_MODEL ? undefined : session.model,
            catalog: modelCatalog,
          }),
          awareness: () => readWorkspaceAgentAwareness(
            resolvedSettings.dataDir,
            workspace,
          ),
          ...(initialMessage === undefined ? {} : { initialMessage }),
          ...(processedImages.images.length === 0
            ? {}
            : { initialImages: processedImages.images }),
          ...(
            initialMessage === undefined
            && (options.resume !== undefined || (options.continue && selectedRunId !== undefined))
              ? { resumeOnStart: true }
              : {}
          ),
        });
      } finally {
        await edgeRuntime.composition.close().catch(() => undefined);
      }
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Interrupted by user"));
    process.once("SIGINT", abort);
    try {
      const result = await executeRun({
        workspace,
        dataDir: resolvedSettings.dataDir,
        model: resolvedSettings.model,
        tetoModel: resolvedSettings.tetoModel,
        ...(fukaiCompaction === undefined ? {} : { fukaiCompaction }),
        ...(options.workerEnabled === undefined
          ? {}
          : { workerEnabled: options.workerEnabled }),
        maxOutputTokens: resolvedSettings.maxOutputTokens,
        ...(initialMessage === undefined ? {} : { message: initialMessage }),
        ...(processedImages.images.length === 0
          ? {}
          : { images: processedImages.images }),
        ...(selectedRunId === undefined ? {} : { resumeRunId: selectedRunId }),
        ...(options.resolveOperation === undefined
          ? {}
          : { resolveOperationId: options.resolveOperation }),
        policy: {
          maxMainSteps: resolvedSettings.maxSteps,
          maxModelTokens: resolvedSettings.maxModelTokens,
          tetoEnabled: resolvedSettings.tetoEnabled,
          tetoMaxOutputTokens: 64,
          tetoTokenRatio: 0.1,
        },
        allowWrite: resolvedSettings.allowWrite,
        allowShell: resolvedSettings.allowShell,
        allowNetwork: resolvedSettings.allowNetwork,
        edgeSnapshotProvider: edgeRuntime.provider,
        signal: controller.signal,
      }, {
        mainModel,
        onEvent: (event: AnyEvent) => {
          activeRunId ??= event.runId;
          if (options.mode === "json") writeJson({ kind: "event", event });
        },
      });

      if (options.mode === "json") {
        writeJson({
          kind: "result",
          result: {
            runId: result.runId,
            completed: result.completed,
            steps: result.steps,
            usage: result.usage,
            metrics: result.metrics,
            stateDir: result.stateDir,
            ...(result.blocker === undefined ? {} : { blocker: result.blocker }),
          },
        });
      } else {
        if (result.finalText.length > 0) {
          process.stdout.write(`${result.finalText}\n`);
        }
        if (!result.completed) {
          process.stderr.write(result.blocker === "model-output-limit"
            ? `Run ${result.runId} reached the model output limit; the partial answer is preserved. Resume with --resume ${shellQuote(result.runId)}.\n`
            : `Run ${result.runId} stopped at a resumable boundary (${result.stateDir}).\n`);
        }
      }
      return result.completed ? 0 : 3;
    } finally {
      process.removeListener("SIGINT", abort);
      await edgeRuntime.composition.close().catch(() => undefined);
    }
  } catch (error: unknown) {
    await openedEdgeComposition?.close().catch(() => undefined);
    if (error instanceof UnknownToolOperationError && options.resume !== undefined) {
      const operationId = error.operationIds[0] ?? "<operation-id>";
      const resumeCommand = buildResumeCommand({
        runId: options.resume,
        workspace,
        dataDir: resolvedDataDir,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
        maxOutputTokens: resolvedMaxOutputTokens,
        allowWrite: resolvedAllowWrite,
        allowShell: resolvedAllowShell,
        allowNetwork: resolvedAllowNetwork,
        operationId,
      });
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: "runtime.recovery-required",
            runId: options.resume,
            stateDir: resolve(resolvedDataDir, "runs", options.resume),
            operationIds: error.operationIds,
            resumeCommand,
          },
        });
      } else {
        process.stderr.write(
          `${error.message}\nState directory: ${resolve(resolvedDataDir, "runs", options.resume)}\n` +
          `Resolve and resume with:\n  ${resumeCommand}\n`,
        );
      }
      return 3;
    }
    const message = persistedErrorText(error, "Nausicaa failed");
    const actionableMessage = error instanceof SettingsError
      && message === "No model configured. Pass --model or set NAUSICAA_MODEL."
      && options.mode !== "interactive"
      ? `${message}\n${nonInteractiveGuidance(options.model)}`
      : message;
    if (activeRunId !== undefined) {
      const stateDir = resolve(resolvedDataDir, "runs", activeRunId);
      const resumeCommand = buildResumeCommand({
        runId: activeRunId,
        workspace,
        dataDir: resolvedDataDir,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
        maxOutputTokens: resolvedMaxOutputTokens,
        allowWrite: resolvedAllowWrite,
        allowShell: resolvedAllowShell,
        allowNetwork: resolvedAllowNetwork,
      });
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: "runtime.error",
            message: actionableMessage,
            runId: activeRunId,
            stateDir,
            resumeCommand,
          },
        });
      } else {
        process.stderr.write(
          `${actionableMessage}\nRun: ${activeRunId}\nState directory: ${stateDir}\n` +
          `Resume with:\n  ${resumeCommand}\n`,
        );
      }
    } else {
      process.stderr.write(`${actionableMessage}\n`);
    }
    return error instanceof SettingsError ? 2 : 1;
  }
};

const writeJson = (value: unknown): void => {
  process.stdout.write(`${stringifyRedactedJson(value)}\n`);
};

interface DaemonModeOptions {
  workspace: string;
  settings: ResolvedSettings;
  edgeRuntime: CliEdgeRuntime;
  /** Preserve explicit startup policy when the daemon creates/resumes Runs. */
  fukaiCompaction?: ResolvedSettings["fukaiCompaction"];
  workerEnabled?: boolean;
  socketPath?: string;
  /** Optional external command implementing the detached worker protocol. */
  workerCommand?: string;
  readonly workerArgs?: readonly string[];
}

/** Run the minimal local daemon host until an explicit process signal. */
const runDaemonMode = async (options: DaemonModeOptions): Promise<number> => {
  const reportedRecoveryFailures = new Set<string>();
  let reportedReconciliationError: string | undefined;
  const reportRecoveryFailures = (
    failures: readonly DaemonRunDiscoveryFailure[],
  ): void => {
    for (const failure of selectNewRecoveryFailures(failures, reportedRecoveryFailures)) {
      process.stderr.write(
        `Nausicaa daemon skipped Run ${failure.runId ?? "<unknown>"} during recovery `
        + `(${failure.kind}): ${failure.error}\n`,
      );
    }
  };
  const daemon = await openDaemonRuntime({
    host: {
      leasePath: resolve(options.settings.dataDir, "daemon", "execution-lease.json"),
    },
    session: {
      workspace: options.workspace,
      dataDir: options.settings.dataDir,
      model: options.settings.model,
      tetoModel: options.settings.tetoModel,
      policy: {
        maxMainStepsPerActivation: options.settings.maxSteps,
        maxModelTokens: options.settings.maxModelTokens,
        tetoEnabled: options.settings.tetoEnabled,
        tetoMaxOutputTokens: 64,
        tetoTokenRatio: 0.1,
      },
      ...(options.fukaiCompaction === undefined
        ? {}
        : { fukaiCompaction: options.fukaiCompaction }),
      ...(options.workerEnabled === undefined
        ? {}
        : { workerEnabled: options.workerEnabled }),
      maxOutputTokens: options.settings.maxOutputTokens,
      allowWrite: options.settings.allowWrite,
      allowShell: options.settings.allowShell,
      allowNetwork: options.settings.allowNetwork,
      edgeSnapshotProvider: options.edgeRuntime.provider,
      closeEdgeCompositionOnClose: false,
      ...(options.settings.allowShell
        ? { processJobRegistryDir: options.settings.dataDir }
        : {}),
    },
    reconciliation: {
      // A short, serialized poll closes the gap between startup recovery and
      // Runs admitted while the daemon remains alive. No model calls happen
      // during discovery; activation still goes through the Host lease.
      intervalMs: 5_000,
      onResult: (result) => {
        reportRecoveryFailures(result.failures);
        reportedReconciliationError = undefined;
      },
      onError: (error) => {
        const message = persistedErrorText(error);
        if (message === reportedReconciliationError) return;
        reportedReconciliationError = message;
        process.stderr.write(`Nausicaa daemon reconciliation failed: ${message}\n`);
      },
    },
    closeEdgeComposition: options.edgeRuntime.composition.close,
    ...(options.workerCommand === undefined
      ? {}
      : {
        supervisor: {
          process: {
            command: options.workerCommand,
            args: options.workerArgs ?? [],
            cwd: options.workspace,
          },
        },
      }),
  });
  const socketPath = resolve(
    options.workspace,
    options.socketPath ?? resolve(options.settings.dataDir, "daemon", "control.sock"),
  );
  const observer = new DaemonRunObserver({
    source: new FileDaemonRunEventSource({ dataDir: options.settings.dataDir }),
  });
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolvePromise) => {
    resolveShutdown = resolvePromise;
  });
  const control = new DaemonControlServer({
    host: daemon.host,
    lifecycle: daemon,
    onStopResponse: resolveShutdown,
    socketPath,
    observer,
  });
  const onSignal = (): void => resolveShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await daemon.start();
    const recovered = await daemon.recoverPendingRuns();
    reportRecoveryFailures(recovered.failures);
    await control.listen();
    const recoveredText = recovered.queuedRunIds.length === 0
      ? ""
      : `; recovered ${recovered.queuedRunIds.length} pending Run(s)`;
    process.stdout.write(`Nausicaa daemon listening on ${socketPath}${recoveredText}\n`);
    await shutdown;
    return 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await control.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
  }
};

interface CliEdgeRuntime {
  readonly composition: ConfiguredEdgeComposition;
  readonly provider: EdgeTurnSnapshotProvider;
  readonly selection: EdgeSelectionController;
  readonly status: () => EdgeStatusProjection;
}

/** Build the production composition at the CLI boundary; config stays injectable and offline. */
const openCliEdgeRuntime = async (
  workspace: string,
  settings: ResolvedSettings,
  refreshRequested: boolean,
  /** Defer adapter discovery while interactive setup is incomplete. */
  startupRefreshAllowed = true,
): Promise<CliEdgeRuntime> => {
  const startupRefresh = startupRefreshAllowed
    && (refreshRequested || settings.edges.refreshOnStart);
  const composition = await createConfiguredEdgeComposition({
    workspace,
    settings,
    constructors: cliEdgeConstructors(),
    startupRefresh,
  });
  // Discovery is visible in status, but Skill bodies require an explicit host
  // selector. The predicate closes over the controller so each Turn captures
  // the latest selection without mutating the registry snapshot.
  let selection: EdgeSelectionController | undefined;
  const provider = createRegistryEdgeTurnSnapshotProvider(
    composition.registry,
    (summary) => selection?.selectionPredicate(summary) ?? false,
  );
  selection = createEdgeSelectionController(provider);
  const configured = projectConfiguredEdgeStatus(settings.edges);
  return {
    composition,
    provider,
    selection,
    status: () => {
      const runtime = projectRuntimeEdgeStatus(edgeStatusFromProvider(provider, {
        enabled: configured.enabled,
        refreshRequested: configured.refreshRequested,
        generation: configured.generation,
        toolCount: configured.toolCount ?? 0,
        contextCount: configured.contextCount ?? 0,
        diagnostics: configured.diagnostics ?? [],
        sources: [],
      }));
      return {
        ...runtime,
        enabled: settings.edges.enabled,
        refreshRequested: startupRefresh,
        diagnostics: Object.freeze([
          ...(runtime.diagnostics ?? []),
          ...(
            !startupRefreshAllowed && (refreshRequested || settings.edges.refreshOnStart)
              ? ["edge startup refresh deferred until local model setup is complete"]
              : []
          ),
          ...composition.diagnostics.map((diagnostic) => (
            diagnostic.sourceId === undefined
              ? `${diagnostic.code}: ${diagnostic.message}`
              : `${diagnostic.sourceId}: ${diagnostic.code}: ${diagnostic.message}`
          )),
        ]),
      };
    },
  };
};

const cliEdgeConstructors = (): EdgeAdapterConstructors => ({
  mcp: (source, context) => createMcpEdgeAdapter({
    sourceId: source.sourceId,
    ...(source.command === undefined ? {} : { command: source.command }),
    ...(source.args === undefined ? {} : { args: source.args }),
    ...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    cwd: context.workspace,
  }),
  skill: (source) => createSkillsEdgeAdapter({
    sourceId: source.sourceId,
    roots: [source.location ?? "skills"],
  }),
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const combineInitialMessage = (
  fileText: string,
  message: string | undefined,
): string | undefined => {
  const parts = [fileText, message?.trim() ?? ""].filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n");
};

interface ResumeCommandOptions {
  runId: string;
  workspace: string;
  dataDir: string;
  model?: string;
  maxOutputTokens: number;
  allowWrite: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  operationId?: string;
}

const buildResumeCommand = (options: ResumeCommandOptions): string => [
  "nausicaa",
  "--workspace",
  shellQuote(options.workspace),
  "--data-dir",
  shellQuote(options.dataDir),
  ...(options.model === undefined ? [] : ["--model", shellQuote(options.model)]),
  "--max-output-tokens",
  String(options.maxOutputTokens),
  ...(options.allowWrite ? ["--allow-write"] : []),
  ...(options.allowShell ? ["--allow-shell"] : []),
  ...(options.allowNetwork ? ["--allow-network"] : []),
  "--resume",
  shellQuote(options.runId),
  ...(options.operationId === undefined
    ? []
    : ["--resolve-operation", shellQuote(options.operationId)]),
].join(" ");

process.exitCode = await main();
