import axios from 'axios';
import { BLING_API_BASE_URL, BLING_REQUEST_TIMEOUT_MS, REQUEST_DELAY_MS } from './config';
import { getValidAccessToken, refreshAccessToken } from './oauth';
import { log } from './logger';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export async function blingGet(resourcePath: string, params: Record<string, unknown> = {}): Promise<any> {
  let accessToken = await getValidAccessToken();

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { data } = await axios.get(`${BLING_API_BASE_URL}/${resourcePath.replace(/^\//, '')}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'enable-jwt': '1',
        },
        params,
        timeout: BLING_REQUEST_TIMEOUT_MS,
      });
      return data;
    } catch (err: any) {
      if (err.response?.status === 401) {
        log('warn', 'bling token expired, refreshing', { resourcePath, attempt });
        await refreshAccessToken();
        accessToken = await getValidAccessToken();
        continue;
      }

      const status = err.response?.status;
      const isNetworkError = !err.response && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT');
      const shouldRetry = isNetworkError || status === 429 || status >= 500;
      if (!shouldRetry || attempt === 4) {
        const details = err.response?.data || err.message;
        throw new Error(`Bling API error ${status || err.code || ''}: ${JSON.stringify(details)}`);
      }

      const retryAfterMs = Number(err.response?.headers?.['retry-after'] || 0) * 1000;
      const waitMs = retryAfterMs || attempt * 2000;
      log('warn', 'bling api retry', { resourcePath, status: status || err.code, attempt, waitMs });
      await sleep(waitMs);
    }
  }

  throw new Error('Bling API request failed');
}

export async function fetchPaginated(resourcePath: string, params: Record<string, unknown> = {}, options: any = {}): Promise<any[]> {
  const items: any[] = [];
  let pagina = 1;
  const maxPages = Number(options.maxPages || 0);

  while (true) {
    const data = await blingGet(resourcePath, { ...params, pagina, limite: 100 });
    const pageItems = data?.data || [];
    items.push(...pageItems);

    if (maxPages > 0 && pagina >= maxPages) break;
    if (pageItems.length < 100) break;
    pagina++;
    await sleep(REQUEST_DELAY_MS);
  }

  return items;
}
