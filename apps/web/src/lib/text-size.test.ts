import { describe, expect, it } from "vitest";
import { createTextSizeStore, type TextSize, type TextSizeEnvironment } from "./text-size.ts";

const environment = (read: () => unknown = () => null) => {
  const writes: TextSize[] = [];
  const marks: TextSize[] = [];
  const env: TextSizeEnvironment = { read, write: (size) => writes.push(size), mark: (size) => marks.push(size) };
  return { env, writes, marks };
};

describe("text size", () => {
  it("starts at Standard when nothing, or something unknown, is saved", () => {
    expect(createTextSizeStore(environment().env).size()).toBe("standard");
    expect(createTextSizeStore(environment(() => "huge").env).size()).toBe("standard");
  });

  it("marks the page with the saved size before anything renders", () => {
    const { env, marks } = environment(() => "larger");
    expect(createTextSizeStore(env).size()).toBe("larger");
    expect(marks).toEqual(["larger"]);
  });

  it("saves a pick, marks the page and tells every listener", () => {
    const { env, writes, marks } = environment();
    const store = createTextSizeStore(env);
    let heard = 0;
    store.subscribe(() => {
      heard++;
    });
    store.set("larger");
    expect(store.size()).toBe("larger");
    expect(writes).toEqual(["larger"]);
    expect(marks).toEqual(["standard", "larger"]);
    expect(heard).toBe(1);
  });

  it("follows a size saved in another window", () => {
    let saved: unknown = null;
    const store = createTextSizeStore(environment(() => saved).env);
    saved = "larger";
    store.storageChanged();
    expect(store.size()).toBe("larger");
  });
});
