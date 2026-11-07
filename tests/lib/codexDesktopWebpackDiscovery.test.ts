import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const resource = (name: string) =>
  path.resolve(process.cwd(), "src-tauri/src/resources/codex_desktop", name);
const discovery = readFileSync(resource("client_discovery.js"), "utf8");
const webpack = existsSync(resource("webpack_discovery.js"))
  ? readFileSync(resource("webpack_discovery.js"), "utf8")
  : "";

type PickerCandidates = {
  nativeReasoningVisibilityRequired: boolean;
  nativeReasoningVisibilityAtoms: object[];
  queryClients: QueryClient[];
  queryObserverPrototypes: object[];
  scopes: object[];
  runtimeCount: number;
  moduleCount: number;
  candidateCount: number;
  truncated: boolean;
};
type Api = {
  candidates: (namespaces: unknown) => PickerCandidates;
  entryUrls: (scripts: unknown, baseUrl: string) => string[];
};
const api = new Function(
  `${discovery}\n${webpack}\nreturn {
    candidates: typeof codexInitializedWebpackPickerCandidates === "function"
      ? codexInitializedWebpackPickerCandidates
      : () => ({ queryClients: [], queryObserverPrototypes: [], scopes: [], runtimeCount: 0, moduleCount: 0, candidateCount: 0, truncated: false }),
    entryUrls: typeof codexLoadedWebpackEntryUrls === "function"
      ? codexLoadedWebpackEntryUrls : () => [],
  };`,
)() as Api;

const runtime = (cache: object) => {
  const require = vi.fn(() => {
    throw new Error("module factories must never run during discovery");
  });
  return Object.assign(require, { c: cache, m: { uninitialized: vi.fn() } });
};
const namespace = (cache: object) => ({ __webpack_require__: runtime(cache) });
const scope = (client: QueryClient) => ({
  chain: {},
  node: {},
  get: vi.fn(),
  set: vi.fn(),
  watch: vi.fn(),
  queryClient: client,
});

describe("Codex Desktop initialized numeric Webpack discovery", () => {
  it("discovers initialized own-data picker clients, observer constructors, and scopes without invoking the runtime", () => {
    const client = new QueryClient();
    const currentScope = scope(client);
    const ns = namespace({
      client: { exports: { liveClient: client } },
      observer: { exports: QueryObserver },
      dependency: { exports: { currentScope } },
    });
    try {
      expect(api.candidates(ns)).toMatchObject({
        queryClients: [client],
        queryObserverPrototypes: [QueryObserver.prototype],
        scopes: [currentScope],
        runtimeCount: 1,
        moduleCount: 3,
        truncated: false,
      });
      expect(ns.__webpack_require__).not.toHaveBeenCalled();
      expect(ns.__webpack_require__.m.uninitialized).not.toHaveBeenCalled();
      expect(currentScope.get).not.toHaveBeenCalled();
      expect(currentScope.set).not.toHaveBeenCalled();
      expect(currentScope.watch).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("accepts the explicitly exported runtime from a real ESM namespace", async () => {
    const client = new QueryClient();
    const sourceUrl = `data:text/javascript,export function __webpack_require__(){throw new Error('must not execute')}\n__webpack_require__.c={};`;
    const ns = await import(/* @vite-ignore */ sourceUrl);
    try {
      ns.__webpack_require__.c.live = { exports: client };
      expect(api.candidates(ns).queryClients).toEqual([client]);
    } finally {
      delete ns.__webpack_require__.c.live;
      client.clear();
    }
  });

  it("finds bounded nested data exports and an existing observer instance without constructing another one", () => {
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ["models", "list", "local", "chatgpt", 100],
      enabled: false,
    });
    const getQueryCache = vi.spyOn(client, "getQueryCache");
    try {
      const result = api.candidates(
        namespace({ live: { exports: { nested: { client, observer } } } }),
      );
      expect(result.queryClients).toEqual([client]);
      expect(result.queryObserverPrototypes).toEqual([QueryObserver.prototype]);
      expect(getQueryCache).not.toHaveBeenCalled();
    } finally {
      getQueryCache.mockRestore();
      observer.destroy();
      client.clear();
    }
  });

  it("does not treat initialized request clients as continuation authority", () => {
    const requestClient = {
      sendRequest: vi.fn(),
      getCompatibleThreadSortKey: vi.fn(),
      supportsPaginatedThreadHistory: vi.fn(),
    };
    const result = api.candidates(
      namespace({ request: { exports: requestClient } }),
    );
    expect(result.runtimeCount).toBe(1);
    expect(result.queryClients).toEqual([]);
    expect(result.queryObserverPrototypes).toEqual([]);
    expect(result).not.toHaveProperty("requestClients");
    expect(requestClient.sendRequest).not.toHaveBeenCalled();
  });

  it("never executes getters on namespaces, runtime caches, modules, exports, or scopes", () => {
    const client = new QueryClient();
    const getter = vi.fn(() => {
      throw new Error("discovery getter must not run");
    });
    const liveScope = Object.defineProperty(
      { chain: {}, node: {}, get() {}, set() {}, watch() {} },
      "queryClient",
      { get: getter },
    );
    const exports = Object.defineProperty({ client, liveScope }, "hidden", {
      get: getter,
      enumerable: true,
    });
    const cache = Object.defineProperty({ live: { exports } }, "getterModule", {
      get: getter,
      enumerable: true,
    });
    const badModule = Object.defineProperty({}, "exports", { get: getter });
    const badRuntime = Object.defineProperty(() => {}, "c", { get: getter });
    const badNamespace = Object.defineProperty({}, "__webpack_require__", {
      get: getter,
    });
    try {
      const result = api.candidates([
        badNamespace,
        { __webpack_require__: badRuntime },
        namespace({ badModule }),
        namespace(cache),
      ]);
      expect(result.queryClients).toEqual([client]);
      expect(result.scopes).toEqual([liveScope]);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("does not enumerate or execute factory tables or uninitialized modules", () => {
    const getter = vi.fn(() => {
      throw new Error("factory table must not be inspected");
    });
    const factory = vi.fn();
    const require = Object.defineProperty(vi.fn(), "m", { get: getter });
    Object.defineProperty(require, "c", {
      value: { initialized: { exports: {} } },
    });
    const result = api.candidates({
      __webpack_require__: require,
      __webpack_modules__: { uninitialized: factory },
    });
    expect(result.runtimeCount).toBe(1);
    expect(result.moduleCount).toBe(1);
    expect(require).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("skips failed modules and malformed or inherited runtime/cache/export fields", () => {
    const client = new QueryClient();
    try {
      const inheritedCache = Object.create({
        c: { inherited: { exports: client } },
      });
      const result = api.candidates([
        Object.create(namespace({ inherited: { exports: client } })),
        { __webpack_require__: inheritedCache },
        { __webpack_require__: Object.assign(() => {}, { c: null }) },
        namespace({
          failed: { error: new Error("redacted"), exports: client },
          inherited: Object.create({ exports: client }),
          empty: {},
        }),
      ]);
      expect(result.runtimeCount).toBe(1);
      expect(result.queryClients).toEqual([]);
      expect(result.moduleCount).toBe(0);
    } finally {
      client.clear();
    }
  });

  it("fails closed on throwing proxy traps without preventing a later valid runtime", () => {
    const client = new QueryClient();
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("redacted descriptor trap");
        },
        ownKeys() {
          throw new Error("redacted key trap");
        },
      },
    );
    try {
      const result = api.candidates([
        hostile,
        namespace(hostile),
        namespace({ live: { exports: { hostile, client } } }),
      ]);
      expect(result.queryClients).toEqual([client]);
    } finally {
      client.clear();
    }
  });

  it("deduplicates runtimes, shared caches, cyclic exports, clients, and observer prototypes", () => {
    const client = new QueryClient();
    const cyclic: Record<string, unknown> = { client, QueryObserver };
    cyclic.self = cyclic;
    const ns = namespace({
      one: { exports: cyclic },
      two: { exports: cyclic },
    });
    const duplicateCacheRuntime = {
      __webpack_require__: runtime(ns.__webpack_require__.c),
    };
    try {
      const result = api.candidates([ns, ns, duplicateCacheRuntime]);
      expect(result.queryClients).toEqual([client]);
      expect(result.queryObserverPrototypes).toEqual([QueryObserver.prototype]);
      expect(result.runtimeCount).toBe(1);
      expect(result.moduleCount).toBe(2);
      expect(result.candidateCount).toBeLessThan(30);
    } finally {
      client.clear();
    }
  });

  it("rediscovers runtime replacements, cache replacements, and modules initialized after an empty scan", () => {
    const first = new QueryClient();
    const second = new QueryClient();
    const ns = namespace({});
    try {
      expect(api.candidates(ns).queryClients).toEqual([]);
      Object.assign(ns.__webpack_require__.c, { first: { exports: first } });
      expect(api.candidates(ns).queryClients).toEqual([first]);
      ns.__webpack_require__.c = { second: { exports: second } };
      expect(api.candidates(ns).queryClients).toEqual([second]);
      ns.__webpack_require__ = runtime({ first: { exports: first } });
      expect(api.candidates(ns).queryClients).toEqual([first]);
    } finally {
      first.clear();
      second.clear();
    }
  });

  it("does not leave export records to enumerate browser globals, host objects, prototypes, or recognized clients", () => {
    const client = new QueryClient();
    class HostObject {
      nested = { client };
    }
    const host = new HostObject();
    const prototype = { nested: { client } };
    function ApplicationClass() {}
    ApplicationClass.prototype = prototype;
    Object.defineProperty(prototype, "constructor", {
      value: ApplicationClass,
    });
    const getNames = vi.spyOn(Object, "getOwnPropertyNames");
    try {
      const result = api.candidates(
        namespace({
          globalPolyfill: { exports: globalThis },
          host: { exports: host },
          prototype: { exports: prototype },
        }),
      );
      expect(result.queryClients).toEqual([]);
      expect(
        getNames.mock.calls.some(
          ([value]) =>
            value === globalThis || value === host || value === prototype,
        ),
      ).toBe(false);
      getNames.mockClear();
      expect(
        api.candidates(namespace({ client: { exports: client } })).queryClients,
      ).toEqual([client]);
      expect(getNames.mock.calls.some(([value]) => value === client)).toBe(
        false,
      );
    } finally {
      getNames.mockRestore();
      client.clear();
    }
  });

  it("does not enumerate a malformed runtime cache that is a browser global or host object", () => {
    class HostCache {
      initialized = { exports: {} };
    }
    const host = new HostCache();
    const getNames = vi.spyOn(Object, "getOwnPropertyNames");
    try {
      const result = api.candidates([namespace(globalThis), namespace(host)]);
      expect(result.runtimeCount).toBe(0);
      expect(
        getNames.mock.calls.some(
          ([value]) => value === globalThis || value === host,
        ),
      ).toBe(false);
    } finally {
      getNames.mockRestore();
    }
  });

  it("requires downstream native visibility proof for every detected runtime, even when no atom is initialized", () => {
    const result = api.candidates(namespace({}));
    expect(result.nativeReasoningVisibilityRequired).toBe(true);
    expect(result.nativeReasoningVisibilityAtoms).toEqual([]);
    expect(
      api.candidates(namespace(globalThis)).nativeReasoningVisibilityRequired,
    ).toBe(true);
    expect(api.candidates({}).nativeReasoningVisibilityRequired).toBe(false);
  });

  it("extracts only the exact initialized Q3tq own-data pN atom without resolving it", () => {
    const resolve = vi.fn(() => {
      throw new Error("atom resolution belongs to the explicit read boundary");
    });
    const atom = { scope: {}, resolve, cache: "cached" };
    const result = api.candidates(
      namespace({ Q3tq: { exports: { pN: atom } } }),
    );
    expect(result.nativeReasoningVisibilityRequired).toBe(true);
    expect(result.nativeReasoningVisibilityAtoms).toEqual([atom]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects getter, inherited, malformed, and differently named native visibility bindings", () => {
    const getter = vi.fn(() => {
      throw new Error("atom getter must not run");
    });
    const valid = { scope: {}, resolve() {} };
    const cases = [
      { other: { exports: { pN: valid } } },
      { Q3tq: { exports: { other: valid } } },
      { Q3tq: { exports: Object.create({ pN: valid }) } },
      { Q3tq: { exports: Object.defineProperty({}, "pN", { get: getter }) } },
      { Q3tq: { exports: { pN: Object.create(valid) } } },
      { Q3tq: { exports: { pN: { scope: null, resolve() {} } } } },
      {
        Q3tq: {
          exports: {
            pN: Object.defineProperty({ resolve() {} }, "scope", {
              get: getter,
            }),
          },
        },
      },
      {
        Q3tq: {
          exports: {
            pN: Object.defineProperty({ scope: {} }, "resolve", {
              get: getter,
            }),
          },
        },
      },
      {
        Q3tq: {
          exports: {
            pN: Object.assign(Object.create({ resolve() {} }), { scope: {} }),
          },
        },
      },
      {
        Q3tq: {
          exports: { pN: valid },
          error: new Error("redacted failed module"),
        },
      },
    ];
    for (const cache of cases) {
      expect(
        api.candidates(namespace(cache)).nativeReasoningVisibilityAtoms,
      ).toEqual([]);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("deduplicates native atoms but rediscovers replaced data bindings instead of permanently retaining them", () => {
    const first = { scope: {}, resolve() {} };
    const second = { scope: {}, resolve() {} };
    const exports = { pN: first };
    const ns = namespace({ Q3tq: { exports } });
    expect(
      api.candidates([ns, namespace({ Q3tq: { exports } })])
        .nativeReasoningVisibilityAtoms,
    ).toEqual([first]);
    exports.pN = second;
    expect(api.candidates(ns).nativeReasoningVisibilityAtoms).toEqual([second]);
    expect(
      api.candidates(namespace({})).nativeReasoningVisibilityAtoms,
    ).toEqual([]);
  });

  it("caps namespace and candidate breadth without reading accessor array slots", () => {
    const getter = vi.fn(() => {
      throw new Error("array getter must not run");
    });
    const namespaces = [namespace({})];
    Object.defineProperty(namespaces, "1", { get: getter });
    expect(api.candidates(namespaces).runtimeCount).toBe(1);
    expect(getter).not.toHaveBeenCalled();
    const manyNamespaces = Array.from({ length: 20 }, () => namespace({}));
    const limitedNamespaces = api.candidates(manyNamespaces);
    expect(limitedNamespaces.runtimeCount).toBeGreaterThan(0);
    expect(limitedNamespaces.runtimeCount).toBeLessThan(20);
    expect(limitedNamespaces.truncated).toBe(true);
    const cache = Object.fromEntries(
      Array.from({ length: 1_200 }, (_, index) => [
        String(index),
        {
          exports: Object.fromEntries(
            Array.from({ length: 40 }, (_, field) => [String(field), {}]),
          ),
        },
      ]),
    );
    const broad = api.candidates(namespace(cache));
    expect(broad.moduleCount).toBe(1_200);
    expect(broad.candidateCount).toBeGreaterThan(1_200);
    expect(broad.candidateCount).toBeLessThan(48_000);
    expect(broad.truncated).toBe(true);
  });

  it("caps initialized modules, candidate traversal, depth, and property width", () => {
    const client = new QueryClient();
    const tooDeep = { next: { next: { next: { client } } } };
    const cache = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, index) => [
        String(index),
        { exports: {} },
      ]),
    );
    try {
      const result = api.candidates(namespace(cache));
      expect(result.runtimeCount).toBe(1);
      expect(result.moduleCount).toBeGreaterThan(0);
      expect(result.moduleCount).toBeLessThan(20_000);
      expect(result.truncated).toBe(true);
      expect(
        api.candidates(namespace({ deep: { exports: tooDeep } })).queryClients,
      ).toEqual([]);
      const wide = Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [`field${index}`, {}]),
      );
      wide.last = client;
      const width = api.candidates(namespace({ wide: { exports: wide } }));
      expect(width.queryClients).toEqual([]);
      expect(width.truncated).toBe(true);
    } finally {
      client.clear();
    }
  });
});

describe("Codex Desktop already-loaded numeric entry selection", () => {
  const baseUrl = "https://codex.example/webview/index.html";
  const script = (src: string, type = "module") => ({ src, type });

  it("selects current same-origin numeric module entries without hardcoding an installed build hash", () => {
    expect(
      api.entryUrls(
        [
          script("/assets/348410.ae8bb87271.js"),
          script("/assets/357055.66646607e6.js"),
          script("/assets/348410.ae8bb87271.js"),
        ],
        baseUrl,
      ),
    ).toEqual([
      "https://codex.example/assets/348410.ae8bb87271.js",
      "https://codex.example/assets/357055.66646607e6.js",
    ]);
  });

  it("does not import arbitrary resources, async chunks, old semantic bundles, or non-module scripts", () => {
    expect(
      api.entryUrls(
        [
          script("https://outside.example/assets/348410.ae8bb87271.js"),
          script("/assets/async/24191.589dcc9878.js"),
          script("/assets/app-shared-hash.js"),
          script("/assets/348410.ae8bb87271.js", "text/javascript"),
          script("/assets/348410.ae8bb87271.js?fresh=1"),
          script("/assets/348410.ae8bb87271.js#fragment"),
          script("javascript:alert(1)"),
          script("data:text/javascript,export default 1"),
        ],
        baseUrl,
      ),
    ).toEqual([]);
  });

  it("never reads getter-based or inherited script fields and fails closed on malformed input", () => {
    const getter = vi.fn(() => "/assets/348410.ae8bb87271.js");
    const withGetter = Object.defineProperty({ type: "module" }, "src", {
      get: getter,
    });
    expect(
      api.entryUrls(
        [
          withGetter,
          Object.create(script("/assets/348410.ae8bb87271.js")),
          null,
          {},
        ],
        baseUrl,
      ),
    ).toEqual([]);
    expect(api.entryUrls(null, baseUrl)).toEqual([]);
    expect(api.entryUrls([], "not a URL")).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("compares custom app-scheme hosts rather than treating all null origins as the same origin", () => {
    expect(
      api.entryUrls(
        [
          script("codex://app/assets/348410.ae8bb87271.js"),
          script("codex://outside/assets/357055.66646607e6.js"),
          script("other://app/assets/357055.66646607e6.js"),
          script(
            "https://user:secret@codex.example/assets/357055.66646607e6.js",
          ),
        ],
        "codex://app/index.html",
      ),
    ).toEqual(["codex://app/assets/348410.ae8bb87271.js"]);
    expect(
      api.entryUrls(
        [script("/assets/348410.ae8bb87271.js")],
        "data:/index.html",
      ),
    ).toEqual([]);
  });

  it("caps entry URL selection", () => {
    const result = api.entryUrls(
      Array.from({ length: 30 }, (_, index) =>
        script(`/assets/${100000 + index}.abcdef0123.js`),
      ),
      baseUrl,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(30);
  });
});
