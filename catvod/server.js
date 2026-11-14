import { createApp } from "./src/createApp.js";

let app;
try {
  app = createApp();
} catch (err) {
  console.error("[boot] Failed to create app:", err);
  // 导出一个最小化的错误处理 app，确保 Vercel 能收到响应
  const express = (await import("express")).default;
  app = express();
  app.use((req, res) => res.status(500).json({ error: "App initialization failed", detail: err.message }));
}

export default app;