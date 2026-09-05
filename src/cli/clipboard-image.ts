import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { MAX_USER_IMAGE_BYTES } from "../domain/images.js";

// Minimally adapted from Prime Agent commit 7787f07415d843b9a800f6a4720e0c739bd608e5 (MIT).

export type ClipboardImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: ClipboardImageMimeType;
}

export interface NativeClipboardImageReader {
  hasImage(): boolean;
  getImageBinary(): Promise<readonly number[] | Uint8Array | null | undefined>;
}

export interface ClipboardCommandOptions {
  timeoutMs: number;
  maxBufferBytes: number;
  env: NodeJS.ProcessEnv;
}

export interface ClipboardCommandResult {
  ok: boolean;
  stdout: Uint8Array;
}

export type ClipboardCommandRunner = (
  command: string,
  args: readonly string[],
  options: ClipboardCommandOptions,
) => Promise<ClipboardCommandResult>;

export interface ClipboardImageReadOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nativeReader?: NativeClipboardImageReader | null;
  runCommand?: ClipboardCommandRunner;
  temporaryFilePath?: () => string;
  readFile?: (filePath: string, maxBytes: number) => Promise<Uint8Array | null>;
  removeFile?: (filePath: string) => Promise<void>;
}

export type ClipboardImageReader = (
  options?: ClipboardImageReadOptions,
) => Promise<ClipboardImage | null>;

const SUPPORTED_IMAGE_MIME_TYPES: readonly ClipboardImageMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
const DEFAULT_LIST_TIMEOUT_MS = 1_000;
const DEFAULT_READ_TIMEOUT_MS = 3_000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5_000;
const PROTOCOL_MAX_BUFFER_BYTES = 64 * 1024;

const require = createRequire(import.meta.url);

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

export const readClipboardImage: ClipboardImageReader = async (options = {}) => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.TERMUX_VERSION) return null;

  const runCommand = options.runCommand ?? runClipboardCommand;
  const nativeReader = options.nativeReader !== undefined
    ? options.nativeReader
    : loadNativeClipboardReader(platform, env);

  if (platform !== "linux") {
    return readViaNativeClipboard(nativeReader);
  }

  const wayland = isWaylandSession(env);
  const wsl = isWsl(env);
  let image: ClipboardImage | null = null;

  if (wayland || wsl) {
    image = await readViaWlPaste(runCommand, env);
    if (image === null) image = await readViaXclip(runCommand, env);
  }
  if (image === null && wsl) {
    image = await readViaPowerShell(runCommand, env, options);
  }
  if (image === null && !wayland) {
    image = await readViaNativeClipboard(nativeReader);
  }

  return image;
};

function loadNativeClipboardReader(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): NativeClipboardImageReader | null {
  const hasDisplay = platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (env.TERMUX_VERSION || !hasDisplay) return null;

  try {
    return require("@mariozechner/clipboard") as NativeClipboardImageReader;
  } catch {
    return null;
  }
}

async function readViaNativeClipboard(
  reader: NativeClipboardImageReader | null,
): Promise<ClipboardImage | null> {
  if (reader === null) return null;

  try {
    if (!reader.hasImage()) return null;
    const image = await reader.getImageBinary();
    if (
      image === null
      || image === undefined
      || image.length === 0
      || image.length > MAX_USER_IMAGE_BYTES
    ) return null;
    return {
      bytes: image instanceof Uint8Array ? image : Uint8Array.from(image),
      mimeType: "image/png",
    };
  } catch {
    return null;
  }
}

async function readViaWlPaste(
  runCommand: ClipboardCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<ClipboardImage | null> {
  const types = await runCommand(
    "wl-paste",
    ["--list-types"],
    commandOptions(env, DEFAULT_LIST_TIMEOUT_MS, PROTOCOL_MAX_BUFFER_BYTES),
  );
  if (!types.ok || types.stdout.byteLength > PROTOCOL_MAX_BUFFER_BYTES) return null;

  const mimeType = selectPreferredMimeType(decodeLines(types.stdout));
  if (mimeType === null) return null;
  const image = await runCommand(
    "wl-paste",
    ["--type", mimeType, "--no-newline"],
    commandOptions(env, DEFAULT_READ_TIMEOUT_MS, MAX_USER_IMAGE_BYTES),
  );
  return imageFromCommand(image, mimeType);
}

async function readViaXclip(
  runCommand: ClipboardCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<ClipboardImage | null> {
  const targets = await runCommand(
    "xclip",
    ["-selection", "clipboard", "-t", "TARGETS", "-o"],
    commandOptions(env, DEFAULT_LIST_TIMEOUT_MS, PROTOCOL_MAX_BUFFER_BYTES),
  );
  const preferred = targets.ok && targets.stdout.byteLength <= PROTOCOL_MAX_BUFFER_BYTES
    ? selectPreferredMimeType(decodeLines(targets.stdout))
    : null;
  const candidates = preferred === null
    ? SUPPORTED_IMAGE_MIME_TYPES
    : [preferred, ...SUPPORTED_IMAGE_MIME_TYPES.filter((type) => type !== preferred)];

  for (const mimeType of candidates) {
    const image = await runCommand(
      "xclip",
      ["-selection", "clipboard", "-t", mimeType, "-o"],
      commandOptions(env, DEFAULT_READ_TIMEOUT_MS, MAX_USER_IMAGE_BYTES),
    );
    const accepted = imageFromCommand(image, mimeType);
    if (accepted !== null) return accepted;
  }
  return null;
}

async function readViaPowerShell(
  runCommand: ClipboardCommandRunner,
  env: NodeJS.ProcessEnv,
  options: ClipboardImageReadOptions,
): Promise<ClipboardImage | null> {
  const temporaryFile = options.temporaryFilePath?.()
    ?? path.join(tmpdir(), `nausicaa-wsl-clip-${randomUUID()}.png`);
  const readFile = options.readFile ?? readBoundedFile;
  const removeFile = options.removeFile ?? unlink;

  try {
    const windowsPath = await runCommand(
      "wslpath",
      ["-w", temporaryFile],
      commandOptions(env, DEFAULT_LIST_TIMEOUT_MS, PROTOCOL_MAX_BUFFER_BYTES),
    );
    if (!windowsPath.ok || windowsPath.stdout.byteLength > PROTOCOL_MAX_BUFFER_BYTES) return null;

    const target = Buffer.from(windowsPath.stdout).toString("utf8").trim();
    if (target.length === 0) return null;
    const quotedTarget = target.replaceAll("'", "''");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$path = '${quotedTarget}'`,
      "$img = [System.Windows.Forms.Clipboard]::GetImage()",
      "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
    ].join("; ");
    const result = await runCommand(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      commandOptions(env, DEFAULT_POWERSHELL_TIMEOUT_MS, PROTOCOL_MAX_BUFFER_BYTES),
    );
    if (
      !result.ok
      || result.stdout.byteLength > PROTOCOL_MAX_BUFFER_BYTES
      || Buffer.from(result.stdout).toString("utf8").trim() !== "ok"
    ) return null;

    const bytes = await readFile(temporaryFile, MAX_USER_IMAGE_BYTES);
    return bytes !== null && bytes.byteLength > 0 && bytes.byteLength <= MAX_USER_IMAGE_BYTES
      ? { bytes, mimeType: "image/png" }
      : null;
  } catch {
    return null;
  } finally {
    try {
      await removeFile(temporaryFile);
    } catch {
      // Cleanup is best-effort.
    }
  }
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSLENV);
}

function selectPreferredMimeType(types: readonly string[]): ClipboardImageMimeType | null {
  const offered = new Set(types.map(baseMimeType));
  return SUPPORTED_IMAGE_MIME_TYPES.find((type) => offered.has(type)) ?? null;
}

function baseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function decodeLines(bytes: Uint8Array): string[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function imageFromCommand(
  result: ClipboardCommandResult,
  mimeType: ClipboardImageMimeType,
): ClipboardImage | null {
  return result.ok
    && result.stdout.byteLength > 0
    && result.stdout.byteLength <= MAX_USER_IMAGE_BYTES
    ? { bytes: result.stdout, mimeType }
    : null;
}

function commandOptions(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBufferBytes: number,
): ClipboardCommandOptions {
  return { env, timeoutMs, maxBufferBytes };
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<Uint8Array | null> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === 0 || offset > maxBytes ? null : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function runClipboardCommand(
  command: string,
  args: readonly string[],
  options: ClipboardCommandOptions,
): Promise<ClipboardCommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      encoding: "buffer",
    }, (error, stdout) => {
      if (error !== null) {
        resolve({ ok: false, stdout: new Uint8Array() });
        return;
      }
      const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
      resolve(bytes.byteLength <= options.maxBufferBytes
        ? { ok: true, stdout: bytes }
        : { ok: false, stdout: new Uint8Array() });
    });
  });
}
