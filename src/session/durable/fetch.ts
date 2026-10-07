/** Node/web implementation. Never follow an authenticated redirect. */
export const durableFetch = (url: string, init: RequestInit): Promise<Response> => globalThis.fetch(url, init);
