// Current Desktop builds expose the Rspack ESM runtime from an already-loaded
// numeric entry. Only its initialized cache is an inspection boundary: requiring
// an arbitrary module would execute application code during discovery.
const codexWebpackOwnData = (value, key) => {
  if (!value || !["object", "function"].includes(typeof value))
    return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && "value" in field ? field.value : undefined;
  } catch {
    return undefined;
  }
};
const codexWebpackObject = (value) =>
  Boolean(value && (typeof value === "object" || typeof value === "function"));
const codexWebpackObserverPrototype = (value) => {
  const direct = codexQueryObserverPrototype(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return null;
  let current = value;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const constructor = codexWebpackOwnData(current, "constructor");
    const prototype = codexQueryObserverPrototype(constructor);
    if (prototype === current) return prototype;
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return null;
    }
  }
  return null;
};
const codexWebpackExportRecord = (value) => {
  if (!value || typeof value !== "object" || value === globalThis) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    if (value === Object.prototype) return false;
    const constructor = codexWebpackOwnData(value, "constructor");
    return codexWebpackOwnData(constructor, "prototype") !== value;
  } catch {
    return false;
  }
};
const codexInitializedWebpackPickerCandidates = (namespaces) => {
  const result = {
    nativeReasoningVisibilityRequired: false,
    nativeReasoningVisibilityAtoms: [],
    queryClients: [],
    queryObserverPrototypes: [],
    scopes: [],
    runtimeCount: 0,
    moduleCount: 0,
    candidateCount: 0,
    truncated: false,
  };
  // Bounds are shared across every entry/cache in one scan, including invalid
  // entries. Never walk arbitrary browser objects or invoke export accessors;
  // getter-only ESM exports remain undiscovered rather than executing them.
  const limits = {
    namespaces: 8,
    modules: 16384,
    candidates: 32768,
    properties: 128,
    fields: 65536,
    depth: 2,
  };
  const inputs = Array.isArray(namespaces) ? namespaces : [namespaces];
  const inputCount = codexWebpackOwnData(inputs, "length") || 0;
  if (inputCount > limits.namespaces) result.truncated = true;
  const seenCaches = new Set();
  const queued = new Set();
  const candidates = [];
  const clients = new Set();
  const prototypes = new Set();
  const scopes = new Set();
  const visibilityAtoms = new Set();
  let inspectedModules = 0;
  let inspectedFields = 0;
  const enqueue = (value, depth) => {
    if (!codexWebpackObject(value) || value === globalThis || queued.has(value))
      return;
    if (queued.size >= limits.candidates) {
      result.truncated = true;
      return;
    }
    queued.add(value);
    candidates.push({ value, depth });
  };
  for (
    let index = 0;
    index < Math.min(inputCount, limits.namespaces);
    index += 1
  ) {
    const namespace = codexWebpackOwnData(inputs, String(index));
    const runtime = codexWebpackOwnData(namespace, "__webpack_require__");
    if (typeof runtime !== "function") continue;
    // Numeric Desktop entries can apply another native preference filter after
    // model-query selection. Missing/uninitialized bindings must not certify
    // that the picker visibly exposes every projected catalog effort.
    result.nativeReasoningVisibilityRequired = true;
    const cache = codexWebpackOwnData(runtime, "c");
    if (!codexWebpackExportRecord(cache) || seenCaches.has(cache)) continue;
    seenCaches.add(cache);
    let keys;
    try {
      keys = Object.getOwnPropertyNames(cache);
    } catch {
      continue;
    }
    result.runtimeCount += 1;
    for (const key of keys) {
      if (inspectedModules >= limits.modules) {
        result.truncated = true;
        break;
      }
      inspectedModules += 1;
      const module = codexWebpackOwnData(cache, key);
      if (!codexWebpackObject(module)) continue;
      let fields;
      try {
        const failure = Object.getOwnPropertyDescriptor(module, "error");
        if (failure && (!("value" in failure) || failure.value !== undefined))
          continue;
        fields = Object.getOwnPropertyDescriptor(module, "exports");
      } catch {
        continue;
      }
      if (!fields || !("value" in fields)) continue;
      result.moduleCount += 1;
      // This is a read-only token for the separately guarded scope.get boundary,
      // not permission to execute an arbitrary export or resolve the atom here.
      // The current Q3tq factory uses Rspack's data-export argument for pN;
      // getter exports and similarly shaped objects in other modules are not it.
      if (key === "Q3tq") {
        const atom = codexWebpackOwnData(fields.value, "pN");
        const scope = codexWebpackOwnData(atom, "scope");
        if (
          codexWebpackObject(atom) &&
          atom !== globalThis &&
          codexWebpackObject(scope) &&
          scope !== globalThis &&
          typeof codexWebpackOwnData(atom, "resolve") === "function"
        )
          visibilityAtoms.add(atom);
      }
      enqueue(fields.value, 0);
    }
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const { value, depth } = candidates[index];
    result.candidateCount += 1;
    if (visibilityAtoms.has(value)) continue;
    const isClient = ["getQueryCache", "getQueryData", "setQueryData"].every(
      (name) => codexDeclaredMethod(value, name),
    );
    if (isClient) clients.add(value);
    const prototype = codexWebpackObserverPrototype(value);
    if (prototype) prototypes.add(prototype);
    const isScope = codexDeclaredDependencyScope(value);
    if (isScope) scopes.add(value);
    // Initialized polyfills can export globalThis/window; app instances can
    // retain arbitrary state too. Only plain export records authorize another
    // data-field edge. A recognized picker object is a leaf, not a new root.
    if (
      isClient ||
      prototype ||
      isScope ||
      depth >= limits.depth ||
      !codexWebpackExportRecord(value)
    )
      continue;
    let keys;
    try {
      keys = Object.getOwnPropertyNames(value);
    } catch {
      continue;
    }
    if (keys.length > limits.properties) result.truncated = true;
    for (
      let field = 0;
      field < Math.min(keys.length, limits.properties);
      field += 1
    ) {
      if (inspectedFields >= limits.fields) {
        result.truncated = true;
        break;
      }
      inspectedFields += 1;
      enqueue(codexWebpackOwnData(value, keys[field]), depth + 1);
    }
  }
  result.nativeReasoningVisibilityAtoms = Array.from(visibilityAtoms);
  result.queryClients = Array.from(clients);
  result.queryObserverPrototypes = Array.from(prototypes);
  result.scopes = Array.from(scopes);
  return result;
};
// The caller snapshots the document's module-script src/type fields. Links,
// performance entries and discovered dependency paths do not establish that an
// entry was already evaluated, so none are accepted as import authorization.
const codexLoadedWebpackEntryUrls = (scripts, baseUrl) => {
  if (!Array.isArray(scripts) || typeof baseUrl !== "string") return [];
  let base;
  try {
    base = new URL(baseUrl);
    if (
      (!base.host && base.protocol !== "file:") ||
      base.username ||
      base.password
    )
      return [];
  } catch {
    return [];
  }
  const urls = new Set();
  const count = Math.min(codexWebpackOwnData(scripts, "length") || 0, 64);
  for (let index = 0; index < count && urls.size < 8; index += 1) {
    const script = codexWebpackOwnData(scripts, String(index));
    const src = codexWebpackOwnData(script, "src");
    if (
      typeof src !== "string" ||
      codexWebpackOwnData(script, "type") !== "module"
    )
      continue;
    try {
      const url = new URL(src, base);
      if (
        url.protocol !== base.protocol ||
        url.host !== base.host ||
        url.origin !== base.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/assets\/\d+\.[a-zA-Z0-9_-]{6,64}\.js$/.test(url.pathname)
      )
        continue;
      urls.add(url.href);
    } catch {}
  }
  return Array.from(urls);
};
