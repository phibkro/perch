import { fetch } from 'expo/fetch';

/** Expo supplies incremental native response bodies and rejects redirects. */
export const remoteFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
