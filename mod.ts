// deno-lint-ignore-file

import { assertEquals } from "https://deno.land/std@0.221.0/assert/mod.ts";
import { stub } from "https://deno.land/std@0.221.0/testing/mock.ts";

type ExtractParams<S extends string> = S extends
  `${infer _Start}:${infer Param}/${infer Rest}` ? Param | ExtractParams<Rest>
  : S extends `${infer _Start}:${infer Param}` ? Param
  : never;

type HasAllParams<S extends string, P extends Record<string, unknown>> =
  ExtractParams<S> extends keyof P ? P : never;

function assertHasAllParams(
  endpoint: string,
  params: Record<string, unknown>,
): void {
  const matches = endpoint.match(/:([^\/]*)/g) || [];
  const keys = new Set(matches.map((match) => match.slice(1)));
  const missingParams = Array.from(keys).filter((key) => !(key in params));
  if (missingParams.length > 0) {
    throw new Error(
      `"${missingParams.join(", ")}" not found in endpoint: ${endpoint}`,
    );
  }
}

type ApiParamTransformer<
  Endpoint extends string,
  Param extends Record<string, unknown>,
> = HasAllParams<Endpoint, Param> extends never ? never
  : (param: Param) => Record<keyof Param, string>;

type ApiBodyTransformer<Body> = (body: Body) => BodyInit;

type AbstractApi = {
  param?: (param: any) => Record<string, string>;
  body?: (body: any) => BodyInit;
  response: (response: Response) => Promise<unknown>;
};

type FectherInit<Apis extends Record<string, Record<string, AbstractApi>>> = {
  baseUrl: string | URL;
  api: {
    [E in keyof Apis & string]: {
      [M in keyof Apis[E] & string]: Apis[E][M] extends {
        param?: ApiParamTransformer<E, infer _P>;
        body?: ApiBodyTransformer<infer _B>;
        response: (response: Response) => Promise<infer _R>;
      } ? Apis[E][M]
        : never;
    };
  };
};

export type Fetch<Api extends AbstractApi> = (
  args: {
    [
      K in "param" | "body" as Api[K] extends (args: any) => unknown ? K : never
    ]: Api[K] extends (args: infer T) => unknown ? T : never;
  },
  options?: Omit<RequestInit, "method" | "body"> & {
    client?: Deno.HttpClient;
  },
) => ReturnType<Api["response"]>;

export class Fetcher<Apis extends Record<string, Record<string, AbstractApi>>> {
  private readonly init: FectherInit<Apis>;

  constructor(init: FectherInit<Apis>) {
    this.init = init;
  }

  fetch<
    Endpoint extends keyof Apis & string,
    Method extends keyof Apis[Endpoint] & string,
  >(
    endpoint: Endpoint,
    method: Method,
  ): Fetch<Apis[Endpoint][Method]> {
    const url = new URL(endpoint, this.init.baseUrl);

    return (
      args: {
        param?: Apis[Endpoint][Method]["param"];
        body?: Apis[Endpoint][Method]["body"];
      },
      options = {},
    ) => {
      if (args.param) {
        const param = this.init.api[endpoint][method].param!(args.param);
        assertHasAllParams(endpoint, param);

        Object.entries(param).forEach(([key, value]) => {
          if (url.pathname.includes(`:${key}`)) {
            url.pathname = url.pathname.replace(`:${key}`, value);
          } else {
            url.searchParams.append(key, value);
          }
        });
      } else {
        assertHasAllParams(endpoint, {});
      }

      const body = args.body != null
        ? this.init.api[endpoint][method].body!(args.body)
        : undefined;

      return fetch(url, { ...options, method, body }).then(
        this.init.api[endpoint][method].response,
      ) as ReturnType<Apis[Endpoint][Method]["response"]>;
    };
  }
}

Deno.test("Fetcher test", async () => {
  const api = {
    "/users/:id": {
      GET: {
        param: (param: { id: string; v: number }) => ({
          ...param,
          v: `${param.v}`,
        }),
        response: (response: Response) => response.text(),
      },
      POST: {
        param: (param: { id: string }) => ({ ...param }),
        body: (body: { name: string }) => JSON.stringify(body),
        response: (response: Response) => response.text(),
      },
    },
    "/users/:id/online": {
      GET: {
        param: (param: { id: number }) => ({ id: `${param.id}` }),
        response: (response: Response) =>
          response.text().then((text) => text === "ok"),
      },
    },
  } as const;

  const fetcher = new Fetcher({
    baseUrl: "https://api.example.com",
    api,
  });

  const fetchGetUserOnlineStub = stub(globalThis, "fetch", (url, init) => {
    assertEquals(url, new URL("https://api.example.com/users/1/online"));
    assertEquals(init?.method, "GET");
    return Promise.resolve(new Response("ok"));
  });
  try {
    const res = await fetcher.fetch("/users/:id/online", "GET")({
      param: { id: 1 },
    });
    assertEquals(typeof res, "boolean");
  } finally {
    fetchGetUserOnlineStub.restore();
  }

  const fetchGetUserStub = stub(globalThis, "fetch", (url, init) => {
    assertEquals(url, new URL("https://api.example.com/users/1?v=1"));
    assertEquals(init?.method, "GET");
    return Promise.resolve(new Response("something response"));
  });
  try {
    const res = await fetcher.fetch("/users/:id", "GET")({
      param: { id: "1", v: 1 },
    });
    assertEquals(typeof res, "string");
  } finally {
    fetchGetUserStub.restore();
  }

  const fetchPostUserStub = stub(globalThis, "fetch", (url, init) => {
    assertEquals(url, new URL("https://api.example.com/users/1"));
    assertEquals(init?.method, "POST");
    assertEquals(init?.body, JSON.stringify({ name: "hoge" }));
    return Promise.resolve(new Response("something response"));
  });
  try {
    const res = await fetcher.fetch("/users/:id", "POST")({
      param: { id: "1" },
      body: { name: "hoge" },
    });
    assertEquals(typeof res, "string");
  } finally {
    fetchPostUserStub.restore();
  }
});
