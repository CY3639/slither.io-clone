// Structured JSON logging for Lambda (one object per line, picked up by CloudWatch Logs).
export function log(level, msg, fields = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, ...fields };
    if (fields.err instanceof Error) entry.err = { name: fields.err.name, message: fields.err.message };
    (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
}
