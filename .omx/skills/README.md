# Project-bundled OMX skills

이 디렉터리는 AgentBoard 개발 중 실제로 사용한 Codex/OMX skill을 평가자가 확인할 수 있도록 함께 보관한다.

포함된 skill:

- `korean-git-commit` — 한글 기반 `[Type]` 커밋 메시지 작성·검증
- `sync-project-docs` — `AGENTS.md`와 `docs/` 최신화 및 문서 감사

## 사용 방법

Codex가 자동으로 skill로 인식하게 하려면 로컬 Codex skill 경로에 복사한다.

```bash
mkdir -p ~/.codex/skills
cp -R .omx/skills/korean-git-commit ~/.codex/skills/
cp -R .omx/skills/sync-project-docs ~/.codex/skills/
```

검증 script는 복사 없이 레포 안에서도 바로 실행할 수 있다.

```bash
python3 .omx/skills/korean-git-commit/scripts/validate_commit_message.py --text "[Feat] 첫 번째 커밋"
python3 .omx/skills/sync-project-docs/scripts/audit_project_docs.py .
```

## Git 관리 범위

과제 제출에서는 `.omx/` 전체를 AI-agent 사용 증거로 함께 포함한다.
이 `skills/` 디렉터리는 그중 재사용 가능한 workflow만 모아둔 위치다.
