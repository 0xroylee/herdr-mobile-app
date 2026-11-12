import { describe, expect, test } from "bun:test";
import { createAdvertisedRoutes } from "./advertised-routes.ts";

describe("advertised routes", () => {
  test("snapshots the direct route and changes only the secure route", () => {
    const routes = createAdvertisedRoutes({
      direct: "http://127.0.0.1:8790/",
      secure: "https://bridge.example.test",
    });

    expect(routes.snapshot()).toEqual({
      direct: "http://127.0.0.1:8790",
      secure: "https://bridge.example.test",
    });
    routes.setSecure("http://192.168.1.5:9443");
    expect(routes.snapshot()).toEqual({
      direct: "http://127.0.0.1:8790",
      secure: "http://192.168.1.5:9443",
    });
    routes.setSecure(undefined);
    expect(routes.snapshot()).toEqual({ direct: "http://127.0.0.1:8790" });
  });

  test("refuses routes that violate their listener policy", () => {
    expect(() => createAdvertisedRoutes({ direct: "http://192.168.1.5:8790" })).toThrow("loopback");
    expect(() =>
      createAdvertisedRoutes({
        direct: "https://bridge.example.test",
        secure: "http://example.com",
      }),
    ).toThrow("loopback or private-network");
  });
});
