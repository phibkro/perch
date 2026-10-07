import { fetch } from 'expo/fetch';

/** Expo provides an incremental ReadableStream for native SSE responses. */
export const openCodeFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
