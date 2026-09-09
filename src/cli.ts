#!/usr/bin/env node

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { VERSION } from "./version.js";
import { CliUsageError, parseCliArgs, usage } from "./cli/args.js";
import { runUtilityCommand } from "./cli/auth.js";
import { createMcpManagement } from "./cli/mcp-management.js";
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
  DEFAULT_LOCAL_SKILL_ROOTS,
  loadSettings,
  planCliSkillDiscovery,
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
  createFileDaemonCommandRecoveryJournal,
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
import type { AgentAwarenessReader } from "./runtime/agent-awareness-tool.js";
import { projectAgentTopology } from "./runtime/agent-awareness.js";
import { RUNTIME_BUILD_ID } from "./runtime/build-identity.js";
import { createLocalCrossRunComposition } from "./runtime/local-cross-run-composition.js";
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
import { createBundledSkillsEdgeAdapter } from "./mowe/edges/bundled-skills.js";
import { createSkillsEdgeAdapter } from "./mowe/edges/skills.js";
import { runRemoteAttach } from "./cli/remote-attach.js";
import {
  applyProviderAuthStatus,
  nonInteractiveGuidance,
  inspectCredential,
  readAvailableBoundedStdinTask,
  readBoundedStdinTask,
  providerCredentialHint,
  providerSupportsAmbientCredentialChain,
  startupGuidance,
  UNCONFIGURED_MODEL,
} from "./cli/onboarding.js";
import {
  createBuiltinModelPort,
  parseModelSelector,
} from "./model/index.js";
import { createNausicaaCredentialStore } from "./auth/index.js";
import {
  createEdgeSelectionController,
  type EdgeSelectionController,
} from "./cli/edge-selection.js";

const MODEL_REFRESH_TIMEOUT_MS = 60_000;

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
  if (options.command !== undefined) {
    try {
      return await runUtilityCommand(options.command);
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
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
  // Keep the fallback used by recovery/error guidance aligned with the
  // ordinary user-session default (full access).
  let resolvedAllowWrite = true;
  let resolvedAllowShell = true;
  let resolvedAllowNetwork = true;
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
        return await runRemoteAttach({
          session,
          // The shipped CLI uses the fixed fullscreen dock. Keep the parsed
          // legacy flag for compatibility, but never route production users
          // back to the broken regular viewport path.
          forceAltScreen: true,
        });
      } finally {
        if (session === undefined) await attachment.close().catch(() => undefined);
        else await session.close().catch(() => undefined);
      }
    }
    const credentialStore = createNausicaaCredentialStore();
    // The shipped pi-ai registry is provider-neutral. `--all-providers` is
    // retained only so older scripts continue to parse successfully.
    const mainModel = createBuiltinModelPort({ credentials: credentialStore });
    let modelRefreshAborted = false;
    let modelRefreshErrors: ReadonlyMap<string, Error> = new Map();
    if (options.refreshModels === true) {
      const refreshController = new AbortController();
      const refreshTimer = setTimeout(
        () => refreshController.abort(new Error("model catalog refresh timed out")),
        MODEL_REFRESH_TIMEOUT_MS,
      );
      refreshTimer.unref?.();
      try {
        const refreshed = await mainModel.refreshCatalog({
          signal: refreshController.signal,
        });
        modelRefreshAborted = refreshed.aborted;
        modelRefreshErrors = refreshed.errors;
      } finally {
        clearTimeout(refreshTimer);
      }
      if (modelRefreshAborted || modelRefreshErrors.size > 0) {
        const diagnostics = [
          ...(modelRefreshAborted ? ["model catalog refresh aborted"] : []),
          ...[...modelRefreshErrors.entries()].map(([provider, error]) => (
            `${provider}: ${persistedErrorText(error, "model catalog refresh failed")}`
          )),
        ];
        process.stderr.write(`Nausicaa model catalog refresh incomplete: ${diagnostics.join("; ")}\n`);
      }
    }
    const modelCatalog = mainModel.catalog();
    // Keep only non-secret credential metadata in the process. A model change
    // can cross providers, so a single cached OpenRouter entry is insufficient.
    let savedCredentials = new Map(
      (await credentialStore.list()).map((entry) => [entry.providerId, entry.type]),
    );
    const selectedProvider = (model: string | undefined): string | undefined => {
      if (model === undefined || model === UNCONFIGURED_MODEL) return undefined;
      try {
        return parseModelSelector(model).provider;
      } catch {
        return undefined;
      }
    };
    const savedCredentialFor = (model: string | undefined, defaultProvider = false) => {
      const provider = selectedProvider(model) ?? (defaultProvider ? "openrouter" : undefined);
      const type = provider === undefined ? undefined : savedCredentials.get(provider);
      return provider !== undefined && type !== undefined
        ? { provider, type }
        : undefined;
    };
    let selectedModelProvider = selectedProvider(resolvedSettings.model);
    let selectedAuthCheck: Awaited<ReturnType<typeof mainModel.checkAuth>>;
    let selectedAuthCheckFailed = false;
    if (selectedModelProvider === undefined) {
      selectedAuthCheck = undefined;
    } else {
      try {
        selectedAuthCheck = await mainModel.checkAuth(selectedModelProvider);
      } catch {
        // A local credential store/provider check failure must not be mistaken
        // for a missing key; the provider request remains authoritative.
        selectedAuthCheckFailed = true;
        selectedAuthCheck = undefined;
      }
    }
    const credentialStatusBase = inspectCredential(
      resolvedSettings.model,
      modelCatalog,
      process.env,
      savedCredentialFor(resolvedSettings.model),
    );
    const credentialStatus = selectedAuthCheckFailed
      ? { ...credentialStatusBase, authCheckFailed: true }
      : applyProviderAuthStatus(credentialStatusBase, selectedAuthCheck);
    const selectedRunId = options.continue
      ? await findLatestRunId(resolvedSettings.dataDir, workspace)
      : options.resume;
    activeRunId = selectedRunId;
    // `--continue` selects a Run only when lookup finds one. Interactive mode
    // attaches and waits for input; print/JSON mode may continue it. With no
    // candidate it becomes a new invocation and must pass the startup gate.
    const isNewRun = !options.daemon
      && selectedRunId === undefined
      && options.resume === undefined;
    const localModelPreflightFailed = startupModelMissing
      || !credentialStatus.selectorRecognized
      || credentialStatus.catalogKnown === false
      || (
        credentialStatus.credentialEnv !== undefined
        && !credentialStatus.credentialPresent
        && !selectedAuthCheckFailed
      )
      || (
        !selectedAuthCheckFailed
        && selectedModelProvider !== undefined
        && !providerSupportsAmbientCredentialChain(selectedModelProvider)
        && credentialStatus.authConfigured === false
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
      && (
        (
          credentialStatus.credentialEnv !== undefined
          && !credentialStatus.credentialPresent
          && !selectedAuthCheckFailed
        )
        || (
          !selectedAuthCheckFailed
          && selectedModelProvider !== undefined
          && !providerSupportsAmbientCredentialChain(selectedModelProvider)
          && credentialStatus.authConfigured === false
        )
      )
    ) {
      const credentialSource = providerCredentialHint(credentialStatus.provider)
        ?? credentialStatus.credentialEnv
        ?? credentialStatus.authSource
        ?? `credentials for ${credentialStatus.provider ?? "the selected provider"}`;
      const message = `Credential not detected: ${credentialSource}. `
        + "No provider request or edge refresh was started; auth remains unverified.";
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: "configuration.credential-missing",
            message,
            provider: credentialStatus.provider,
            source: credentialSource,
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
      options.edgesEnabled,
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
    const localSessionId = `session-${randomUUID()}`;
    const crossRun = createLocalCrossRunComposition({
      workspace,
      dataDir: resolvedSettings.dataDir,
      sessionId: localSessionId,
    });
    const readWorkspaceAwareness: AgentAwarenessReader = async (context) => projectAgentTopology(
      await readWorkspaceAgentAwareness(resolvedSettings.dataDir, workspace, {
        currentSession: {
          sessionId: localSessionId,
          runId: context.runId,
          laneId: "main",
          ...(context.laneId === "main" ? { state: "active" as const } : {}),
          lastSeen: new Date().toISOString(),
          ...(RUNTIME_BUILD_ID === undefined ? {} : { runtimeBuildId: RUNTIME_BUILD_ID }),
        },
      }),
    );
    if (options.daemon) {
      return await runDaemonMode({
        workspace,
        settings: resolvedSettings,
        mainModel,
        edgeRuntime,
        crossRun,
        awareness: readWorkspaceAwareness,
        sessionId: localSessionId,
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
    // A selected model with a missing credential should still open directly
    // into the Pi-style composer. Authentication is surfaced on /setup,
    // /login, or when the first request actually needs it; it is not a chat
    // transcript entry at startup.
    // Pi keeps the regular composer compact after a model is selected. Setup
    // diagnostics remain available through `/setup`; only the first-run
    // missing-model gate needs the startup setup surface before selection.
    const showStartupSetup = startupModelMissing;
    const modelChoices = () => {
      const providerInfoById = new Map(mainModel.providers().map((provider) => [provider.id, provider]));
      return mainModel.catalog().map((entry) => {
        const provider = providerInfoById.get(entry.provider);
        const authHint = provider === undefined || provider.authTypes.length === 0
          ? "no interactive auth"
          : provider.authTypes.map((type) => type === "oauth" ? "OAuth" : "API key").join(" / ");
        return {
          value: entry.selector,
          label: `${provider?.name ?? entry.provider} / ${entry.name}`,
          description: `${entry.selector} · ${authHint} · context ${entry.contextWindowTokens} · `
            + `max ${entry.maxOutputTokens} · ${entry.imageInput ? "images" : "text only"} · `
            + "tools unverified",
          contextWindowTokens: entry.contextWindowTokens,
          imageInput: entry.imageInput,
          toolUse: entry.toolUse,
          authStatus: entry.authStatus,
        };
      });
    };
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
            ...(resolvedSettings.maxModelTokens === undefined
              ? {}
              : { maxModelTokens: resolvedSettings.maxModelTokens }),
            tetoEnabled: resolvedSettings.tetoEnabled,
          },
          allowWrite: resolvedSettings.allowWrite,
          allowShell: resolvedSettings.allowShell,
          allowNetwork: resolvedSettings.allowNetwork,
          sessionId: localSessionId,
          edgeSnapshotProvider: edgeRuntime.provider,
          ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
        }, {
          mainModel,
          modelCatalog: () => mainModel.catalog(),
          awareness: readWorkspaceAwareness,
          crossRun,
        });
        if (options.resolveOperation !== undefined) {
          await session.resolveOperation(options.resolveOperation);
        }
        return await runInteractive({
          session,
          // Fullscreen is the only production renderer. The regular mode
          // remains available solely to old embedding tests.
          forceAltScreen: true,
          edgeStatus: edgeRuntime.status,
          edgeSelection: edgeRuntime.selection,
          mcp: createMcpManagement({
            configuredSources: resolvedSettings.edges.sources,
            status: edgeRuntime.status,
            refresh: async () => {
              const result = await edgeRuntime.selection.refresh();
              if (result.stale) throw new Error("MCP refresh did not complete; showing the last available status");
            },
          }),
          modelChoices,
          auth: {
            credentialStore,
            modelPort: mainModel,
            provider: () => selectedProvider(session.model) ?? "openrouter",
            environment: process.env,
            refreshModels: async (provider) => {
              const refreshController = new AbortController();
              const refreshTimer = setTimeout(
                () => refreshController.abort(new Error("model catalog refresh timed out")),
                MODEL_REFRESH_TIMEOUT_MS,
              );
              refreshTimer.unref?.();
              try {
                const refreshed = await mainModel.refreshCatalog({
                  providers: [provider],
                  signal: refreshController.signal,
                });
                if (refreshed.aborted) {
                  throw new Error(
                    refreshController.signal.aborted
                      ? "model catalog refresh timed out"
                      : "refresh was cancelled",
                  );
                }
                if (refreshed.errors.size > 0) {
                  throw new Error([...refreshed.errors.values()]
                    .map((error) => persistedErrorText(error, "refresh failed"))
                    .join("; "));
                }
              } finally {
                clearTimeout(refreshTimer);
              }
            },
            onChanged: async () => {
              savedCredentials = new Map(
                (await credentialStore.list()).map((entry) => [entry.providerId, entry.type]),
              );
              const provider = selectedProvider(session.model);
              selectedModelProvider = provider;
              if (provider === undefined) {
                selectedAuthCheck = undefined;
                selectedAuthCheckFailed = false;
              } else {
                try {
                  selectedAuthCheck = await mainModel.checkAuth(provider);
                  selectedAuthCheckFailed = false;
                } catch {
                  selectedAuthCheck = undefined;
                  selectedAuthCheckFailed = true;
                }
              }
            },
          },
          credentialStatus: () => {
            const model = session.model === UNCONFIGURED_MODEL ? undefined : session.model;
            const provider = selectedProvider(model);
            const status = inspectCredential(model, mainModel.catalog(), process.env, savedCredentialFor(model));
            const auth = provider !== undefined && provider === selectedModelProvider
              ? selectedAuthCheck
              : undefined;
            return selectedAuthCheckFailed && provider === selectedModelProvider
              ? { ...status, authCheckFailed: true }
              : applyProviderAuthStatus(status, auth);
          },
          startupModelMissing,
          showStartupSetup,
          startupNotice: () => startupGuidance({
            model: session.model === UNCONFIGURED_MODEL ? undefined : session.model,
            catalog: mainModel.catalog(),
            ...(selectedAuthCheck === undefined ? {} : { auth: selectedAuthCheck }),
            ...(selectedAuthCheckFailed ? { authCheckFailed: true } : {}),
            ...(savedCredentialFor(
              session.model === UNCONFIGURED_MODEL ? undefined : session.model,
              session.model === UNCONFIGURED_MODEL,
            ) === undefined
              ? {}
              : {
                savedCredential: savedCredentialFor(
                  session.model === UNCONFIGURED_MODEL ? undefined : session.model,
                  session.model === UNCONFIGURED_MODEL,
                )!,
              }),
          }),
          awareness: () => {
            const current = session.snapshot();
            const observedAt = new Date().toISOString();
            return readWorkspaceAgentAwareness(
              resolvedSettings.dataDir,
              workspace,
              {
                currentSession: {
                  sessionId: session.sessionId,
                  ...(RUNTIME_BUILD_ID === undefined ? {} : { runtimeBuildId: RUNTIME_BUILD_ID }),
                  ...(current.runId === undefined ? {} : { runId: current.runId }),
                  laneId: "main",
                  state: awarenessStateForSession(current.status),
                  activitySummary: current.blocker ?? current.status,
                  lastSeen: observedAt,
                },
              },
            );
          },
          ...(initialMessage === undefined ? {} : { initialMessage }),
          ...(processedImages.images.length === 0
            ? {}
            : { initialImages: processedImages.images }),
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
        sessionId: localSessionId,
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
          maxMainStepsPerActivation: resolvedSettings.maxSteps,
          ...(resolvedSettings.maxModelTokens === undefined
            ? {}
            : { maxModelTokens: resolvedSettings.maxModelTokens }),
          tetoEnabled: resolvedSettings.tetoEnabled,
        },
        allowWrite: resolvedSettings.allowWrite,
        allowShell: resolvedSettings.allowShell,
        allowNetwork: resolvedSettings.allowNetwork,
        edgeSnapshotProvider: edgeRuntime.provider,
        signal: controller.signal,
        }, {
          mainModel,
          awareness: readWorkspaceAwareness,
          crossRun,
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
        allProviders: options.allProviders === true,
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
        allProviders: options.allProviders === true,
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
  mainModel: import("./domain/ports.js").ModelPort;
  edgeRuntime: CliEdgeRuntime;
  crossRun: import("./runtime/cross-run-runtime.js").CrossRunRuntimeComposition;
  awareness: AgentAwarenessReader;
  /** Identity shared with the local Cross-Run composition for this process. */
  sessionId: string;
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
      sessionId: options.sessionId,
      model: options.settings.model,
      tetoModel: options.settings.tetoModel,
      policy: {
        maxMainStepsPerActivation: options.settings.maxSteps,
        ...(options.settings.maxModelTokens === undefined
          ? {}
          : { maxModelTokens: options.settings.maxModelTokens }),
        tetoEnabled: options.settings.tetoEnabled,
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
    sessionDeps: {
      mainModel: options.mainModel,
      awareness: options.awareness,
      crossRun: options.crossRun,
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
  const commandJournal = createFileDaemonCommandRecoveryJournal(
    resolve(options.settings.dataDir, "daemon", "command-recovery.jsonl"),
  );
  const control = new DaemonControlServer({
    host: daemon.host,
    lifecycle: daemon,
    onStopResponse: resolveShutdown,
    socketPath,
    commandJournal,
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
    await commandJournal.close().catch(() => undefined);
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
  cliEdgesEnabled?: boolean,
): Promise<CliEdgeRuntime> => {
  const skillPlan = planCliSkillDiscovery(
    settings,
    cliEdgesEnabled === undefined ? {} : { cliEdgesEnabled },
  );
  const externalStartupRefresh = startupRefreshAllowed
    && (refreshRequested || settings.edges.refreshOnStart);
  let currentComposition: ConfiguredEdgeComposition | undefined;
  const composition = await createConfiguredEdgeComposition({
    workspace,
    settings: skillPlan.edges,
    constructors: cliEdgeConstructors(
      skillPlan.localSkillSourceId,
      skillPlan.localSkillRoots,
      skillPlan.bundledSkillSourceId,
      () => new Set((currentComposition?.registry.snapshot().contextContributions ?? [])
        .filter((summary) => summary.sourceId !== skillPlan.bundledSkillSourceId && summary.sourceType === "skill")
        .map((summary) => summary.name)),
    ),
    startupRefresh: false,
  });
  currentComposition = composition;
  const refreshSources = async (sourceIds: readonly string[], signal?: AbortSignal) => {
    const overrides = sourceIds.filter((id) => id !== skillPlan.bundledSkillSourceId);
    if (overrides.length > 0) await composition.registry.refresh({ workspace, timeoutMs: skillPlan.edges.refreshTimeoutMs, sourceIds: overrides, ...(signal === undefined ? {} : { signal }) });
    // Project/explicit names must be current before selecting packaged fallbacks.
    if (skillPlan.bundledSkillSourceId !== undefined && sourceIds.includes(skillPlan.bundledSkillSourceId)) {
      return composition.registry.refresh({ workspace, timeoutMs: skillPlan.edges.refreshTimeoutMs, sourceIds: [skillPlan.bundledSkillSourceId], ...(signal === undefined ? {} : { signal }) });
    }
    return composition.registry.snapshot();
  };
  // Local Skill discovery is metadata-only and does not start a provider or
  // external process. Refresh it independently so default Skills do not force
  // configured MCP sources to refresh when their external gate is off.
  let localRefreshFailed = false;
  if (externalStartupRefresh || skillPlan.localSkillSourceId !== undefined || skillPlan.bundledSkillSourceId !== undefined) {
    try {
      await refreshSources(skillPlan.edges.sources
        .filter((source) => externalStartupRefresh || source.type === "skill")
        .map((source) => source.sourceId));
    } catch {
      localRefreshFailed = true;
    }
  }
  // Discovery is visible in status, but Skill bodies require an explicit host
  // selector. The predicate closes over the controller so each Turn captures
  // the latest selection without mutating the registry snapshot.
  let selection: EdgeSelectionController | undefined;
  const provider: EdgeTurnSnapshotProvider = {
    ...createRegistryEdgeTurnSnapshotProvider(
      composition.registry,
      (summary) => selection?.selectionPredicate(summary) ?? false,
    ),
    refresh: (signal) => refreshSources(skillPlan.edges.sources.map((source) => source.sourceId), signal),
  };
  selection = createEdgeSelectionController(provider);
  const configured = projectConfiguredEdgeStatus(skillPlan.edges);
  return {
    composition,
    provider,
    selection,
    status: () => {
      // Prefer the immutable registry snapshot so `/edges` reflects discovered
      // Skill metadata and generation, while the host policy remains the
      // source of truth for the overall enabled flag.
      const runtime = projectRuntimeEdgeStatus(edgeStatusFromProvider(provider));
      return {
        ...runtime,
        enabled: skillPlan.edges.enabled,
        sources: configured.sources.map((source) => {
          const discovered = runtime.sources.find((item) => item.sourceId === source.sourceId);
          if (discovered !== undefined) return discovered;
          const plan = composition.sourcePlan.find((item) => item.sourceId === source.sourceId);
          return {
            ...source,
            ...(plan === undefined ? {} : {
              health: plan.status,
              diagnostics: plan.reason === undefined ? [] : [plan.reason],
            }),
          };
        }),
        refreshRequested: externalStartupRefresh,
        diagnostics: Object.freeze([
          ...(runtime.diagnostics ?? []),
          ...(localRefreshFailed ? ["local Skill discovery failed"] : []),
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

const cliEdgeConstructors = (
  localSkillSourceId?: string,
  localSkillRoots: readonly string[] = DEFAULT_LOCAL_SKILL_ROOTS,
  bundledSkillSourceId?: string,
  getOverrideNames?: () => ReadonlySet<string>,
): EdgeAdapterConstructors => ({
  mcp: (source, context) => createMcpEdgeAdapter({
    sourceId: source.sourceId,
    ...(source.command === undefined ? {} : { command: source.command }),
    ...(source.args === undefined ? {} : { args: source.args }),
    ...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    cwd: context.workspace,
  }),
  skill: (source) => source.sourceId === bundledSkillSourceId
    ? createBundledSkillsEdgeAdapter({ sourceId: source.sourceId, ...(getOverrideNames === undefined ? {} : { getOverrideNames }) })
    : source.sourceId === localSkillSourceId
    ? createSkillsEdgeAdapter({
        sourceId: source.sourceId,
        roots: localSkillRoots,
        // The conventional roots have deterministic precedence when the same
        // Skill name is present in more than one project directory.
        conflictMode: "first",
      })
    : createSkillsEdgeAdapter({
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

function awarenessStateForSession(
  status: "detached" | "idle" | "running" | "cancelling" | "closed",
): "active" | "waiting" | "idle" | "terminal" {
  switch (status) {
    case "running": return "active";
    case "cancelling": return "waiting";
    case "closed": return "terminal";
    case "detached":
    case "idle":
      return "idle";
  }
}

interface ResumeCommandOptions {
  runId: string;
  workspace: string;
  dataDir: string;
  model?: string;
  maxOutputTokens: number;
  allowWrite: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  allProviders?: boolean;
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
  ...(options.allProviders ? ["--all-providers"] : []),
  "--resume",
  shellQuote(options.runId),
  ...(options.operationId === undefined
    ? []
    : ["--resolve-operation", shellQuote(options.operationId)]),
].join(" ");

process.exitCode = await main();
