import { describe, expect, it, vi } from "vitest";

import {
  readClipboardImage,
  type ClipboardCommandRunner,
  type NativeClipboardImageReader,
} from "../../src/cli/clipboard-image.js";
import { MAX_USER_IMAGE_BYTES } from "../../src/domain/images.js";

const EMPTY = new Uint8Array();

describe("clipboard image", () => {
  it("uses an injected native reader outside Wayland", async () => {
    const nativeReader: NativeClipboardImageReader = {
      hasImage: vi.fn(() => true),
      getImageBinary: vi.fn(async () => new Uint8Array([7, 8])),
    };
    const runCommand = vi.fn<ClipboardCommandRunner>();

    const result = await readClipboardImage({
      env: {},
      platform: "darwin",
      nativeReader,
      runCommand,
    });

    expect(result).toEqual({ bytes: new Uint8Array([7, 8]), mimeType: "image/png" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reads the preferred supported Wayland type through wl-paste", async () => {
    const nativeReader = throwingNativeReader();
    const runCommand = vi.fn<ClipboardCommandRunner>(async (command, args, options) => {
      if (command === "wl-paste" && args[0] === "--list-types") {
        return ok("text/plain\nimage/jpeg; charset=binary\nimage/png\n");
      }
      if (command === "wl-paste" && args[0] === "--type") {
        expect(args[1]).toBe("image/png");
        expect(options.maxBufferBytes).toBe(MAX_USER_IMAGE_BYTES);
        return ok(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const result = await readClipboardImage({
      env: { WAYLAND_DISPLAY: "wayland-0" },
      platform: "linux",
      nativeReader,
      runCommand,
    });

    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
  });

  it("falls back from wl-paste to xclip", async () => {
    const runCommand = vi.fn<ClipboardCommandRunner>(async (command, args) => {
      if (command === "wl-paste") return failed();
      if (command === "xclip" && args.includes("TARGETS")) return ok("image/webp\n");
      if (command === "xclip" && args.includes("image/webp")) {
        return ok(new Uint8Array([9, 8]));
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const result = await readClipboardImage({
      env: { XDG_SESSION_TYPE: "wayland" },
      platform: "linux",
      nativeReader: throwingNativeReader(),
      runCommand,
    });

    expect(result).toEqual({ bytes: new Uint8Array([9, 8]), mimeType: "image/webp" });
  });

  it("uses the injected WSL PowerShell file boundary and always cleans up", async () => {
    const removeFile = vi.fn<(filePath: string) => Promise<void>>(async () => undefined);
    const readFile = vi.fn<(filePath: string, maxBytes: number) => Promise<Uint8Array | null>>(
      async () => new Uint8Array([4, 5, 6]),
    );
    const runCommand = vi.fn<ClipboardCommandRunner>(async (command, args) => {
      if (command === "wl-paste" || command === "xclip") return failed();
      if (command === "wslpath") return ok("C:\\Users\\O'Hare\\clip.png\n");
      if (command === "powershell.exe") {
        expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
        return ok("ok\n");
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const result = await readClipboardImage({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      nativeReader: throwingNativeReader(),
      runCommand,
      temporaryFilePath: () => "/tmp/nausicaa-test-clip.png",
      readFile,
      removeFile,
    });

    expect(result).toEqual({ bytes: new Uint8Array([4, 5, 6]), mimeType: "image/png" });
    expect(readFile).toHaveBeenCalledWith(
      "/tmp/nausicaa-test-clip.png",
      MAX_USER_IMAGE_BYTES,
    );
    expect(removeFile).toHaveBeenCalledWith("/tmp/nausicaa-test-clip.png");
  });

  it("returns null for Termux and native failures without touching the system", async () => {
    const nativeReader: NativeClipboardImageReader = {
      hasImage: vi.fn(() => {
        throw new Error("unavailable");
      }),
      getImageBinary: vi.fn(async () => EMPTY),
    };
    const runCommand = vi.fn<ClipboardCommandRunner>();

    await expect(readClipboardImage({
      env: { TERMUX_VERSION: "1" },
      platform: "linux",
      nativeReader,
      runCommand,
    })).resolves.toBeNull();
    await expect(readClipboardImage({
      env: {},
      platform: "darwin",
      nativeReader,
      runCommand,
    })).resolves.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects native and command image bytes above the attachment limit", async () => {
    const oversized = new Uint8Array(MAX_USER_IMAGE_BYTES + 1);
    const nativeReader: NativeClipboardImageReader = {
      hasImage: () => true,
      getImageBinary: async () => oversized,
    };
    await expect(readClipboardImage({
      env: {},
      platform: "darwin",
      nativeReader,
      runCommand: vi.fn<ClipboardCommandRunner>(),
    })).resolves.toBeNull();

    const runCommand = vi.fn<ClipboardCommandRunner>(async (command, args) => {
      if (command === "wl-paste" && args[0] === "--list-types") return ok("image/png\n");
      if (command === "wl-paste") return ok(oversized);
      return failed();
    });
    await expect(readClipboardImage({
      env: { WAYLAND_DISPLAY: "wayland-0" },
      platform: "linux",
      nativeReader: throwingNativeReader(),
      runCommand,
    })).resolves.toBeNull();
  });
});

function throwingNativeReader(): NativeClipboardImageReader {
  return {
    hasImage: () => {
      throw new Error("native clipboard must not be accessed");
    },
    getImageBinary: async () => {
      throw new Error("native clipboard must not be accessed");
    },
  };
}

function ok(stdout: string | Uint8Array) {
  return {
    ok: true,
    stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
  };
}

function failed() {
  return { ok: false, stdout: EMPTY };
}
