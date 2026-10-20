import { expect, it } from "vitest";
import { detectDeliveryCapabilities } from "./delivery-capabilities.ts";

it("selects the package when the installation executable is absent", async () => {
  const checked: string[] = [];
  const capabilities = await detectDeliveryCapabilities({
    platform: "linux",
    env: {},
    isFile: async path => { checked.push(path); return false; },
  });

  expect(capabilities).toEqual({ resolve: false, primary: "package" });
  expect(checked).toEqual(["/opt/resolve/bin/resolve", "/opt/resolve/resolve"]);
});

it("selects the Resolve bridge when a fake installation executable is found", async () => {
  const checked: string[] = [];
  const capabilities = await detectDeliveryCapabilities({
    platform: "linux",
    env: {},
    isFile: async path => {
      checked.push(path);
      return path === "/opt/resolve/resolve";
    },
  });

  expect(capabilities).toEqual({ resolve: true, primary: "resolve" });
  expect(checked).toEqual(["/opt/resolve/bin/resolve", "/opt/resolve/resolve"]);
});
