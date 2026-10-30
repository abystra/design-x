// Keep repeated inline images only once while preserving the in-memory session.
const FORMAT = 'designx-studio-session';
const VERSION = 1;
const isObject = value => value !== null && typeof value === 'object';
const isSession = value => isObject(value) && !Array.isArray(value);
const isInlineImage = value => typeof value === 'string' && /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Serialize a session without repeating uploaded image data in every result. */
export function encodeStudioSession(snapshot) {
  if (!isSession(snapshot)) throw new TypeError('A studio session must be an object');
  const images = [], references = [], indexes = new Map(), paths = new WeakMap();
  let root = true;
  const serialized = JSON.stringify(snapshot, function (key, value) {
    const path = root ? [] : [...(paths.get(this) || []), key];
    root = false;
    if (isObject(value)) paths.set(value, path);
    if (!isInlineImage(value)) return value;
    if (!indexes.has(value)) {
      indexes.set(value, images.length);
      images.push(value);
    }
    references.push({ path, image: indexes.get(value) });
    return null;
  });
  return JSON.stringify({ format: FORMAT, version: VERSION, images, references, snapshot: JSON.parse(serialized) });
}

/** Restore packed sessions and legacy plain JSON; reject corrupt storage safely. */
export function decodeStudioSession(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isSession(parsed)) return null;
    if (parsed.format !== FORMAT) return parsed;
    if (parsed.version !== VERSION || !isSession(parsed.snapshot) || !Array.isArray(parsed.images) || !Array.isArray(parsed.references)) return null;
    if (!parsed.images.every(isInlineImage)) return null;
    const seen = new Set();
    for (const reference of parsed.references) {
      if (!isSession(reference) || !Array.isArray(reference.path) || !reference.path.length || !reference.path.every(part => typeof part === 'string')) return null;
      if (!Number.isInteger(reference.image) || reference.image < 0 || reference.image >= parsed.images.length) return null;
      const pathKey = JSON.stringify(reference.path);
      if (seen.has(pathKey)) return null;
      seen.add(pathKey);
      let parent = parsed.snapshot;
      for (const part of reference.path.slice(0, -1)) {
        if (!isObject(parent) || !hasOwn(parent, part)) return null;
        parent = parent[part];
      }
      const key = reference.path.at(-1);
      if (!isObject(parent) || !hasOwn(parent, key) || parent[key] !== null) return null;
      // The path must already exist. Defining the own property avoids prototype setters.
      Object.defineProperty(parent, key, { value: parsed.images[reference.image], enumerable: true, writable: true, configurable: true });
    }
    return parsed.snapshot;
  } catch {
    return null;
  }
}
