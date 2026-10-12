// CPU reference renderer in a Web Worker: receives textures once, then plain
// (structured-cloneable) eval frames, and returns the premultiplied surface.

import { createSoftRenderer, type SoftRenderer } from "@refrain-lyre/render-soft";
import type { EvalFrame } from "@refrain-lyre/core";
import type { WorkerRequest } from "./worker-protocol.js";

let renderer: SoftRenderer | null = null;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      const next = createSoftRenderer(msg.width, msg.height);
      for (const t of msg.textures) {
        next.setTexture(t.id, { width: t.width, height: t.height, data: t.data }, t.atlasRect);
      }
      renderer = next;
      self.postMessage({ type: "ready" });
      return;
    }
    if (!renderer) throw new Error("worker not initialized");
    // The plain frame is shape-compatible with EvalFrame for the renderer's needs.
    renderer.render({
      canvas: { width: renderer.width, height: renderer.height },
      drawList: msg.drawList,
      maskGroups: msg.maskGroups,
    } as unknown as EvalFrame);
    const surface = renderer.readSurface();
    self.postMessage(
      { type: "surface", requestId: msg.requestId, surface },
      { transfer: [surface.buffer] },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "error",
      ...(msg.type === "render" ? { requestId: msg.requestId } : {}),
      message,
    });
  }
};
