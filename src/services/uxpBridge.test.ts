import { describe, expect, it, vi } from "vitest";
import { bridge } from "./uxpBridge";

describe("uxpBridge.writeJsonEntry", () => {
  it("writes the backup path before the selected primary path", async () => {
    const writes: Array<{ fileName: string; content: string }> = [];
    const folder = {
      createFile: vi.fn(async (fileName: string) => ({
        write: async (content: string) => {
          writes.push({ fileName, content });
        }
      }))
    };
    const payload = { version: 2, title: "自定义标题" };

    await bridge.writeJsonEntry(folder, "legacy.json", payload);

    expect(writes.map(({ fileName }) => fileName)).toEqual([
      "legacy.json.bak",
      "legacy.json"
    ]);
    expect(writes.map(({ content }) => JSON.parse(content))).toEqual([payload, payload]);
  });
});
