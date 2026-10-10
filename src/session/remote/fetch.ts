/** Node and web use the same bounded HTTP contract as the native adapter. */
export const remoteFetch = (url: string, init: RequestInit): Promise<Response> => globalThis.fetch(url, init);
