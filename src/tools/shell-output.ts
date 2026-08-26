// Tail-capture behavior is a minimal TypeScript adaptation of
// @earendil-works/pi-agent-core 0.84.3 (MIT), harness/utils/shell-output.ts.

export const SHELL_MAX_OUTPUT_BYTES = 50 * 1024;
export const SHELL_MAX_OUTPUT_LINES = 2_000;

export interface ShellOutputSnapshot {
  content: string;
  truncated: boolean;
  truncatedBy: "bytes" | "lines" | null;
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
}

export class ShellOutputCapture {
  private readonly maxRollingBytes = SHELL_MAX_OUTPUT_BYTES * 2;
  private tail = "";
  private totalBytes = 0;
  private completedLines = 0;
  private hasOpenLine = false;

  append(chunk: string): void {
    const text = sanitizeShellOutput(chunk).replaceAll("\r", "");
    if (text.length === 0) return;

    const bytes = Buffer.byteLength(text, "utf8");
    this.totalBytes += bytes;
    const newlines = countOccurrences(text, "\n");
    this.completedLines += newlines;
    const lastNewline = text.lastIndexOf("\n");
    this.hasOpenLine = lastNewline === -1
      ? true
      : lastNewline < text.length - 1;

    this.tail += text;
    if (Buffer.byteLength(this.tail, "utf8") > this.maxRollingBytes * 2) {
      this.tail = utf8Tail(this.tail, this.maxRollingBytes);
    }
  }

  snapshot(): ShellOutputSnapshot {
    const totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
    const bounded = truncateTail(
      this.tail,
      SHELL_MAX_OUTPUT_LINES,
      SHELL_MAX_OUTPUT_BYTES,
    );
    const truncated = this.totalBytes > SHELL_MAX_OUTPUT_BYTES
      || totalLines > SHELL_MAX_OUTPUT_LINES;
    const truncatedBy = truncated
      ? bounded.truncatedBy
        ?? (this.totalBytes > SHELL_MAX_OUTPUT_BYTES ? "bytes" : "lines")
      : null;

    return {
      content: truncated ? bounded.content : this.tail,
      truncated,
      truncatedBy,
      totalBytes: this.totalBytes,
      totalLines,
      outputBytes: Buffer.byteLength(bounded.content, "utf8"),
      outputLines: lineCount(bounded.content),
    };
  }
}

export function sanitizeShellOutput(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      return code < 0xfff9 || code > 0xfffb;
    })
    .join("");
}

function truncateTail(
  content: string,
  maxLines: number,
  maxBytes: number,
): { content: string; truncatedBy: "bytes" | "lines" | null } {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = splitLines(content);
  if (bytes <= maxBytes && lines.length <= maxLines) {
    return { content, truncatedBy: null };
  }

  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "bytes" | "lines" = "lines";
  for (let index = lines.length - 1; index >= 0 && output.length < maxLines; index -= 1) {
    const line = lines[index] ?? "";
    const separatorBytes = output.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (outputBytes + separatorBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (output.length === 0) {
        output.unshift(utf8Tail(line, maxBytes));
      }
      break;
    }
    output.unshift(line);
    outputBytes += separatorBytes + lineBytes;
  }
  return { content: output.join("\n"), truncatedBy };
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function lineCount(content: string): number {
  return splitLines(content).length;
}

function utf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.subarray(start));
}

function countOccurrences(value: string, target: string): number {
  let count = 0;
  for (let index = value.indexOf(target); index !== -1; index = value.indexOf(target, index + 1)) {
    count += 1;
  }
  return count;
}
