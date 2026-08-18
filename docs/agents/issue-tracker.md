# Issue tracker: GitHub

本仓库的 issues 和 specs 以 GitHub Issues 形式存在。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论并同时获取 labels。
- **列出 issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` / `--state` 过滤。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

从 `git remote -v` 推断仓库；在 clone 内运行 `gh` 会自动使用当前仓库。

## Pull requests as a triage surface

**PRs as a request surface: no.**（如果本仓库把外部 PR 当作 feature request，改为 `yes`；`/triage` 会读取这个标志。）

设为 `yes` 时，PR 使用与 issues 相同的标签和状态，使用 `gh pr` 等价命令：

- **读取 PR**：`gh pr view <number> --comments` 和 `gh pr diff <number>`
- **列出外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的（去掉 `OWNER` / `MEMBER` / `COLLABORATOR`）
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`

GitHub 的 issue 和 PR 共享同一套编号空间，裸 `#42` 可能是二者之一——用 `gh pr view 42` 判断，失败再 `gh issue view 42`。

## 当 skill 说“发布到 issue tracker”

创建一个 GitHub issue。

## 当 skill 说“获取相关 ticket”

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个单独的 issue，**child** issues 是 ticket。

- **Map**：一个标记为 `wayfinder:map` 的 issue，保存 Notes / Decisions-so-far / Fog 正文。`gh issue create --label wayfinder:map`。
- **Child ticket**：作为 GitHub sub-issue 链接到 map（用 `gh api` 操作 sub-issues endpoint）。如果 sub-issues 不可用，把 child 加到 map 正文的 task list，并在 child 正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。被领取后，ticket 分配给执行的 dev。
- **Blocking**：使用 GitHub 原生 issue dependencies 作为 UI 可见的阻塞表示。添加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是 blocker 的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 或 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告（只含 open blockers）。如果 dependencies 不可用，退回到 child 正文顶部的 `Blocked by: #<n>, #<n>` 行。当所有 blocker 关闭时 ticket 解除阻塞。
- **Frontier query**：列出 map 的 open children（`gh issue list --state open`，限定 map 的 sub-issues / task list），去掉有 open blocker（`issue_dependencies_summary.blocked_by > 0` 或 `Blocked by` 行有 open issue）或有 assignee 的；按 map 顺序取第一个。
- **Claim**：`gh issue edit <n> --add-assignee @me` —— 本 session 的第一次写入。
- **Resolve**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把 context pointer（gist + link）追加到 map 的 Decisions-so-far。
