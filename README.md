# dsh-pdf-formula — PDF 公式识别

给 DeepSeek Harness 的 Agent 用的**纯主机端（Host-only）**插件：读取 PDF 自带的文本层与字形轮廓，把论文里的
公式还原成 LaTeX，同时提供页面文本、页面尺寸与字体的体检信息。没有界面，不注入任何客户端代码。

- 包名：`dsh-pdf-formula`，插件名 `pdf-formula`
- 依赖：**无**（识别引擎只使用 Node 内置模块）
- 权限：`inject: ['tools']`，只注册三个 Agent 工具

## 三个工具

### `pdf_info`

先体检，再决定怎么读。返回页数、每页尺寸（pt）、每页字体表（`baseFont` / `subtype` / `embedded`），以及某页
是否**看起来是扫描页**（没有文本层、只有图像）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | PDF 路径。绝对路径，或相对**会话工作区**（`exec.agent.session.header.cwd`，即当前会话的 cwd） |

返回：`{ ok, file, pageCount, pages: [{ page, width, height, rotation, scanned, glyphCount, imageCount, fonts: [...] }], scannedPages?, note? }`

### `pdf_extract_text`

按页取文本，行内与行间的展示公式直接渲染成 LaTeX；每页同时给出纯文本与 markdown 两种形态。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | string | — | 必填，同上 |
| `pages` | string | `"all"` | 页选择，如 `"1-5,9"`；从 1 开始，闭区间 |
| `mode` | `"text"` \| `"markdown"` | `"markdown"` | markdown 保留标题与公式块；text 为纯阅读顺序 |
| `formulas` | boolean | `true` | 是否把展示公式渲染为 LaTeX；设为 false 更快 |

返回：`{ ok, file, mode, formulas, pageCount, pages: [{ page, text, markdown, formulas, glyphCount, uncertain: [...] }], note? }`

### `pdf_extract_formulas`

只抽公式：每条给出 LaTeX、页码、整体置信度，以及**没能确定的低置信度符号**。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | string | — | 必填，同上 |
| `pages` | string | `"all"` | 页选择，如 `"1-5,9"`，也可为 `"all"` |
| `minConfidence` | number | `0.5` | 低于该 0..1 置信度的公式被丢弃 |
| `includeUncertain` | boolean | `true` | 保留含未解析符号的公式，并把符号列出来 |
| `format` | `"latex"` \| `"json"` | `"latex"` | latex 返回公式清单；json 附带完整结构化记录 |

返回：`{ ok, file, format, minConfidence, includeUncertain, pageCount, formulaCount, pages: [{ page, formulas: [{ index, latex, confidence, display, glyphCount, uncertain: [{ symbol, code, confidence, source }] }] }], note? }`

三个工具都只返回**可 JSON 序列化的普通对象**；出错时返回 `{ ok: false, error: "..." }` 而**不抛异常**，Agent
可以在一次会话里继续换页或换文件重试。

## 公式识别是怎么做的

1. **不走名字，走形状。** 论文 PDF 多用子集化的 CFF/Type1 字体，字形名被改写成 `g12`、`cid37` 之类，而且常常
   没有 `/ToUnicode` 映射。引擎因此按证据强弱依次尝试：`/ToUnicode` → simple font 的 `/Encoding /Differences`
   → 标准 14 字体的内置编码 → **把字形轮廓栅格化后与系统数学字体的模板做形状匹配**（`lib/templates.mjs`、
   `lib/raster.mjs`、`lib/font.mjs`）。
2. **还原二维结构。** 只有字符还不够：分式、根号、上下标、大运算符、矩阵靠的是位置关系。引擎在设备空间里
   重新解释内容流（CTM/文本矩阵），拿到每个字形的精确包围盒，再找分数线、根号横杠等规则线，分组后组装成
   LaTeX（`lib/structure.mjs`、`lib/content.mjs`）。
3. **逐页输出。** `pdfInfo` / `extractText` / `extractFormulas` 三个入口都在 `lib/extract.mjs`，插件的
   `index.js` 用动态 `import()` 调用它们，因此识别引擎即使暂时不可用也不会影响插件加载。

## 置信度

每个字符都带 `confidence`（0..1）与来源 `source`：

- `tounicode` — 1.0，PDF 自带映射，最可靠
- `differences` — 0.97，字形名可解释
- `standard-encoding` — 0.9 / 0.85，标准 14 字体的内置编码
- `shape` — 形状匹配，由重叠度与「与第二名模板的差距」共同决定，上限 0.95

公式的 `confidence` 是其字符置信度的平均；低于 `minConfidence`（默认 0.5）的字符会进入 `uncertain` 列表，
把「这里可能认错了」明确交给模型判断，而不是悄悄给一个看似正确的符号。`note` 字段会汇总整页的未确定符号数。

## 已知限制

- **扫描件不 OCR。** 没有任何文本层（纯图片）的页面抽不出公式与文字；`pdf_info` 会把这类页面标记为
  `scanned: true` 并列入 `scannedPages`，此时请改用 OCR 工具，本插件不会去猜像素。
- **单符号可能被近形字误判。** 形状匹配对「同一个字形的不同字符变体」做了族归一（例如各种花体 A 都归为
  `A`），但少数近形符号仍可能认错——实测本仓库样张里一个根号被认成了 `∨`。这类字符会带上偏低的
  `confidence` 并出现在 `uncertain` / `uncertainSymbols` 里，请以它为准复核，不要默认每个符号都对。
- **公式的完整性是逐页渐进的。** 分式、上下标、大运算符能正确组装；横跨多行的长公式偶尔会被拆成
  两段，或把紧跟其后的正文/图注并进来。遇到可疑结果建议同时用 `pdf_extract_text`（纯文本兜底）
  和 `pdf_extract_formulas` 对照。
- **生僻字体会退化为低置信度。** 非嵌入字体、异常的 Type3 字体，或形状与常见数学字体差异较大的字面，
  匹配分数会下降，符号会以 `uncertain` 报出，而不是被强行替换。
- **不做版面重建。** 多栏排版按栏内阅读顺序输出，不还原图表位置；表格与图注里的零散符号不单独成条。

## 安装与启用

这是一个 bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 只做一条 insert：

```yaml
- insert:
    - id: pdf-formula
      name: 'dsh-pdf-formula'
      config: {}
```

在 Harness 里用 `plugin_manager` 的 `install_bundle` 指向本目录即可安装。安装后用
`cordis_inspect_query` 的 `Tool.listTools` 确认三个工具已注册，或查看 `Config.listConfigs`
（`name` 填 `dsh-pdf-formula`）里的条目。

> **工具不出现时，先看宿主终端里的 `pdf-formula:` 警告。** 曾经的失败原因不是 `Config`，而是
> `candidates()` 里对 `ctx.tool` 的裸属性访问：Cordis 4 对**未在 `inject` 中声明的服务**做属性访问
> 会直接抛错（`cannot get property "tool" without inject`），而 `apply()` 的 try/catch 把它吞成了
> 一条 `ctx.logger.warn`——插件于是显示为 ACTIVE，却一个工具都没注册。现在该服务改经
> `ctx.get('tool')` 读取（未声明/不存在时返回 undefined，不抛错）。
>
> 排查同类问题时：宿主里用 `--dump-config` 只能证明这一行进了组合树，**不能**证明它注册成功；
> 真正的证据是会话日志 `request/header` 里的工具表（宿主发给模型的目录），或设置 →「插件」→
> 「插件列表」里每个条目的运行时状态（active / pending / failed）。
>
> **路径类参数必须让 `exec` 传进来。** 宿主把每次调用的上下文作为 **`execute(args, exec)` 的第二个实参**
> 传入：`exec.agent.session.header.cwd` 是会话工作区（相对路径的锚点），`exec.signal` 是取消信号。
> 任何包装层只要把 `execute` 写成 `(args) => …`，就会把 `exec` 悄悄吃掉——本插件的 `makeRun` 曾正犯
> 此错，于是相对路径永远退回 `process.cwd()`（= 启动 `dsh web` 的目录，通常不是工作区）。
> 验证这类问题时，探针进程的 `process.cwd()` **必须刻意设成与工作区不同**，否则两个分支会给出同一个
> 路径，测试看起来通过、其实什么都没验证。
>
> **改动 `index.js` 后必须重启 `dsh web` 进程。** 本 profile 的 `hmr` 行 `root: []`，不监视插件模块，
> 所以只刷新浏览器页面或重新开关 bundle 都不会换掉进程里已缓存的旧模块。

**为什么没有可配置项：** 本插件**刻意不导出 `Config`**。Cordis 通过 schemastery 解析插件的
配置模式（`Config.validate`），导出一个普通 JSON Schema 对象会让激活直接失败
（`TypeError: Cannot read properties of undefined (reading 'validate')`）。所有可调参数都是
工具自己的实参并自带默认值，所以「零配置」既是设计也是避免该类激活故障的做法。

---

## English summary

`dsh-pdf-formula` is a Host-only DeepSeek Harness bundle with no runtime dependencies. It registers three
agent tools over the injected `tools` service:

- **`pdf_info`** — page count, page sizes in points, per-page font list with `baseFont`/`subtype`/`embedded`,
  and whether a page looks scanned (image-only, no text layer).
- **`pdf_extract_text`** — per-page text and markdown with display formulas rendered as LaTeX
  (`pages`, `mode`, `formulas`).
- **`pdf_extract_formulas`** — every detected formula with its LaTeX, page number, confidence and the
  low-confidence symbols it could not resolve (`pages`, `minConfidence`, `includeUncertain`, `format`).

Recognition does not rely on glyph names: subset CFF fonts carry obfuscated names and often no `/ToUnicode`
map, so glyph outlines are rasterised and matched by shape against templates built from system math fonts.
A second, two-dimensional pass finds fraction bars and radical rules and reassembles fractions, radicals,
scripts, big operators and matrices into LaTeX. Every decoded character carries a confidence and a source
(`tounicode`, `differences`, `standard-encoding`, `shape`); unresolved characters are reported per formula
instead of being guessed silently. Scanned PDFs without a text layer are not OCR'd, and unusual font faces
degrade to low confidence rather than a confident wrong answer. Every tool resolves to a plain
JSON-serialisable object and returns `{ ok: false, error }` instead of throwing.

Honest limits: an isolated symbol can still be confused with a near-identical shape (a radical was read as
`∨` in the sample paper); a long equation occasionally splits across two extracted formulas. The plugin
reports those cases through `confidence` and `uncertain` rather than hiding them. The plugin deliberately
exports no `Config`, because Cordis resolves plugin config through schemastery and a plain JSON-Schema
object makes activation fail; every setting is a tool argument with its own default.
