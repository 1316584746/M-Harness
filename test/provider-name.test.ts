import { describe, expect, it } from "vitest";
import { envVarFor } from "../desktop/shared/envvar";
import { parseConfig, ProviderRegistry } from "../src/config";

describe("提供方名称允许中文", () => {
  it("英文名的环境变量名保持原样", () => {
    expect(envVarFor("zhipu", "")).toBe("ZHIPU_API_KEY");
    expect(envVarFor("my-provider.v2", "")).toBe("MY_PROVIDER_V2_API_KEY");
    expect(envVarFor("x", "${FOO_KEY}")).toBe("FOO_KEY");
  });

  it("中文名的环境变量名是合法的英文变量，且不同名字互不相撞", () => {
    const a = envVarFor("智谱", "");
    const b = envVarFor("月之暗面", "");
    expect(a).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    expect(b).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    expect(a).not.toBe(b);
    expect(envVarFor("智谱", "")).toBe(a); // 同一个名字永远得到同一个变量
    expect(envVarFor("智谱GLM", "")).toMatch(/^GLM_[A-Z0-9]+_API_KEY$/);
  });

  it("配置里用中文当提供方名可以正常解析", () => {
    process.env.ZHIPU_TEST_KEY = "sk-test";
    const cfg = parseConfig({
      defaultProvider: "智谱",
      providers: { 智谱: { type: "anthropic", apiKey: "${ZHIPU_TEST_KEY}", model: "glm-5-turbo", baseURL: "https://api.z.ai/api/anthropic" } },
    });
    expect(Object.keys(cfg.providers)).toEqual(["智谱"]);
    expect(new ProviderRegistry(cfg).names()).toContain("智谱");
  });
});
