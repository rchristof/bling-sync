function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required env var: ${name}`);
  return process.env[name];
}

function valueOrNull(value) {
  return value === undefined || value === '' ? null : value;
}

function numberOrNull(value) {
  const normalized = valueOrNull(value);
  if (normalized === null) return null;
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function idOrNull(value) {
  const normalized = numberOrNull(value);
  return normalized && normalized > 0 ? normalized : null;
}

function dateOrNull(value) {
  const normalized = valueOrNull(value);
  if (!normalized) return null;

  const match = String(normalized).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);

  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return date;
}

function json(value) {
  return JSON.stringify(value || {});
}

function parseCliOptions(args) {
  const options = {};

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[key] = rawValue === undefined ? true : rawValue;
  }

  return options;
}

module.exports = {
  sleep,
  requiredEnv,
  valueOrNull,
  numberOrNull,
  idOrNull,
  dateOrNull,
  json,
  parseCliOptions,
};
