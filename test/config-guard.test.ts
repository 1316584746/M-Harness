import { describe, expect, it } from "vitest";
import { lostRepos } from "../desktop/main/config-guard";

const j = (o: unknown) => JSON.stringify(o);

describe("lostRepos", () => {
  it("仓库没少 → 空", () => {
    expect(lostRepos(j({ repos: { a: { path: "x" } } }), j({ repos: { a: { path: "x" }, b: { path: "y" } } }))).toEqual([]);
  });
  it("整个 repos 被抹掉 / 少了一个 → 返回少的那些", () => {
    expect(lostRepos(j({ repos: { a: {}, b: {} } }), j({ providers: {} }))).toEqual(["a", "b"]);
    expect(lostRepos(j({ repos: { a: {}, b: {} } }), j({ repos: { a: {} } }))).toEqual(["b"]);
  });
  it("旧文件本来就没有仓库 / 不是 JSON → 空", () => {
    expect(lostRepos(j({}), j({ repos: {} }))).toEqual([]);
    expect(lostRepos("not json", j({}))).toEqual([]);
  });
  it("带 BOM 也能读", () => {
    expect(lostRepos("\uFEFF" + j({ repos: { a: {} } }), j({}))).toEqual(["a"]);
  });
});
