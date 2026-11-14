// 通过 AsyncLocalStorage 传递 traceId，logger 自动读取
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const als = new AsyncLocalStorage();

export function traceMiddleware(req, res, next) {
  const traceId = String(req.get("x-trace-id") || randomUUID()).slice(0, 16);
  res.set("x-trace-id", traceId);
  als.run({ traceId }, () => next());
}

export function currentTraceId() {
  return als.getStore()?.traceId || null;
}
