# Triage Labels

五个标准状态在此 repo 里的字符串映射：

| 角色（skill 内部名） | 本 repo 用法 | 含义 |
|---|---|---|
| `needs-triage`     | `待评估`      | 待你判断要不要做 |
| `needs-info`       | `需补充`      | 等报告人补细节 |
| `ready-for-agent`  | `可交给agent` | 描述够清楚,agent 拿过去就能干 |
| `ready-for-human`  | `需人工`      | 需要人来实施 |
| `wontfix`          | `不做`        | 关闭 |

在 `.scratch/<feature>/issues/<NN>-<slug>.md` 里状态写在文件顶部 `Status:` 一行,例如：

```markdown
Status: 待评估
```

要换字符串只改右列即可。
