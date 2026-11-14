// src/sources/adapters/bfzy.js
import { createMaccmsAdapter } from "./maccmsFactory.js";
export const bfzy = createMaccmsAdapter({
  id: "bfzy", label: "暴风",
  capabilities: { search: true, detail: true, shareResolve: false },
});