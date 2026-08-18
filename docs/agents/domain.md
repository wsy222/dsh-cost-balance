# Domain Docs

工程类技能在探索代码库时如何消费本仓库的领域文档。

## 探索前阅读

- 仓库根目录的 **`CONTEXT.md`**，或
- 如果存在 **`CONTEXT-MAP.md`**，它指向每个 context 的 `CONTEXT.md`，阅读与主题相关的每个文件。
- **`docs/adr/`** — 阅读与你即将工作的区域相关的 ADR。在 multi-context 仓库中，同时检查 `src/<context>/docs/adr/` 的 context 级决策。

如果这些文件不存在，**静默继续**。不要标记缺失，也不要主动建议创建。`/domain-modeling` 技能（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 触达）会在术语或决策真正被解决时惰性创建它们。

## 文件结构

Single-context 仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context 仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context 级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表的词汇

当你的输出命名一个领域概念（issue 标题、重构提案、假设、测试名）时，使用 `CONTEXT.md` 中定义的术语。不要偏离词汇表明确避免的同义词。

如果所需概念不在词汇表中，这是一个信号——要么你在发明项目不使用的语言（重新考虑），要么确实存在缺口（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的输出与现有 ADR 冲突，显式提出而不是静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突——但值得重新讨论，因为…_
