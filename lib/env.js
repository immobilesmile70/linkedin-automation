export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.statusCode = 500;
  }
}

export function optionalEnv(env, name, fallback = '') {
  const value = env[name];
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed || fallback;
}

export function requireEnv(env, name) {
  const value = optionalEnv(env, name);
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}
