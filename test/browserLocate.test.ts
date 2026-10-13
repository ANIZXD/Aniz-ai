import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pickBrowser } from "../src/tools/browserLocate.ts";

const WIN_ENV = {
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
};

const EDGE_X86 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME_PF = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

describe("browser location", () => {
  test("prefers Playwright's own Chromium when it is present", () => {
    const choice = pickBrowser({
      bundled: true,
      platform: "win32",
      env: WIN_ENV,
      fileExists: () => true,
    });

    assert.deepEqual(choice, { channel: null, label: "its bundled Chromium" });
  });

  test("falls back to the system Edge on Windows without downloading anything", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "win32",
      env: WIN_ENV,
      fileExists: (candidate) => candidate === EDGE_X86,
    });

    assert.equal(choice?.channel, "msedge");
    assert.match(choice?.label ?? "", /Microsoft Edge/);
  });

  test("falls back to Chrome when Edge is absent", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "win32",
      env: WIN_ENV,
      fileExists: (candidate) => candidate === CHROME_PF,
    });

    assert.equal(choice?.channel, "chrome");
  });

  test("prefers Edge over Chrome when both are installed", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "win32",
      env: WIN_ENV,
      fileExists: () => true,
    });

    assert.equal(choice?.channel, "msedge");
  });

  test("returns null when no browser exists at all", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "win32",
      env: WIN_ENV,
      fileExists: () => false,
    });

    assert.equal(choice, null);
  });

  test("tolerates an environment without the install variables", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "win32",
      env: {},
      fileExists: () => true,
    });

    assert.equal(choice, null);
  });

  test("looks in the expected macOS application paths", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "darwin",
      env: {},
      fileExists: (candidate) => candidate === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });

    assert.equal(choice?.channel, "chrome");
  });

  test("looks in the expected Linux binary paths", () => {
    const choice = pickBrowser({
      bundled: false,
      platform: "linux",
      env: {},
      fileExists: (candidate) => candidate === "/usr/bin/microsoft-edge",
    });

    assert.equal(choice?.channel, "msedge");
  });
});
