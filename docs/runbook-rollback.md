# prod 롤백 Runbook

Slack `#taxi-deploy`에 prod 알림이 왔을 때 따라 하는 절차다. (CD 가이드 9단계)

## 먼저 알아 둘 것

- **자동 롤백이 일어났다면 사용자는 이미 이전 버전을 쓰고 있다.** 서비스는 정상이므로 서두르지 말고 순서대로 확인한다.
- 그런데 Git(`apps/taxi/overlays/prod/kustomization.yaml`)에는 아직 실패한 새 버전의 digest가 적혀 있다. 그래서 Argo CD 화면에는 `Degraded`가 계속 남는다. 고장이 아니라 **"사람이 아직 결정을 안 내렸다"는 표시**다.
- 결정은 **Git으로만** 한다. 되돌림 PR 또는 수정 PR을 머지하면 Argo CD가 반영한다.

> ⚠️ **되돌림 PR이 머지될 때까지 prod에 영향을 주는 다른 PR을 머지하지 않는다.**
> (`apps/taxi/overlays/prod/`, `apps/taxi/base/`)
>
> 롤백된 Rollout은 "실패한 버전으로 가려다 멈춘" 상태다. 이때 Pod 설정이 하나라도 바뀌면(ConfigMap 외 환경변수, 리소스, probe 등)
> Rollout은 **실패한 이미지 + 새 변경**을 새 버전으로 보고 Canary를 처음부터 다시 시작한다. 같은 지뢰를 자동으로 다시 밟는다.
> (kind 리허설에서 재현함 — P5-09 개발일지)

## 알림 종류

| 알림 | 뜻 | 할 일 |
| --- | --- | --- |
| 🔴 Degraded | Canary 판정 실패로 자동 롤백, 또는 장애 | [1. 확인](#1-무슨-일이-있었나-확인) → [2. 되돌림 PR](#2-되돌림-pr-기본) |
| 🟡 Suspended | 배포가 멈춰 사람의 결정을 기다림 | [배포가 멈췄을 때](#배포가-멈췄을-때-suspended) |
| 🟠 적용 실패 | Git 내용을 클러스터에 넣지 못함 (YAML 오류, 권한 등) | Argo CD 화면의 sync 오류 메시지 확인 → 수정 PR |
| 🟢 배포 완료 | 새 커밋이 적용되고 Healthy | 없음. 되돌림 PR 뒤라면 [3. 복구 확인](#3-복구-확인) |

## 1. 무슨 일이 있었나 확인

```bash
kubectl argo rollouts get rollout taxi -n taxi-prod
```

`Message:` 줄이 이유를 알려 준다.

| Message에 보이는 것 | 뜻 |
| --- | --- |
| `Metric "smoke" assessed Failed` | 트래픽을 넣기 전 Smoke Test 실패. **사용자 노출 0%** |
| `Metric "error-rate" assessed Failed` | 새 버전 에러율 1% 이상 |
| `Metric "latency-p95" assessed Failed` | 새 버전 p95가 500ms 초과 |
| `Metric "..." assessed Error` | Prometheus에 연결하지 못함 → [Prometheus 장애](#prometheus에-연결하지-못할-때-error) |

실제로 잰 값은 아래로 본다. (실패한 측정이 `[0.05]`처럼 보인다)

```bash
kubectl get analysisrun -n taxi-prod --sort-by=.metadata.creationTimestamp
kubectl get analysisrun <맨 아래 이름> -n taxi-prod -o jsonpath='{range .status.metricResults[*]}{.name}{"\t"}{.phase}{"\t"}{.measurements[*].value}{"\n"}{end}'
```

- 어떤 커밋이 문제였는지: Argo CD 화면 → `taxi-prod` → 상단의 Sync 커밋
- 앱 로그: 새 버전 Pod은 롤백 직후 정리되므로, 필요하면 모니터링 쪽 로그 수집에서 해당 시간대를 본다.

## 2. 되돌림 PR (기본)

문제가 된 digest 변경 PR을 되돌린다. 원인을 고치는 건 그다음이다.

```bash
git switch main && git pull
git log --oneline -- apps/taxi/overlays/prod/kustomization.yaml    # 문제가 된 커밋 찾기
git switch -c revert/<이슈번호>-prod-rollback
git revert <커밋>
git push -u origin HEAD
```

- PR 제목: `revert: prod <버전> 롤백` / 본문에 1번에서 본 Message와 측정값을 붙인다.
- prod 경로라 CODEOWNERS 승인이 필요하다. 사용자는 이미 이전 버전을 쓰고 있으니 급하게 승인을 재촉하지 않아도 된다.
- 머지 후 Argo CD가 약 3분 안에 반영한다. 기다리기 싫으면 Argo CD 화면에서 `taxi-prod` → Refresh.

Git이 이전 버전으로 돌아가면 Rollout은 **Canary 단계 없이 바로** 이전 버전으로 Healthy가 된다. (이미 떠 있는 stable과 같은 버전이라 다시 검사할 필요가 없음)

### 하지 말 것

| 하면 안 되는 것 | 이유 |
| --- | --- |
| `kubectl argo rollouts undo`, `kubectl set image`로 직접 되돌리기 | Argo CD selfHeal이 Git 값(실패한 버전)으로 다시 바꿔서 배포가 또 시작된다 |
| 되돌림 PR 머지 전 prod·base에 다른 PR 머지 | 실패한 버전으로 Canary가 처음부터 다시 시작된다 (위 경고) |
| `kubectl argo rollouts promote --full` | 판정을 전부 건너뛰고 100%로 보낸다. 고장 난 버전을 사용자 전원에게 내보낸다 |

## 3. 복구 확인

- [ ] Slack에 🟢 `taxi-prod 배포 완료 (Healthy)` 알림
- [ ] `kubectl argo rollouts get rollout taxi -n taxi-prod` → `Status: ✔ Healthy`, `Images:`에 이전 버전 하나만 `(stable)`
- [ ] Argo CD 화면에서 `taxi-prod`가 Synced / Healthy
- [ ] 이 시점부터 prod 머지 금지 해제. 팀 채널에 알린다

원인을 고친 버전은 일반 배포와 똑같이 CI가 새 digest PR을 만들고, Canary 판정을 다시 받는다.

## 특수 상황

### 배포가 멈췄을 때 (Suspended)

롤백도 승격도 하지 않고 기다리는 상태다. 새 버전이 일부(10~60%) 트래픽을 받고 있을 수 있다.

| 원인 | 확인 | 결정 |
| --- | --- | --- |
| **판정 불가**: 새 버전 요청이 1분에 200건 미만 | AnalysisRun 측정값이 `[-1]`. k6 Job이 실패했거나 Gateway까지 요청이 안 갔는지 `kubectl get job -n taxi-prod`, `kubectl logs job/<이름> -n taxi-prod` | 원인을 모르면 **abort**(롤백). 확신이 있을 때만 promote |
| **수동 승인 단계** (Rollout에 `pause: {}`가 있는 동안) | Message가 분석 결과가 아니라 단계 대기 | 지표·로그를 보고 promote 또는 abort |

```bash
kubectl argo rollouts abort taxi -n taxi-prod       # 중단 → 이전 버전으로. 이후는 2. 되돌림 PR
kubectl argo rollouts promote taxi -n taxi-prod     # 이 단계만 통과시키고 다음 단계로 (다음 단계는 다시 판정)
```

### Prometheus에 연결하지 못할 때 (Error)

판정에 쓸 지표가 없어 배포가 중단된다. 모니터링이 배포 경로의 의존성이라 생기는 **의도된 동작**이다.

1. 모니터링 담당에게 알린다. (mon-01 `192.168.56.41:9090` 상태)
2. Prometheus가 복구되면 같은 버전으로 판정을 다시 시작한다.
   ```bash
   kubectl argo rollouts retry rollout taxi -n taxi-prod
   ```
3. 복구가 오래 걸리면 abort 후 되돌림 PR.

### 알림이 오기 전에 이상을 발견했을 때

```bash
kubectl argo rollouts abort taxi -n taxi-prod
```

트래픽이 바로 이전 버전으로 돌아간다. 이후는 [2. 되돌림 PR](#2-되돌림-pr-기본)과 같다.

## 기록

롤백이 끝나면 아래를 장애 기록(또는 개발일지)에 남긴다.

```text
- 시각: 알림 수신 ~ 복구 확인
- 버전: 실패한 digest / 되돌린 digest
- 원인 지표: (Message, 측정값)
- 사용자 영향: 몇 % 단계에서 몇 분 (Smoke 실패면 0%)
- 되돌림 PR: #
- 후속 조치: 원인 수정 PR, 판정 기준 조정 여부
```
