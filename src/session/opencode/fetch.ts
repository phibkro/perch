/** Node/web implementation. Metro selects fetch.native.ts on Android/iOS. */
export const openCodeFetch = (url: string, init: RequestInit): Promise<Response> => globalThis.fetch(url, init);
