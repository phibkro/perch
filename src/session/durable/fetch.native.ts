import { fetch } from 'expo/fetch';

/** Native incremental bodies and redirect:'error' use Expo's fetch implementation. */
export const durableFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
