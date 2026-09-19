import { handle } from 'hono/aws-lambda';
import { createRuntime } from './runtime.js';

// Hono preserves HTTP API payload 2.0 rawQueryString and the cookies/Set-Cookie arrays.
export const handler = handle(createRuntime().app);
