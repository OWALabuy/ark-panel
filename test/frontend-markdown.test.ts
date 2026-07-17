import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

class FakeNode {
  className = "";
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  title = "";
  private value = "";
  classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); } };
  constructor(readonly tagName: string) {}
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  set textContent(value: string) { this.value = String(value); this.children = []; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
}

test("Markdown math sends only valid delimiters to KaTeX and safely falls back", async t => {
  const previousDocument = (globalThis as Record<string, unknown>).document;
  const previousKatex = (globalThis as Record<string, unknown>).katex;
  const calls: Array<{ formula: string; displayMode: boolean }> = [];
  (globalThis as Record<string, unknown>).document = {
    createElement: (name: string) => new FakeNode(name),
    createTextNode: (value: string) => { const node = new FakeNode("#text"); node.textContent = value; return node; }
  };
  (globalThis as Record<string, unknown>).katex = { render(formula: string, node: FakeNode, options: { displayMode: boolean }) {
    if (formula === "bad{") throw new Error("bad formula");
    calls.push({ formula, displayMode: options.displayMode }); node.classList.add("katex-rendered");
  } };
  t.after(() => { (globalThis as Record<string, unknown>).document = previousDocument; (globalThis as Record<string, unknown>).katex = previousKatex; });

  const moduleUrl = pathToFileURL(join(process.cwd(), "src/frontend/markdown.js")).href;
  const { renderMarkdown } = await import(moduleUrl) as { renderMarkdown(text: string): FakeNode };
  const root = renderMarkdown("价格 $5 and $10；行内 $x^2$、\\(y\\)，代码 `$z$`。\n\n$$\n\\int_0^1 x^2 \\, dx\n$$\n\n\\[\ny=mx+b\n\\]\n\n坏公式 $bad{$");

  assert.deepEqual(calls, [
    { formula: "x^2", displayMode: false },
    { formula: "y", displayMode: false },
    { formula: "\\int_0^1 x^2 \\, dx", displayMode: true },
    { formula: "y=mx+b", displayMode: true }
  ]);
  assert.match(root.textContent, /价格 \$5 and \$10/);
  assert.match(root.textContent, /\$z\$/);
  const failed = root.children.at(-1)?.children.find(node => node.className.includes("math-error"));
  assert.equal(failed?.textContent, "$bad{$");
  assert.equal(failed?.title, "公式渲染失败");
});
