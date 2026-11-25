// Vercel Edge 单一入口（SOP 阶段一）
import { handleRequest } from '../src/handler/index.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  return handleRequest(request);
}
