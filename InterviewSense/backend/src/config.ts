const INSECURE_SECRETS = new Set([
  'development-secret',
  'replace-this-in-development',
  'replace-with-a-random-secret-at-least-32-characters-long'
]);

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 32 || INSECURE_SECRETS.has(secret)) {
    throw new Error('JWT_SECRET must be set to a unique value of at least 32 characters');
  }
  return secret;
}

export function validateConfig() {
  getJwtSecret();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
}
