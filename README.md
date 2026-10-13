# 汤强 · 学术主页

基于 GitHub Pages 的中文学术主页，展示个人介绍、研究方向、教育与工作经历、科研项目、代表论文、完整论文、专利、奖项和学术服务。内容迁移自本人原有公开主页，后续可持续添加和修改。

- 主页：<https://tomtaylor1992911-lang.github.io/>
- 内容维护：<https://tomtaylor1992911-lang.github.io/admin.html>
- ORCID：<https://orcid.org/0000-0003-0360-5526>
- 论文代码：[Physica A 论文复现仓库](https://github.com/tomtaylor1992911-lang/physicaa-markov-accuracy-windows)

## 添加论文或更新项目

1. 打开[内容维护页](https://tomtaylor1992911-lang.github.io/admin.html)，选择“人工维护论文”或“科研项目”。
2. 点击“新增”，填写信息。已有记录点击标题即可展开修改，也可以删除不再展示的记录。
3. 添加论文时填写标题、作者、期刊、年份和 DOI；作者身份、代表作标记、分区及影响因子可按需要补充。DOI 可以直接粘贴 `https://doi.org/…` 链接。没有 DOI 时，可在“论文链接”填写预印本或成果页面的网址。
4. 更新项目时填写名称，选择“科研项目”或“开放代码”，补充简介及项目或代码链接。科研项目还可填写资助类别、编号、时间和经费，再填写“展示文字”；也可点击“用项目字段生成展示文字”。论文和项目链接可留空；填写时需使用完整的 `http://` 或 `https://` 网址。
5. 点击“复制发布 JSON”，再点击“打开 GitHub 编辑页”。在 GitHub 的 `data/site.json` 文件中全选并粘贴，点击 **Commit changes** 提交到 `main` 分支。
6. 等待仓库 Actions 中的部署任务完成，刷新公开主页查看结果。

表单编辑自动保存为**当前浏览器的本机草稿**。草稿不等于发布；必须提交到 GitHub，公开主页才会更新。可下载 `site.json` 备份，也可导入以前的文件继续编辑。更换电脑或清理浏览器数据会影响本机草稿，因此重要修改建议下载备份。

个人介绍在维护页中可直接修改。教育经历、研究方向列表、专利、奖项、学术服务等栏目，可在“完整 JSON”页签修改对应数组，点击“应用 JSON 到草稿”后再复制并提交。所有字段均使用与原主页一致的数据结构，编辑表单会保留未修改栏目和额外字段。

## ORCID 自动同步

ORCID 同步计划为**每日北京时间上午 10:23**。GitHub Actions 读取 ORCID 中公开可见的成果，写入独立的 `data/orcid.json`，随后自动部署主页。

- `data/site.json` 保存人工维护的个人资料、项目和论文；ORCID 同步不会修改该文件。
- `data/orcid.json` 保存 ORCID 自动抓取的公开成果。两份论文列表在主页合并，同一 DOI 只展示一次，人工数据优先。
- 作者身份、代表作、影响因子、中科院分区等通常不由 ORCID 提供，可在人工维护论文中添加相同 DOI 的记录补齐。
- 只从 ORCID 读取公开信息；主页修改不会反向写入 ORCID。私密或受限可见的 ORCID 成果不会自动出现。
- 科研项目继续由人工维护，不会被论文同步覆盖。
- 即使自动同步暂时失败，主页仍使用上一次成功同步的数据；可在 Actions 中查看原因并重试。

需要立即同步时，打开仓库 **Actions**，选择 ORCID 同步工作流，点击 **Run workflow**。同步成功并部署后，再刷新主页。

GitHub 的定时任务可能排队延迟；公开仓库连续 **60 天没有活动**时，定时工作流会被自动停用。可在 **Actions → 选择工作流 → Enable workflow** 重新启用，再手动运行一次。参见 [GitHub 定时工作流说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)和[启用工作流说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)。

## 部署与文件结构

提交到 `main` 后，由 GitHub Actions 自动部署到 GitHub Pages。仓库 **Settings → Pages → Build and deployment → Source** 使用 **GitHub Actions**。

| 文件 | 用途 |
| --- | --- |
| `index.html` | 学术主页 |
| `admin.html` | 浏览器内容维护页 |
| `assets/style.css`、`assets/app.js` | 主页样式和内容展示 |
| `assets/admin.js` | 草稿、数据校验、JSON 导入与导出 |
| `data/site.json` | 人工维护数据 |
| `data/orcid.json` | ORCID 公开成果同步数据 |
| `.github/workflows/` | 自动同步与部署工作流 |

这是一个静态站点。维护页无需配置服务器、数据库或 GitHub 访问令牌，最终发布操作在 GitHub 中完成；页面不处理或保存 GitHub 登录凭据。

如需本机预览，在仓库目录运行 `python -m http.server 8000`，再打开 `http://localhost:8000/`。请通过本地 HTTP 服务预览，以便页面能够读取 JSON 文件。
