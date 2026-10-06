// Host-provided labels only; never proof of authentication or account ownership.
export function normalizeVisitorIdentity(value) {
  const clean = (v) => {
    if (typeof v !== 'string' || v.length > 160) return null;
    const text = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return text || null;
  };
  try {
    return { id: clean(value?.id), name: clean(value?.name) };
  } catch {
    return { id: null, name: null };
  }
}
