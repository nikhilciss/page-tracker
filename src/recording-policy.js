// Explicit, origin-scoped browser success rules. HTTP 200 is never a success rule.
export function parseRecordingPolicies(value = '{}') {
  const policies = JSON.parse(value);
  if (!policies || typeof policies !== 'object' || Array.isArray(policies))
    throw new Error('RECORDING_SUCCESS_RULES must be an object keyed by origin');
  for (const [origin, rule] of Object.entries(policies)) {
    if (
      new URL(origin).origin !== origin ||
      !/^https?:/.test(origin) ||
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      Object.keys(rule).some((key) => !['path', 'selector'].includes(key)) ||
      (!rule.path && !rule.selector) ||
      (rule.path !== undefined &&
        (typeof rule.path !== 'string' ||
          !rule.path.startsWith('/') ||
          rule.path.length > 2048 ||
          /[?#]/.test(rule.path))) ||
      (rule.selector !== undefined &&
        (typeof rule.selector !== 'string' || !rule.selector.trim() || rule.selector.length > 500))
    )
      throw new Error('Invalid RECORDING_SUCCESS_RULES entry');
  }
  return policies;
}
