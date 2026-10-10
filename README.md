# DevOps_GitOps

택시 배차 서비스 DevOps 프로젝트의 **배포 상태 저장소**.
클러스터에 무엇이 떠 있어야 하는지를 Kustomize로 적어 두면 **Argo CD**가 클러스터를 그 상태로 맞춘다.
배포 이력은 커밋으로 남고, 커밋을 되돌리면 롤백된다.

> 설계 기준: 노션 「프로젝트 아키텍처」 6장(CD 흐름)·10장(저장소와 브랜치).
> 문서는 DevOps_Docs의 [프로젝트 아키텍처](https://github.com/mobility-devops/DevOps_Docs/blob/main/architecture/project-architecture.md).

## 상태

설정은 전부 main에 있고 kind로 동작을 확인했다(P5-01~09). 실제 클러스터에 `argocd/root-app.yaml`을 등록해 플랫폼·DB SealedSecret·dev 앱·수집 에이전트까지 올렸다(10-10). 다음은 prod 첫 배포다. 진행 기준은 노션 「CD-guide [수정본]」.

| 영역 | 상태 |
|---|---|
| `apps/taxi/` (base, dev, prod Rollout·자동 판정 템플릿) | ✅ 작성. dev digest 지정·배포 확인, prod digest는 아직 자리표시(`sha256:000…`) |
| `argocd/` (root + 플랫폼 + 앱 2개, 알림 설정) | ✅ 작성, 실제 클러스터 등록 |
| `platform/` | MetalLB, Envoy Gateway, Sealed Secrets, Argo Rollouts, PriorityClass, Calico egress 정책, metrics-server·kubelet-csr-approver, 수집 에이전트(Alloy·kube-state-metrics, 모니터링 담당) ✅ / cert-manager 예정(선택) |
| `secrets/` | ✅ DB SealedSecret(dev·prod), 실제 클러스터의 열쇠로 잠금 |

클러스터 없이 아래 명령으로 결과를 확인할 수 있다.

```bash
kubectl kustomize apps/taxi/overlays/dev
kubectl kustomize apps/taxi/overlays/prod
```

## 폴더 구조

```text
.github/     CODEOWNERS (dev 폴더 외 전체를 DevOps Project Team 소유로)
argocd/      Application 정의 (App of Apps 루트 포함), Argo CD 설치 values
apps/taxi/
  base/      공통: ConfigMap, Deployment, Service, HTTPRoute, mysql Service + EndpointSlice
  overlays/
    dev/     namespace taxi-dev, 이미지 digest, dev DB 주소, dev 호스트 이름
    prod/    Rollout(Canary), canary Service, PDB, analysis/(자동 판정)
platform/    Gateway API, Envoy Gateway, cert-manager, MetalLB, metrics-server,
             PriorityClass, Calico 정책, 수집 에이전트(Alloy, kube-state-metrics)
secrets/     암호화된 SealedSecret만
```

### Jenkins(CI)가 바꾸는 곳

`apps/taxi/overlays/dev/kustomization.yaml`의 `images[0].digest` 한 줄만 바꾼다.

```bash
sed -i -E 's/(digest: )sha256:[0-9a-f]{64}/\1sha256:<push한 이미지의 digest>/' apps/taxi/overlays/dev/kustomization.yaml
```

`kustomize edit set image`는 쓰지 않는다. 파일 전체를 다시 써서 주석이 지워지고 순서가 바뀐다.

### 앱이 기대하는 것

- 이미지: `ghcr.io/mobility-devops/taxi-backend`, 8080 포트, non-root 실행
- Actuator: `/actuator/health/liveness`, `/actuator/health/readiness`, `/actuator/prometheus`
- Secret `taxi-db`(키 `DB_USERNAME`, `DB_PASSWORD`). 처음에는 손으로 만들고 이후 SealedSecret으로 바꾼다.
- DB는 클러스터 안의 `mysql` 이름(EndpointSlice → db-01 `192.168.56.31`)으로 접속한다.
- Gateway: `gateway` namespace의 `taxi-gateway`(아직 없음, 플랫폼 단계에서 만든다)

## 배포 흐름

| 환경 | 누가 바꾸나 | 반영 |
|---|---|---|
| dev (`apps/taxi/overlays/dev/`) | Jenkins가 이미지 digest를 바꾸는 PR을 만들고 자동 머지 | Argo CD가 바로 교체 |
| prod (`apps/taxi/overlays/prod/`) | Jenkins가 PR 생성 → 작성자가 아닌 팀원 1명이 승인·머지 | Argo Rollouts Canary(10% → 30% → 60% → 100%), 실패 시 자동 롤백 |

- Argo CD는 webhook 없이 기본 주기(약 3분)로 변경을 감지한다. 저장소가 public이라 별도 키 없이 읽는다.
- 처음에는 Calico와 Argo CD만 클러스터에 직접 설치하고, 루트 Application 하나를 등록하면 나머지가 설치된다.

## 규칙

- **이미지는 digest로 지정한다.** 태그(`dev-SHA`, `vX.Y.Z`)는 이름표로만 쓰고 `latest`는 쓰지 않는다.
- **비밀값은 SealedSecret으로만** 올린다. 평문 Secret을 커밋하지 않는다.
- `main` 하나. PR 필수, 강제 push 금지, Squash 머지.
- 승인은 0명이지만 `apps/taxi/overlays/dev/` 밖의 변경은 **CODEOWNERS(DevOps Project Team) 승인이 필수**다.
  base·platform 변경도 prod에 바로 반영되기 때문이다.
  ```text
  *                          @mobility-devops/devops-project-team
  /apps/taxi/overlays/dev/
  ```
- Canary 롤백 후에는 되돌림 PR(또는 수정 PR)이 머지될 때까지 prod 폴더에 다른 머지를 하지 않는다.

## 관련 저장소

| 저장소 | 역할 |
|---|---|
| [DevOps_Backend](https://github.com/mobility-devops/DevOps_Backend) | 앱 코드, Dockerfile, Jenkinsfile |
| **DevOps_GitOps** (이 저장소) | 배포 상태(Kustomize, Argo CD) |
| [DevOps_Infra](https://github.com/mobility-devops/DevOps_Infra) | VM(Vagrant)과 서버 설정 |
| [DevOps_Docs](https://github.com/mobility-devops/DevOps_Docs) | 설계·운영 문서, 회의 기록 |
