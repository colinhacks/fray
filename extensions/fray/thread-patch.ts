import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ThreadPatchReplacement = {
  oldText: string;
  newText: string;
};

export type ThreadPatchAppendSection = {
  heading: string;
  content: string;
};

export type ThreadPatchArgs = {
  replacements?: ThreadPatchReplacement[];
  appendSections?: ThreadPatchAppendSection[];
  expectedSha256?: string;
};

export type ThreadPatchResult = {
  changed: boolean;
  replacementCount: number;
  appendedSectionCount: number;
  sha256Before: string;
  sha256After: string;
  bytesBefore: number;
  bytesAfter: number;
};

type MatchedReplacement = ThreadPatchReplacement & {
  index: number;
  start: number;
  end: number;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    out.push(index);
    start = index + Math.max(needle.length, 1);
  }
  return out;
}

function normalizeReplacements(input: unknown): ThreadPatchReplacement[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error("replacements must be an array when provided");
  return input.map((replacement, index) => {
    if (typeof replacement?.oldText !== "string") throw new Error(`replacements[${index}].oldText must be a string`);
    if (typeof replacement?.newText !== "string") throw new Error(`replacements[${index}].newText must be a string`);
    if (replacement.oldText.length === 0) throw new Error(`replacements[${index}].oldText must not be empty`);
    return { oldText: replacement.oldText, newText: replacement.newText };
  });
}

function normalizeAppendSections(input: unknown): ThreadPatchAppendSection[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error("appendSections must be an array when provided");
  return input.map((section, index) => {
    if (typeof section?.heading !== "string") throw new Error(`appendSections[${index}].heading must be a string`);
    if (typeof section?.content !== "string") throw new Error(`appendSections[${index}].content must be a string`);
    const heading = section.heading.trim();
    if (!heading) throw new Error(`appendSections[${index}].heading must not be empty`);
    if (/\r|\n/.test(heading)) throw new Error(`appendSections[${index}].heading must be one line`);
    return { heading, content: section.content };
  });
}

function buildAppendedSections(sections: ThreadPatchAppendSection[]): string {
  return sections.map((section) => `## ${section.heading}\n${section.content.replace(/\s*$/, "")}\n`).join("\n");
}

export function applyThreadPatchText(source: string, args: ThreadPatchArgs): ThreadPatchResult & { text: string } {
  const replacements = normalizeReplacements(args.replacements);
  const appendSections = normalizeAppendSections(args.appendSections);
  if (replacements.length === 0 && appendSections.length === 0) throw new Error("thread patch must include at least one replacement or appended section");

  const sha256Before = sha256(source);
  if (args.expectedSha256 && args.expectedSha256 !== sha256Before) throw new Error(`thread doc hash changed before patch: expected ${args.expectedSha256}, found ${sha256Before}; re-read the thread and retry`);

  const matched: MatchedReplacement[] = replacements.map((replacement, index) => {
    const matches = findAll(source, replacement.oldText);
    if (matches.length === 0) throw new Error(`replacements[${index}].oldText was not found in the current thread doc; re-read the thread and retry`);
    if (matches.length > 1) throw new Error(`replacements[${index}].oldText matched ${matches.length} places in the current thread doc; provide a larger unique snippet`);
    const start = matches[0];
    return { ...replacement, index, start, end: start + replacement.oldText.length };
  });

  const sorted = [...matched].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.end > current.start) throw new Error(`replacements[${previous.index}] and replacements[${current.index}] overlap in the current thread doc; merge them into one replacement`);
  }

  let text = source;
  for (const replacement of [...matched].sort((a, b) => b.start - a.start)) text = `${text.slice(0, replacement.start)}${replacement.newText}${text.slice(replacement.end)}`;
  if (appendSections.length) text = `${text.replace(/\s*$/, "")}\n\n${buildAppendedSections(appendSections)}`;

  const sha256After = sha256(text);
  return {
    text,
    changed: text !== source,
    replacementCount: replacements.length,
    appendedSectionCount: appendSections.length,
    sha256Before,
    sha256After,
    bytesBefore: Buffer.byteLength(source, "utf8"),
    bytesAfter: Buffer.byteLength(text, "utf8"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePatchLock(file: string, lockId = randomUUID(), timeoutMs = 5000): Promise<() => Promise<void>> {
  const lockFile = `${file}.fray-patch.lock`;
  const started = Date.now();
  while (true) {
    try {
      const handle = await fs.promises.open(lockFile, "wx");
      await handle.writeFile(`${lockId}\n${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return async () => {
        try { await fs.promises.unlink(lockFile); } catch { /* lock already gone */ }
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() - started > timeoutMs) throw new Error(`thread patch lock is held for ${path.basename(file)}; retry after the current patch finishes`);
      await sleep(25);
    }
  }
}

async function atomicWriteFile(file: string, content: string, lockId = randomUUID()) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${lockId}.tmp`);
  try {
    let mode: number | undefined;
    try { mode = (await fs.promises.stat(file)).mode; } catch { /* file may not exist */ }
    await fs.promises.writeFile(tmp, content);
    if (mode !== undefined) await fs.promises.chmod(tmp, mode);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* no temp file to clean */ }
    throw err;
  }
}

export async function patchThreadFile(file: string, args: ThreadPatchArgs, options: { lockId?: string; lockTimeoutMs?: number } = {}): Promise<ThreadPatchResult> {
  const release = await acquirePatchLock(file, options.lockId, options.lockTimeoutMs);
  try {
    const source = await fs.promises.readFile(file, "utf8");
    const { text, ...result } = applyThreadPatchText(source, args);
    if (result.changed) await atomicWriteFile(file, text, options.lockId);
    return result;
  } finally {
    await release();
  }
}
