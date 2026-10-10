# AGENTS.md

This public repository follows the MyEnglishWeb / 爱精读 governance rules.

完整治理文档在**私有仓库**，不在本仓库：

- `areonlee/MyEnglishWeb-governance`

How agents work comes from the private shared governance `areonlee/ai-project-governance` (`AI_ROUTING_POLICY.md` and `agents/`). This repository's task registry (`ACTIVE_TASKS.md`) is kept in the private `areonlee/MyEnglishWeb-governance` repository.

AI agents must read that private governance documentation before substantial work.

If you cannot access the private repository, stop and ask the owner for access before changing billing, points, referrals, VIP/plans, or production SQL.

## Safe rules (can be stated in public)

- GitHub is the formal Source of Truth. Chat history is reference only.
- `main` is the production / GitHub Pages release branch. Lee merges the pull request into `main`; merging the pull request is the release.
- All changes (features and fixes) go on an agent-prefixed branch (`didi/`, `chatgpt/`, `cursor/`, or `lee/` + `<task-id>-<slug>`) and a pull request that Lee merges.
- Do not mix unrelated fixes into one commit.
- Never discard uncommitted work without explicit owner approval.
- Never expose secrets, API keys, `service_role` keys, tokens, payment credentials, or private user data.
- Do not infer live production database state only from historical SQL files.
- A successful `git push` is not proof of production deployment. Verify Pages build, deployed HTML, and smoke tests.
- Product UI is Chinese unless a specific product requirement says otherwise. An English coding prompt is not permission to translate the UI.

Do not put passwords, production credentials, or private business runbooks into this public repository.
