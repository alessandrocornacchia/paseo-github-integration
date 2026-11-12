import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";

import contribute from "../index.server";
import * as board from "../shared/board";
import { displaySettings, promptSettings } from "../shared/settings";

// The contract between this plugin and the daemon, checked without a daemon.
//
// The fake host below is typed as the SDK's own `PluginServerContext`, not as
// a hand-written subset of it, so a Paseo release that adds a required member,
// renames one, or changes a signature the entry relies on fails `npm run
// typecheck` here before it fails at load time on someone's machine. The
// assertions then pin what the entry registers, so a release that changes how
// registration behaves fails `npm test`. Together they are what the Paseo
// compat workflow means by "the plugin still works on this SDK".
//
// `index.client.tsx` is not covered: it imports `react-native`, whose entry is
// Flow source that Node cannot load without the app's bundler.

// The host methods this plugin is allowed to call. A `Pick` rather than the
// whole context: each method stays checked against the SDK's own signature,
// but a release that only *adds* a member (0.15 added `addHook`) is not
// contract drift for a plugin that never calls it. A method left out here
// that the entry starts calling throws at runtime, which fails the suite.
type FakeHost = Pick<
  PluginServerContext,
  "handle" | "registerSettings" | "registerProvider" | "registerUsageSource"
>;

interface Registrations {
  rpcs: Map<string, unknown>;
  settings: string[];
  providers: number;
  usageSources: number;
}

function fakeServer(): { server: PluginServerContext; registered: Registrations } {
  const registered: Registrations = {
    rpcs: new Map(),
    settings: [],
    providers: 0,
    usageSources: 0,
  };
  const host: FakeHost = {
    handle(contract, handler) {
      if (registered.rpcs.has(contract.name)) {
        throw new Error(`${contract.name} registered twice`);
      }
      registered.rpcs.set(contract.name, handler);
    },
    registerSettings(definition) {
      registered.settings.push(definition.id);
      return {
        read: async () => ({ status: "invalid", revision: "0", error: "fake host" }),
        subscribe: () => () => {},
      };
    },
    registerProvider() {
      registered.providers += 1;
    },
    registerUsageSource() {
      registered.usageSources += 1;
    },
  };
  // The one widening cast in the suite, and the point of the fake: every
  // member the entry may touch is implemented above, and any other one is
  // absent so that calling it throws instead of silently succeeding.
  return { server: host as PluginServerContext, registered };
}

function isRpcContract(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "input" in value &&
    "output" in value
  );
}

// Every contract `shared/board` defines, read from the module rather than
// listed again: a new RPC the client can call but the entry never binds is
// exactly the bug this should catch.
const contracts = Object.values<unknown>(board).filter(isRpcContract);

describe("index.server contract", () => {
  it("binds a handler to every RPC contract in shared/board", () => {
    const { server, registered } = fakeServer();
    contribute(server);

    expect(contracts.length).toBeGreaterThan(0);
    expect(new Set(registered.rpcs.keys())).toEqual(new Set(contracts.map((c) => c.name)));
    for (const handler of registered.rpcs.values()) {
      expect(handler).toBeTypeOf("function");
    }
  });

  it("registers both host settings documents", () => {
    const { server, registered } = fakeServer();
    contribute(server);

    expect(new Set(registered.settings)).toEqual(new Set([displaySettings.id, promptSettings.id]));
    expect(registered.settings).toHaveLength(2);
  });

  it("contributes no providers or usage sources, and calls no other host method", () => {
    const { server, registered } = fakeServer();
    // A lifecycle hook or any member outside `FakeHost` would throw here.
    expect(() => contribute(server)).not.toThrow();
    expect(registered.providers).toBe(0);
    expect(registered.usageSources).toBe(0);
  });

  it("returns a cleanup the host can call", () => {
    const { server } = fakeServer();
    const cleanup = contribute(server);

    expect(cleanup).toBeTypeOf("function");
    expect(() => cleanup()).not.toThrow();
  });
});
