/*
 * Adapted from the MIT-licensed Pi/Prime Agent edit core. The unsafe path and
 * filesystem adapters are intentionally excluded; Nausicaa supplies those.
 */
import * as Diff from "diff";

export interface Edit {
  oldText: string;
  newText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface LineSpan {
  start: number;
  end: number;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) return "\n";
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findText(
  content: string,
  oldText: string,
): {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
} {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  return fuzzyIndex === -1
    ? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
    : {
        found: true,
        index: fuzzyIndex,
        matchLength: fuzzyOldText.length,
        usedFuzzyMatch: true,
      };
}

function countOccurrences(content: string, oldText: string): number {
  const source = normalizeForFuzzyMatch(content);
  const needle = normalizeForFuzzyMatch(oldText);
  return source.split(needle).length - 1;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(
  lines: readonly LineSpan[],
  replacement: MatchedEdit,
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex(
    (line) => replacementStart >= line.start && replacementStart < line.end,
  );
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content");
  }

  let endLine = startLine;
  while (endLine < lines.length && (lines[endLine]?.end ?? -1) < replacementEnd) {
    endLine += 1;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content");
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(
  content: string,
  replacements: readonly MatchedEdit[],
  offset = 0,
): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (replacement === undefined) continue;
    const matchIndex = replacement.matchIndex - offset;
    result = result.slice(0, matchIndex)
      + replacement.newText
      + result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

/** Preserve the original bytes of lines outside fuzzy-matched replacements. */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  replacementBaseContent: string,
  replacements: readonly MatchedEdit[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(replacementBaseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines after fuzzy normalization");
  }

  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: MatchedEdit[];
  }> = [];
  for (const replacement of [...replacements].sort(
    (left, right) => left.matchIndex - right.matchIndex,
  )) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current !== undefined && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine]?.start;
    const groupEndOffset = baseLines[group.endLine - 1]?.end;
    if (groupStartOffset === undefined || groupEndOffset === undefined) {
      throw new Error("Replacement range is outside the base content");
    }
    result += applyReplacements(
      replacementBaseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly Edit[],
  path: string,
): AppliedEditsResult {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));

  for (const [index, edit] of normalizedEdits.entries()) {
    if (edit.oldText.length === 0) {
      throw new Error(editError(path, index, edits.length, "oldText must not be empty"));
    }
  }

  const initialMatches = normalizedEdits.map((edit) => findText(normalizedContent, edit.oldText));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matched: MatchedEdit[] = [];
  for (const [index, edit] of normalizedEdits.entries()) {
    const match = findText(replacementBaseContent, edit.oldText);
    if (!match.found) {
      throw new Error(editError(
        path,
        index,
        edits.length,
        "oldText was not found; it must match including whitespace and newlines",
      ));
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw new Error(editError(
        path,
        index,
        edits.length,
        `oldText has ${occurrences} matches; include more context to make it unique`,
      ));
    }
    matched.push({
      editIndex: index,
      matchIndex: match.index,
      matchLength: match.matchLength,
      newText: edit.newText,
    });
  }

  matched.sort((left, right) => left.matchIndex - right.matchIndex);
  for (let index = 1; index < matched.length; index += 1) {
    const previous = matched[index - 1];
    const current = matched[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}`,
      );
    }
  }

  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matched,
      )
    : applyReplacements(replacementBaseContent, matched);
  if (newContent === normalizedContent) {
    throw new Error(`No changes made to ${path}; replacement content is identical`);
  }
  return { baseContent: normalizedContent, newContent };
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine?: number } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const width = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
  let oldLine = 1;
  let newLine = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (const [index, part] of parts.entries()) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (part.added || part.removed) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added) {
          output.push(`+${String(newLine).padStart(width, " ")} ${line}`);
          newLine += 1;
        } else {
          output.push(`-${String(oldLine).padStart(width, " ")} ${line}`);
          oldLine += 1;
        }
      }
      lastWasChange = true;
      continue;
    }

    const next = parts[index + 1];
    const nextIsChange = next?.added === true || next?.removed === true;
    const keepStart = lastWasChange ? Math.min(contextLines, lines.length) : 0;
    const keepEnd = nextIsChange ? Math.min(contextLines, lines.length - keepStart) : 0;
    const skipped = lines.length - keepStart - keepEnd;
    for (const line of lines.slice(0, keepStart)) {
      output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
      oldLine += 1;
      newLine += 1;
    }
    if (skipped > 0 && (keepStart > 0 || keepEnd > 0)) {
      output.push(` ${"".padStart(width, " ")} ...`);
    }
    oldLine += skipped;
    newLine += skipped;
    for (const line of lines.slice(lines.length - keepEnd)) {
      output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
      oldLine += 1;
      newLine += 1;
    }
    lastWasChange = false;
  }

  return {
    diff: output.join("\n"),
    ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
  };
}

function editError(path: string, index: number, total: number, message: string): string {
  return total === 1 ? `${message} in ${path}` : `edits[${index}].${message} in ${path}`;
}
