# developstack/skills

**技能分发仓** —— 聚合上游开源技能，产出平台与 teamai 需要的两份产物。

> 定位：**只聚合，不创作**。我们不是技能作者，是分发者。

## 产物

| 路径 | 是什么 | 谁消费 |
|---|---|---|
| `skills/<slug>/SKILL.md` | 单技能目录 | 本仓（清单与 zip 的来源） |
| `.claude-plugin/marketplace.json` | 市场清单 | **平台**：`assets/market/registry.go` 拉它做技能市场索引 |
| `dist/<slug>.zip` | **单技能** zip（SKILL.md 在根） | **teamai**：`install_skill` 的 `download_url` |
| `LOCK.json` | 上游 repo / ref / commit / 路径 / sha256 / license | 审计与回滚 |

`skills/`、`dist/`、`.claude-plugin/`、`LOCK.json` **都是生成物**，由 `scripts/sync-skills.mjs` 产出，不要手改。

## 怎么改内容

**推荐**：在平台的「技能 → 技能市场 → 上游源」里加/删（平台会提交 `sources.yaml` 并触发聚合）。
`SKILLS_GITHUB_REPO` 指向本仓后，提交内容长这样（带"由平台生成"的头部注释）：

```yaml
sources:
  - repo: "https://github.com/anthropics/skills"
    ref: "main"
    namespace: "anthropic-skills"
```

**或者**直接改 `sources.yaml` 后本地跑（首次建仓、或不想配令牌时）：

```bash
npm install
npm run sync
```

```yaml
sources:
  - repo: https://github.com/anthropics/skills
    ref: main                      # 分支 / 标签
    namespace: anthropic-skills    # 安装后的归属分组（= 清单里的 plugins[].name）
    include: ["skills/**"]         # 可选：只收这些路径（缺省 = 全收；`*` 不跨 `/`，用 `**`）
    exclude: []                    # 可选：排除
```

自动同步：`.github/workflows/sync-skills.yml` 每天 03:17 UTC 跑一次，也支持手动 `workflow_dispatch`。

## 两条硬约束（改脚本前务必知道）

1. **slug 必须与平台一致**：平台 `assets/domain.NormalizeSlug`（小写、非字母数字折叠成 `-`、去首尾 `-`）。
   平台下发的 `download_url` 是 `{base}/{slug}.zip` —— slug 算错就 404。
2. **zip 必须是单技能包，且 `SKILL.md` 在根目录**：teamai 用 `unzip` 解包后
   `findSkillRoot` 只取**第一个** `SKILL.md`；塞整仓归档会装错技能。

## 平台侧怎么接

```
SKILLS_MARKET_SOURCES=developstack=https://raw.githubusercontent.com/developstack/skills/main/.claude-plugin/marketplace.json
SKILLS_DIST_BASE_URL=https://raw.githubusercontent.com/developstack/skills/main/dist
```

- `SKILLS_MARKET_SOURCES`：技能市场的源（平台管理员可在控制台增删）。
- `SKILLS_DIST_BASE_URL`：`install_skill` 下发 `{base}/{slug}.zip` 作为 `download_url`；
  留空则不下发（客户端会拒绝安装并报 `Missing download_url`）。

## 许可

上游技能按各自许可分发：`SKILL.md` 的 frontmatter `license` 字段与上游仓根的 `LICENSE`
会随技能一起保留（脚本自动拷贝，见 `LOCK.json` 的 `license`）。新增上游前请确认其许可允许再分发。
