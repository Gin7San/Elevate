import { PrismaClient } from '@prisma/client';
import { unwrapJsonValue } from './jsonValue.js';

/**
 * Normalizes Json column reads across Prisma client runtimes: the native
 * engine returns objects as-is, while Rust-free driver-adapter runtimes wrap
 * them as `{ value: "<json>" }`. The extension unwraps the latter and is a
 * no-op for the former.
 */
export const prisma = new PrismaClient().$extends({
  result: {
    analysisResult: {
      details: {
        needs: { details: true },
        compute: ({ details }) => unwrapJsonValue(details) as typeof details
      }
    },
    feedbackReport: {
      details: {
        needs: { details: true },
        compute: ({ details }) => unwrapJsonValue(details) as typeof details
      }
    }
  }
});
