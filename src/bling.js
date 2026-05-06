const axios = require('axios');
const { BLING_API_BASE_URL, REQUEST_DELAY_MS } = require('./config');
const { getValidAccessToken, refreshAccessToken } = require('./oauth');
const { sleep } = require('./utils');

function apiUrl(resourcePath) {
  const base = BLING_API_BASE_URL.replace(/\/$/, '');
  const resource = resourcePath.replace(/^\//, '');
  return `${base}/${resource}`;
}

async function blingGet(resourcePath, params = {}) {
  let accessToken = await getValidAccessToken();

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { data } = await axios.get(apiUrl(resourcePath), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'enable-jwt': '1',
        },
        params,
      });
      return data;
    } catch (err) {
      if (err.response?.status === 401) {
        await refreshAccessToken();
        accessToken = await getValidAccessToken();
        continue;
      }

      const status = err.response?.status;
      const shouldRetry = status === 429 || status >= 500;
      if (!shouldRetry || attempt === 4) {
        const details = err.response?.data || err.message;
        throw new Error(`Bling API error ${status || ''}: ${JSON.stringify(details)}`);
      }

      const retryAfterMs = Number(err.response?.headers?.['retry-after'] || 0) * 1000;
      await sleep(retryAfterMs || attempt * 2000);
    }
  }

  throw new Error('Bling API request failed');
}

async function fetchPaginated(resourcePath, params = {}) {
  const items = [];
  let pagina = 1;

  while (true) {
    const data = await blingGet(resourcePath, { ...params, pagina, limite: 100 });
    const pageItems = data?.data || [];
    items.push(...pageItems);

    if (pageItems.length < 100) break;
    pagina++;
    await sleep(REQUEST_DELAY_MS);
  }

  return items;
}

module.exports = { blingGet, fetchPaginated };
