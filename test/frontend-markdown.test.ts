import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

class FakeNode {
  className = "";
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  title = "";
  src = "";
  href = "";
  alt = "";
  loading = "";
  decoding = "";
  referrerPolicy = "";
  target = "";
  rel = "";
  type = "";
  checked = false;
  disabled = false;
  private value = "";
  classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); } };
  constructor(readonly tagName: string) {}
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  set textContent(value: string) { this.value = String(value); this.children = []; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
}

function descendants(root: FakeNode): FakeNode[] {
  return root.children.flatMap(child => [child, ...descendants(child)]);
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

test("Markdown renders dividers, task lists, Rust, and privacy-safe image affordances", async t => {
  const previousDocument = (globalThis as Record<string, unknown>).document;
  const previousLocation = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).document = {
    createElement: (name: string) => new FakeNode(name),
    createTextNode: (value: string) => { const node = new FakeNode("#text"); node.textContent = value; return node; }
  };
  (globalThis as Record<string, unknown>).location = new URL("http://panel.fixture.test:8790/conversations");
  t.after(() => {
    (globalThis as Record<string, unknown>).document = previousDocument;
    (globalThis as Record<string, unknown>).location = previousLocation;
  });

  const moduleUrl = `${pathToFileURL(join(process.cwd(), "src/frontend/markdown.js")).href}?features`;
  const { renderMarkdown } = await import(moduleUrl) as { renderMarkdown(text: string): FakeNode };
  const root = renderMarkdown([
    "上文", "", "---", "", "- [ ] 待办", "- [x] 完成", "",
    "```rust", "fn main() { let ok = true; }", "```", "",
    "![外部示例](https://Images.Example:443/a/../test.png?size=1)", "",
    "![同主机异端口](http://panel.fixture.test:9999/tracker.png)", "",
    "![认证附件](http://panel.fixture.test:8790/api/v1/files/fixture-image/preview)", "",
    "![空查询分隔符](http://panel.fixture.test:8790/api/v1/files/fixture-image/preview?)", "",
    "![空片段分隔符](http://panel.fixture.test:8790/api/v1/files/fixture-image/preview#)", "",
    "![空查询片段分隔符](http://panel.fixture.test:8790/api/v1/files/fixture-image/preview?#)", "",
    "![任意同源](http://panel.fixture.test:8790/api/private.png)", "",
    "![相对地址](/api/v1/files/fixture-image/preview)", "",
    "![本地文件](file:///etc/passwd)", "",
    "![内联数据](data:image/png;base64,AAAA)", "",
    "![Blob](blob:http://panel.fixture.test:8790/id)", "",
    "![用户信息](https://user:password@other.fixture.test/image.png)", "",
    "![脚本](javascript:alert(1))"
  ].join("\n"));

  assert.equal(root.children.some(node => node.tagName === "hr"), true);
  const taskList = root.children.find(node => node.className.includes("task-list"));
  assert.equal(taskList?.children[0]?.children[0]?.checked, false);
  assert.equal(taskList?.children[1]?.children[0]?.checked, true);
  assert.equal(taskList?.children[0]?.children[0]?.disabled, true);
  const code = root.children.flatMap(node => node.children).flatMap(node => node.children).find(node => node.dataset.language === "rust");
  assert.equal(code?.textContent, "fn main() { let ok = true; }");

  const nodes = descendants(root), images = nodes.filter(node => node.tagName === "img");
  assert.equal(images.length, 1);
  assert.equal(images[0]?.src, "http://panel.fixture.test:8790/api/v1/files/fixture-image/preview");
  assert.equal(images[0]?.referrerPolicy, "no-referrer");

  const links = nodes.filter(node => node.tagName === "a");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.href, "https://images.example/test.png?size=1");
  assert.equal(links[0]?.target, "_blank");
  assert.equal(links[0]?.rel, "noopener noreferrer");
  assert.equal(links[0]?.referrerPolicy, "no-referrer");
  assert.equal(links[0]?.textContent, "打开外部图片");
  assert.match(root.textContent, /外部示例/);
  assert.match(root.textContent, /https:\/\/images\.example/);
  assert.match(root.textContent, /同主机异端口/);
  assert.match(root.textContent, /http:\/\/panel\.fixture\.test:9999/);
  assert.match(root.textContent, /!\[空查询分隔符\]\(http:\/\/panel\.fixture\.test:8790\/api\/v1\/files\/fixture-image\/preview\?\)/);
  assert.match(root.textContent, /!\[空片段分隔符\]\(http:\/\/panel\.fixture\.test:8790\/api\/v1\/files\/fixture-image\/preview#\)/);
  assert.match(root.textContent, /!\[空查询片段分隔符\]\(http:\/\/panel\.fixture\.test:8790\/api\/v1\/files\/fixture-image\/preview\?#\)/);
  assert.match(root.textContent, /!\[任意同源\]\(http:\/\/panel\.fixture\.test:8790\/api\/private\.png\)/);
  assert.match(root.textContent, /!\[相对地址\]\(\/api\/v1\/files\/fixture-image\/preview\)/);
  assert.match(root.textContent, /!\[本地文件\]\(file:\/\/\/etc\/passwd\)/);
  assert.match(root.textContent, /!\[内联数据\]\(data:image\/png;base64,AAAA\)/);
  assert.match(root.textContent, /!\[Blob\]\(blob:http:\/\/panel\.fixture\.test:8790\/id\)/);
  assert.match(root.textContent, /!\[用户信息\]\(https:\/\/user:password@other\.fixture\.test\/image\.png\)/);
  assert.match(root.textContent, /!\[脚本\]\(javascript:alert\(1\)\)/);
});
