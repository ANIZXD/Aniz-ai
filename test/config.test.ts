import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeConfig, loadConfig } from "../src/config.ts";

/** Runs `run` with the given env vars set, restoring them afterwards. */
function withEnv(vars: Record<string, string>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("ollama conversation settings", () => {
  test("defaults to a stop list that cuts the canned closers", () => {
    const stops = loadConfig().ollama.stop;
    assert.ok(stops.length > 0);
    assert.ok(stops.includes("Let me know"));
    assert.ok(stops.includes("How may I assist"));
  });

  test("accepts a custom comma-separated stop list", () => {
    withEnv({ OLLAMA_STOP: "Stop here, And here " }, () => {
      assert.deepEqual(loadConfig().ollama.stop, ["Stop here", "And here"]);
    });
  });

  test("disables the stop list when set to none", () => {
    withEnv({ OLLAMA_STOP: "none" }, () => {
      assert.deepEqual(loadConfig().ollama.stop, []);
    });
  });

  test("thinks by default and can be turned off", () => {
    assert.equal(loadConfig().ollama.think, false);
    withEnv({ OLLAMA_THINK: "true" }, () => {
      assert.equal(loadConfig().ollama.think, true);
    });
  });

  test("keeps the model's own replies so it can follow the thread", () => {
    assert.equal(loadConfig().chatHistory, "full");
    withEnv({ CHAT_HISTORY: "user" }, () => {
      assert.equal(loadConfig().chatHistory, "user");
    });
  });

  test("falls back to the default for an unknown history mode", () => {
    withEnv({ CHAT_HISTORY: "everything" }, () => {
      assert.equal(loadConfig().chatHistory, "full");
    });
  });

  test("falls back to defaults for out-of-range sampling values", () => {
    withEnv({ OLLAMA_TEMPERATURE: "99", OLLAMA_TOP_P: "-1" }, () => {
      const { ollama } = loadConfig();
      assert.equal(ollama.temperature, 0.8);
      assert.equal(ollama.topP, 0.95);
    });
  });

  test("reports the sampling settings without leaking a secret", () => {
    withEnv({ LLM_API_KEY: "super-secret" }, () => {
      const described = describeConfig(loadConfig());
      const text = JSON.stringify(described);
      assert.ok(!text.includes("super-secret"));
      assert.match(text, /"stopCount":\d+/);
    });
  });
});
