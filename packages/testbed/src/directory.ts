// File System Entry API helpers for unpacked-directory drag and drop.

import { LIMITS, RUNTIME_LIMITS } from "@refrain-lyre/core";
import type { ByteSource } from "./container.js";

function readEntryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** DirectoryReader returns implementation-sized batches and must be drained. */
export async function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await readEntryBatch(reader);
    if (batch.length === 0) return entries;
    if (entries.length + batch.length > RUNTIME_LIMITS.containerTraversalEntries) {
      throw new Error(
        `dropped directory exceeds ${RUNTIME_LIMITS.containerTraversalEntries} traversal entries`,
      );
    }
    entries.push(...batch);
  }
}

interface CollectionState {
  entries: number;
  files: number;
  pathBytes: number;
  totalBytes: number;
}

function requireEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`unsafe dropped entry name "${name}"`);
  }
  if (new TextEncoder().encode(name).byteLength > RUNTIME_LIMITS.containerPathBytes) {
    throw new Error(`dropped entry name exceeds ${RUNTIME_LIMITS.containerPathBytes} bytes`);
  }
}

async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: Map<string, File>,
  state: CollectionState,
): Promise<void> {
  requireEntryName(entry.name);
  if (++state.entries > RUNTIME_LIMITS.containerTraversalEntries) {
    throw new Error(
      `dropped directory exceeds ${RUNTIME_LIMITS.containerTraversalEntries} traversal entries`,
    );
  }
  const path = `${prefix}${entry.name}`;
  const pathBytes = new TextEncoder().encode(path).byteLength;
  if (pathBytes > RUNTIME_LIMITS.containerPathBytes) {
    throw new Error(`dropped path exceeds ${RUNTIME_LIMITS.containerPathBytes} bytes`);
  }
  state.pathBytes += pathBytes;
  if (state.pathBytes > RUNTIME_LIMITS.containerPathMetadataBytes) {
    throw new Error(
      `dropped paths exceed ${RUNTIME_LIMITS.containerPathMetadataBytes} metadata bytes`,
    );
  }
  if (entry.isFile) {
    if (++state.files > LIMITS.containerFiles) {
      throw new Error(`dropped directory exceeds ${LIMITS.containerFiles} files`);
    }
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`dropped file "${path}" has an invalid size`);
    }
    if (file.size > LIMITS.containerUncompressedBytes - state.totalBytes) {
      throw new Error(
        `dropped directory exceeds ${LIMITS.containerUncompressedBytes} uncompressed bytes`,
      );
    }
    state.totalBytes += file.size;
    if (out.has(path)) throw new Error(`dropped directory contains duplicate path "${path}"`);
    out.set(path, file);
    return;
  }

  if (entry.isDirectory) {
    const directory = entry as FileSystemDirectoryEntry;
    const children = await readAllDirectoryEntries(directory.createReader());
    const childPrefix = `${prefix}${entry.name}/`;
    for (const child of children) await collectEntry(child, childPrefix, out, state);
  }
}

/**
 * Inventory a dropped container directory without materializing every file.
 * Opaque/unreferenced payload can legally be large; only JSON and textures
 * selected by the model loader are read later through the returned source.
 */
export async function collectDroppedDirectory(
  directory: FileSystemDirectoryEntry,
): Promise<ByteSource> {
  const files = new Map<string, File>();
  const state: CollectionState = { entries: 0, files: 0, pathBytes: 0, totalBytes: 0 };
  const children = await readAllDirectoryEntries(directory.createReader());
  for (const child of children) await collectEntry(child, "", files, state);
  return {
    async read(path, expectedBytes) {
      const file = files.get(path);
      if (!file) throw new Error(`container is missing "${path}"`);
      expectedBytes ??= file.size;
      if (file.size !== expectedBytes) {
        throw new Error(
          `container file "${path}" changed size after inventory (${expectedBytes} to ${file.size} bytes)`,
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== expectedBytes) {
        throw new Error(
          `container file "${path}" changed size while being read (${expectedBytes} to ${bytes.byteLength} bytes)`,
        );
      }
      return bytes;
    },
    async inventory() {
      return {
        files: [...files].map(([path, file]) => ({ path, size: file.size })),
      };
    },
  };
}
